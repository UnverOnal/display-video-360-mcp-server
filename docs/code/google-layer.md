# Google layer

Covers `src/integrations/google/` (`auth.ts`, `errors.ts`, `request.ts`, `retry.ts`, `log.ts`) and the two API wrappers `bidmanager/errors.ts` and `dv360/errors.ts`. Every Google API call goes through this layer. The report file download (`report-file.ts`) does not: it is credential-free and never retried. Decisions: "Google's library for tokens only" and "Reliability" in [decisions.md](../decisions.md). Quotas and live error shapes: [api-reference.md](../api-reference.md).

## Credentials (`auth.ts`)

- **Division of work:** `google-auth-library` does ADC discovery, token caching, concurrent refresh, and the refresh-token exchange. We own only the quota-project header and safe errors. We use the library's `getRequestHeaders()` plus native `fetch`, not its request helpers: those use gaxios and can throw errors carrying the full request configuration (refresh token and client secret included).
- **Never remove the explicit `projectId`.** Measured on 11.3.3 (2026-11-05, macOS, off Google Cloud): `getClient()` took 2 ms with it and **16.8 s** without it, because the library otherwise runs project discovery on the first request of every process.
- **The quota header is set explicitly** (`x-goog-user-project` from config). `projectId` alone doesn't set it: in 11.3.3, `UserRefreshClient.fromJSON()` takes `quota_project_id` from the credential file (ours has none), then an environment override applies. The explicit header makes requests independent of that. It also needs `serviceusage.services.use` on the project (Service Usage Consumer role).
- **Scopes:** an `authorized_user` token keeps the scopes granted at login; the refresh request sends no scope. So passing fewer scopes doesn't narrow anything. One shared instance carries both scopes.
- **Cache rules:** a failed load is forgotten, so the next call loads again. `expired_or_revoked` drops the client, so a manual re-login works **without a restart**. Other header failures keep the client. Invalidation checks promise identity, so a late failure from an old client can't drop a newer one.
- **Classification:** `invalid_grant` (also inside a rewritten ReAuth message, as 11.3.3 does) → `expired_or_revoked`. The "Could not load the default credentials" / unreadable `GOOGLE_APPLICATION_CREDENTIALS` prefixes → `not_found`. Anything else → `unavailable`. The new error copies nothing from the original: no message, stack, config, response, or `cause`.
- **Credentials are fetched before the request is sent,** so `unavailable` means nothing reached Google. That's why the retry policy may retry it for every method.
- **The timeout signal can't interrupt credential work.** It reaches only the API fetch, and its clock starts before credentials are obtained.
- **Re-login** (with your Desktop OAuth client; the README has the full setup). With an External consent screen in Testing mode the login lasts about 7 days; Internal or In production lasts longer:

  ```sh
  gcloud auth application-default login --client-id-file=<path to the Desktop OAuth client JSON> --scopes=https://www.googleapis.com/auth/doubleclickbidmanager,https://www.googleapis.com/auth/display-video,https://www.googleapis.com/auth/cloud-platform
  ```

- **Live (2026-11-05):** an authorized `queries.list` returned 200. Token acquisition took ~275 ms, then ~0 ms cached. The first Bid Manager call took 7.7 s, later ones 1.1–1.9 s, so tool time budgets must allow a slow first call. A missing credential file gave `not_found` with the expected message. `expired_or_revoked` was seen live on 2026-11-06 (the login had lapsed): every call failed before any API request.
- **Known issue:** if a credential client ever returned no `authorization` header, the request goes out with an empty one and Google answers 401. Unreachable with the production `authorized_user` client. If it matters, throw `unavailable` instead.

## Error classification (`errors.ts`, shared and per API)

- **One classifier for both APIs** (`classifyGoogleHttpError`), so parsing, the 403 reason table, diagnostics caps, and message cleaning can't drift apart. Each API supplies its own subclass, message table, 429 kind, and which kinds may carry Google's text. The classifier never builds a base `GoogleApiError` (it's abstract): callers rely on `instanceof BidManagerError` / `Dv360Error`.
- **403 is decided by reason, in priority order** across both `ErrorInfo.reason` and legacy `errors[].reason`, checked on all reasons before the 5-entry diagnostics cap: `USER_PROJECT_DENIED`, `SERVICE_DISABLED`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `dailyLimitExceeded`, `userRateLimitExceeded`, else `access_denied`. **A 403 is never `unauthenticated`**; expired logins appear as `GoogleCredentialsError` or 401.
- **The two APIs differ on purpose:**
  - **429:** Bid Manager → `resource_exhausted`, never retried. It may be the unpublished reporting quota (only the message tells which, per Google's guide), and retrying wastes quota. DV360 → `rate_limited`: its quota is per minute.
  - **Google's message is shown** only for Bid Manager 400 and 429 and for DV360 400. Claude needs the exact 400 reason to fix a field combination. Never add it for 403, 404, or 5xx.
  - **DV360 `access_denied` names both causes,** because a non-existent partner or advertiser ID returns `403 PERMISSION_DENIED` with no reasons (live, 2026-11-12), indistinguishable from no access.
- **`retryable` on errors is informational only.** The request loop ignores it; `retry.ts` decides from kind, status, and idempotency. Bid Manager `server_error` on `queries.run` is `retryable: true` but never retried.
- **Diagnostics carry only:** HTTP status, Google `code`/`status`, reason/domain, and legacy reasons, at most 5 per list, 100 characters each. Never `ErrorInfo.metadata` (it can hold project numbers), the raw body, a URL, or a cause.
- **Live evidence:** Bid Manager missing query → `404 NOT_FOUND`, no reasons. Bid Manager bad page token → **`500 INTERNAL`**, no reasons (so a stale token looks like a server error). DV360 bad page token → `400`. DV360 missing line item under a valid advertiser → `404`. **No reason-bearing 403 has been seen yet**, so the reason names follow Google's general conventions. Anything unmatched lands safely in `access_denied`.
- **Adding a mapping** needs Google evidence plus tests for precedence and exact case. Recognising a new reason must not silently make it retryable.

## Request loop (`request.ts`) and policy (`retry.ts`)

- **What may be retried** (`failureClass`): unavailable credentials and `403 userRateLimitExceeded` always (nothing was done); a DV360 429 only with a `Retry-After` that fits the budget; `server_error`, `timeout`, and `network` only for idempotent methods; everything else never.
- **No blind repeat of work.** `queries.create` and `queries.run` are `rate_limit_only`: a timeout or 5xx there may mean Google already created the query or started the run, and repeating it duplicates work against shared quota. The reporting service checks instead (see [bidmanager-reporting](bidmanager-reporting.md)). Every new client method must declare its idempotency; one that creates or starts work is `rate_limit_only`.
- **A 429 without `Retry-After` is not retried:** DV360's quota is per minute, and a 1–2 s backoff would just fail again.
- **The deadline bounds retries, never a first attempt.** `get_report`'s last poll can start near the end of its 40 s budget; shortening it would turn "pending" into a timeout. A retry's attempt timeout is clipped to the budget left **after** the pacer wait (review fix M5S2C-01), and a retry needs at least 1 s left after its wait.
- **Policy:** 3 attempts, full-jitter backoff (caps 1 s, then 2 s; 8 s max), `Retry-After` as a floor. `Retry-After` accepts integer seconds or an IMF-fixdate only (`Date.parse` would accept strings like `"1.5"`), and values over an hour count as absent.
- **Bid Manager daily latch:** `403 dailyLimitExceeded` blocks every Bid Manager call without sending it until the next midnight Pacific (Google: the quota "refreshes at midnight PST", read 2026-11-12). Computed with `Intl` and offsets −7/−8 h, no date library; checked across both 2026 DST changes.
- **Bid Manager pacer:** requests start at least 250 ms apart per client (4 requests/s per project). Slots are reserved synchronously, so concurrent callers get distinct slots. A refused slot isn't released, which is harmless: the next caller just waits a little longer.
- **Cancellation:** the caller's signal (the MCP request's) aborts in-flight fetches and backoff waits. An abort caused by it is classified `network` but never retried, because the cancellation check runs first.
- **Cancellation reaches the call over stdio.** One server serves the connection, so a client's `notifications/cancelled` aborts the call's signal (`reliability.test.ts` A-10). A stateless HTTP transport, as a fork might add, does not have this property: there the cancel reaches a fresh per-request server and the call runs until its own budget ends (verified 2026-11-13, SDK 2.4.0).
- **The thrown error is the same object** as the last classified error (or the credentials error), so `instanceof` and `kind` checks keep working.
- **Signal identity:** without a call signal the fetch receives the timeout signal itself, not `AbortSignal.any([timeoutSignal])`. A DV360 test that mocks `AbortSignal.timeout` depends on this.
- **Purity:** `retry.ts` takes time, randomness, and sleep as parameters (boundary rule), so timing is deterministic in tests. Production defaults live only in `resolveRuntime`.

## Operational logging (`log.ts`)

One JSON line per event on stderr, shared by both clients and the tool runner. Decision: "Safe errors and logs" in [decisions.md](../decisions.md).

- **The logger serializes; it does not redact.** Producers build events only from fixed code labels, computed numbers, classified kinds, the random `callId`, and allowlisted codes. Never pass it an error, request, response, or diagnostics object. Only the logger's own timestamp, serialization, and write sit inside its catch boundary, so a broken stderr pipe or clock never breaks a call.
- **Never logged:** URLs, page tokens (ours or Google's), headers, bodies, tokens, signed links, any resource ID, tool arguments, names or titles, Google's message text, `ErrorInfo.domain`/`metadata`, error messages or stacks. Google text that the classifier lets into some 400 *tool results* still never enters a log.
- **External codes need fixed allowlists, not character patterns:** `privateTokenABC123` passes any identifier pattern. Statuses are the 17 `google.rpc.Code` names (else `OTHER`); reasons are the five the 403 table acts on (else `other`, de-duplicated, at most 5). Adding a classified reason means adding it to `LOGGED_REASONS` too; `log.test.ts` checks the two lists agree by reading the classifier's source table.
- **`google.request`** is emitted once per attempt that entered the authorized fetch, after its outcome and **before** that attempt's `latched`/`retry`/`give_up` events. Its duration starts after the pacer wait and includes credential work, so a credential failure produces a request line although no HTTP request reached Google. Nothing is emitted for a latch block, pacer refusal, or pre-attempt cancellation. HTTP status is present for responses (including ignored-body successes) and absent for credential, timeout, and network failures. `google.give_up` still means only that a *retryable* failure stopped being retried.
- **`callId`** is generated per tool call and travels in `CallOptions` through both services, cleanup, polls, the grouping fallback, the advertiser lookup, and the `queries.run` recovery lookup (which builds its own options). It is never sent to Google, rendered, or part of the page-token fingerprint. Omit the key when absent, never `callId: undefined`: existing tests compare options and events with strict equality.
- **File downloads bypass `request.ts`**, so they have no `google.request` line. A preview failure shows up as the `get_report` tool line's `kind` (see [startup-and-stdio](startup-and-stdio.md#tool-call-logging-toolscallts)).

# Bid Manager reporting

Covers `bidmanager/client.ts`, `titles.ts`, `cleanup.ts`, `reporting.ts`, and `tools/reports.ts`. The field catalog and the file reader have their own notes ([bidmanager-fields](bidmanager-fields.md), [bidmanager-report-file](bidmanager-report-file.md)). Decisions: "Reporting (Bid Manager)" and "Reliability" in [decisions.md](../decisions.md). Live API findings: [api-reference.md](../api-reference.md#bid-manager-api-v2).

## Client (`client.ts`)

- **Validation is deliberately minimal.** It checks only what routing and the service need: IDs, title, report state, the link type. Unknown Google fields are preserved through index signatures, because saved-query copies must carry fields we don't model.
- **IDs stay strings** (`^[0-9]{1,20}$`): int64 precision and no path injection.
- **`createQuery` refuses any title that isn't a valid `[MCP]` title**, so the server can only ever create queries that cleanup recognises.
- **`runQuery` never sends `synchronous`.**
- **One latch and one pacer per client** (see [google-layer](google-layer.md)), so production wiring can't forget them. Retries are on by default for the same reason.
- **`listReports`** exists only for the `queries.run` recovery and has no `pageToken`. Its `orderBy: 'key.reportId desc'` is documented by Google and **verified live 2026-11-13**: accepted, newest first (details in [api-reference](../api-reference.md)).
- **Live (2026-11-06):** create → run (`QUEUED`) → `DONE` in about a minute → delete → `getQuery` 404. `Query` has **no creation-time field**, which is why the title carries a timestamp. A report link still downloads after its query is deleted.

## Titles (`titles.ts`)

- **Format:** `[MCP] <description> <YYYY-MM-DDTHH:MM:SSZ>`. UTC so every instance agrees; whole seconds (milliseconds cut, not rounded) because the title shows in DV360. The description is cleaned and capped at 80 characters, because the title becomes the report's file name and Google documents no limit. Non-ASCII is kept (the team's titles are Turkish).
- **Parsing is strict:** exact case-sensitive prefix, non-empty description, and a timestamp that round-trips exactly (rejects `2026-02-30`, hour `24`).
- **Expiry is strictly more than 7 days.** Exactly 7 days is kept, and a future timestamp never expires.
- **Accepted risk:** a person could hand-name a query `[MCP] … <timestamp>` in DV360 and cleanup would delete it once old. Ownership is a naming convention, visible in the DV360 UI.
- **Changing the format** changes which existing queries cleanup recognises. Keep the parser accepting old titles.

## Cleanup (`cleanup.ts`)

- **Why a cursor:** always starting at page one could hide old `[MCP]` queries forever behind hundreds of team queries. The cursor lives in the instance (one per process) and survives between runs, not restarts.
- **Budgets per run:** at most 2 list pages of 100 (sorted by `queryId`) and 5 deletes, sequentially. A page whose candidates weren't all handled keeps the cursor, so the next run re-reads it; a fully handled page advances, even when the fifth delete finished it. The last page wraps to the start without re-reading page one in the same run.
- **Single attempt for every call**, never retried: cleanup is best effort and must not spend a tool call's budget. It still carries the tool call's signal.
- **Stale-token reset:** a listing that fails with `invalid_request` or `server_error` **while holding a saved token** resets the cursor. Reason: a bad token returns `500 INTERNAL` (live, 2026-11-06), indistinguishable from a transient error, and keeping it could block cleanup forever. Resetting at worst restarts traversal.
- **`not_found` on delete counts as done** (someone else deleted it). Any other delete failure stops the run at that page.
- **It never throws.** Failures become one of two fixed warnings that the start tools show. Concurrent runs on the same instance are skipped.
- **Production throttles cleanup to once per 30 minutes per process**, measured from the end of a warning-free run. Warned or deadline-cut runs do not start the interval, so a later report start can retry them. Throttled calls preserve the cursor. The factory defaults to no throttle for callers that do not configure it.
- **No cleanup request starts at or after the caller's deadline.** A cut returns deletions so far without a warning and retains any unfinished page. An in-flight request may still finish after the deadline; first attempts remain unshortened. This prevents a slow report start from adding an entire cleanup pass afterward.
- **Only `isExpiredMcpTitle` decides eligibility**: never ID, position, or prefix alone. Only this module deletes (boundary rule).
- **Known issues:** no guaranteed deletion time (7 days is the earliest). Google doesn't document page-token stability while deleting, so a pass may skip a query; a later wrap finds it. A query whose delete keeps failing blocks traversal at its page. Deleting a query also deletes its reports (Google's reference).

## Reporting service (`reporting.ts`)

**Starts**

- Ad hoc starts validate dates and fields locally first and return all problems together. Problems mean **zero Google requests**.
- Created queries: default format XLSX, `sendNotification: false`, `ONE_TIME`. Custom dates must be real calendar dates from year 2000. Future dates and span limits are left to Google. `ALL_TIME` is deliberately excluded.
- **Saved queries are never modified.** One runs in place only when its format matches the request and it wouldn't notify anyone (`sendNotification` not true and no non-empty `shareEmailAddress`). Otherwise a silent `[MCP]` copy runs: `Copy of <title>`, the original params including unknown fields, no sharing, no notifications, `ONE_TIME`. Saved queries skip catalog validation; they were built in DV360.
- A run failure after a successful create leaves the `[MCP]` query for retention cleanup. There is no compensating delete; the service has no delete capability.
- Cleanup runs once after each successful start, and its warnings are returned.
- Combined callers can cap an ad hoc start's retry/cleanup deadline; existing callers keep their original budget. The run-recovery lookup retains its independent single attempt and 10 s timeout, because a retry deadline cannot shorten that attempt.

**`queries.run` recovery** (create and run are never retried on ambiguous failures, see [google-layer](google-layer.md)):

- On a `timeout`, `network`, or `server_error` from `runQuery`, one `listReports` lookup runs (single attempt, 10 s timeout).
- **Fresh `[MCP]` query:** any report found is ours, and the run continues with a warning. None found → "starting again is safe". Lookup failed → "may still be running, wait before starting again".
- **Saved query run in place:** it has older reports, so only **exactly one** `QUEUED`/`RUNNING` report counts (newest first), with a warning that someone else may have started it. Anything else → "may still be running". It never claims "safe to start again" here, because an older finished report proves nothing about this run.

**Collect**

- Polls `getReport` with waits of 5, 10, and 20 s plus up to 1 s of jitter, at most 4 status requests, within a **40 s budget that includes request time**. A wait that wouldn't fit isn't started. So a pending call normally ends after two waits, about 20 s (live, 2026-11-11: 19–23 s), and the tool description says "about 20 seconds".
- Combined callers can shorten polling with `waitBudgetMs`; zero performs one status check without waiting. Its read-start allowance is five seconds beyond that polling budget, so a just-finished report can still be read. Existing `get_report` calls keep their original timing.
- When `DONE`, it reads the file. If the budget is already spent, it returns `deferred` ("call again") with no further API work. The grouping count comes from the report params; when they're absent, one `getQuery` fallback supplies them.
- **At most 2 file reads per process** at a time: XLSX parsing is memory-hungry (see the file note). A third returns `busy` with the link. There's no cache, so each page downloads and parses again.
- **File errors still return the link**, except invalid links and 400/401/403/404/410 downloads (likely expired). Those hide it.
- **Worst case per path** (the 45 s deadline bounds retries only, never first attempts): a DV360 read ~45 s; `get_report` ~70 s plus parsing, which isn't interruptible; `list_saved_reports` ~105 s. The former ~280 s ad hoc / ~310 s saved-copy start paths included up to seven cleanup requests after a slow start; the cleanup deadline guard now prevents those late requests. A-13 records a 58 s create/run sequence with cleanup skipped and the ticket preserved. **Claude Code (measured 2026-11-13):** results arrive inline up to at least 90 s; a call still running at 120 s is moved to the background and its result delivered later, not cancelled. A normal report start takes about 8 s. Other clients are unmeasured.
- Cancellation aborts API requests and waits, but **not file reads**.

**Saved list**

- At most 3 pages of 100, sorted by title. `[MCP]` queries are hidden by default.
- Only whole pages' matches are returned, up to 100. When a page would overflow, the token that *requested* it is returned, so continuation re-reads it and loses nothing.
- Search folds `İ`, `I`, `ı` to `i` before a locale-independent lowercase, for Turkish and English titles.

**Budgets:** each start and the list use a 45 s retry deadline; collect polls 40 s. Each is computed once at the method's start and passed with the signal to every client call and to cleanup.

## Reporting tools (`tools/reports.ts`)

- **Text only, one block, no `outputSchema`.** A client that forwards both text and `structuredContent` would otherwise show the preview twice. The preview's arrays are never rendered; only the reader's text is used.
- **The descriptions are the model's instructions.** They cover discovering codes with `list_report_fields`, not starting duplicate runs (shared quota), numeric IDs only (no name lookup yet), the coarsest grouping for totals, never adding across currencies, revenue vs media cost, never adding rates or reach, and always giving the link. Tests assert them exactly.
- **Rate wording is format-specific and verified** (live, 2026-11-11): CTR, completion rate, view rate, and % viewable are fractions in XLSX and percent strings in CSV. eCPM is a plain number in both, so it isn't claimed. REACH gets an explicit "no totals row" line, because Google doesn't total unique reach.
- **The file link is a bearer secret.** It is included on purpose, with a "share it like the file" warning. The ~4-month lifetime is Google behaviour the project relies on, not something we enforce.
- **Strict schemas:** unknown keys and numeric IDs are rejected by the SDK before the handler, so the service isn't called.
- The start tools are annotated destructive because cleanup can delete expired `[MCP]` queries. Saved team queries are never changed.
- `list_report_fields` keeps the catalog out of every `tools/list` response; it makes no Google call.

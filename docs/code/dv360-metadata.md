# DV360 metadata

Covers `dv360/client.ts`, `format.ts`, `names.ts`, `metadata.ts`, and `tools/metadata.ts`: read-only partners, advertisers, campaigns, insertion orders, and line items on DV360 API v4. Errors are in [google-layer](google-layer.md). Decisions: the two M4 entries in [decisions.md](../decisions.md). Live findings (statuses, sizes, units, paging, errors): [api-reference.md](../api-reference.md#display--video-360-api).

## Read-only guarantee

The shared account can write and the `display-video` scope permits writes, so **read-only is enforced in code**. The client sends GET only through `createGetJson`, and boundary rules forbid write-method literals anywhere under `dv360/`. Any new tool must be GET-only end to end and annotated read-only.

## Client (`client.ts`)

- **Filters are built only from validated digits and enum strings,** in a canonical order (statuses de-duplicated and sorted per resource, then `campaignId`, then `insertionOrderId`). The same arguments always give the same filter, which matters for page continuation. Arbitrary and display-name filters aren't exposed: Google rejects the substring operator `displayName:"…"` with 400 (live, 2026-11-12), and exact-name match alone isn't useful. Names are matched locally instead ([Name lookup](#name-lookup)).
- **Insertion orders allow `pageSize` up to 100**; the others up to 200 (Google's limits).
- **Output statuses are permissive** (any string, so new Google statuses don't break us). Input statuses are strict per resource.
- **`get` responses must echo the requested ID** (and advertiser, when present).
- **No latch or pacer.** DV360 quotas are per minute (1,500 per project, 300 per advertiser), and `daily_limit` is never retried.

## Formatting (`format.ts`)

- **Pure and total:** no I/O, clock, or crypto (boundary rule), and no function throws. Odd input renders as `?` or an omitted part. Every Google string passes through `clean`, `enumText`, `statusText`, or a fixed table, so Google never controls a newline, the `·` separator, or a row's length.
- **Rows are never truncated.** The first plan cut rows at 260 characters, but review found an ordinary line item row already reached 291, and a cut can separate an amount from its unit or drop a later field. Instead every input has a fixed maximum, and the worst case is **proven by running the formatters**: the longest row is 390 characters (a line item), under `MAX_ROW_CHARS = 400`. `format.test.ts` asserts the exact maxima per type, so a change that moves the bound fails visibly. Any change to a part's length means recomputing the bound and the tools' page budget.
- **Money:** int64 micros as strings of up to 18 digits, computed with `BigInt`, rounded half away from zero, always two decimals (also for zero-decimal currencies; the value is still right).
- **Impressions are counts, never money.** Under `BUDGET_UNIT_IMPRESSIONS`, an insertion order segment's `budgetAmountMicros` is a **plain count despite its name** (verified in the DV360 UI, 2026-11-12), and line item `maxAmount` is documented as a count.
- **Never shown:** an unlimited budget's `maxAmount` (Google ignores it); performance-goal amounts (money, a percentage, or a ratio depending on the goal type); campaign budget amounts (their impression unit is unverified).
- **Line item `FIXED` budget without `maxAmount`** (every YouTube & Partners Reach line item seen) prints `budget: no amount on the line item (see its insertion order)`. The live drill-down showed the word "fixed" misled readers.
- **Budget segments are chosen by date** (current, else next, else last), never by array position. Google doesn't order them and resolves their dates in the advertiser's time zone.
- **Closed enums** map through `Map` tables (prototype keys can't match). **Open enums** (line item type, goal types, YouTube bidding type) are cut instead, because their value lists change.
- **Known gaps:** dates are range-checked, not calendar-checked. The `performanceGoalAutoBid` and `demandGenBid` shapes follow Google's reference; neither was seen live.

## Metadata service (`metadata.ts`)

- **Page tokens are bound to their request.** Google accepts a token with a *different* filter and returns no error (live, 2026-11-12), which would silently skip or repeat entities. So Claude never sees Google's token. It gets `v1.<fingerprint>.<base64url token>`, where the fingerprint is the first 16 hex characters of SHA-256 over the normalized request (resource, parents, canonical statuses, page size). A mismatch is refused with "repeat exactly the arguments". This is a consistency check, not security.
- **A Google 400 on a call that carried a token** is reported as "no longer accepted, start again". Local guard errors and 400s without a token pass through unchanged.
- **Default statuses:** partners send an explicit "everything except archived". The others send no filter, because Google already hides archived campaigns, insertion orders, and line items, and advertisers can't be archived (confirmed live).
- **Advertiser lookup, in parallel** with the main call, for campaigns, insertion orders, and line items. Currency exists only on the advertiser, and 3 of 200 advertisers differed from their partner's (live), so the partner's currency is never used. The time zone gives "today" for segment choice. A failed lookup **degrades instead of failing**: rows still come back, amounts read `(advertiser currency)`, and a warning explains why. UTC is the fallback date.
- **Page size is capped at 40** so a page fits the tool's size limit (below).
- **Details JSON is never cut.** Over 12,000 characters it is omitted with its length; live records are 0.6–2.5 KB. Google's top-level `name` (a resource path repeating the IDs) is dropped.
- **Known issues:** an invalid request still starts the advertiser lookup (they run in parallel; the schemas normally prevent such requests). A call can take the full 30 s attempt timeout: one `get` did live, and an `insertionOrders` call timed out and succeeded on retry. Large advertisers need several 40-row pages (273 advertisers took 7 pages).

## Combined target description

`describeTarget` reads the advertiser once alongside an optional target instead of composing `get()` calls that would repeat the advertiser lookup. It validates IDs before starting either read. A target failure or an advertiser not-found/access-denied failure prevents reporting; other advertiser failures preserve the target summary without currency. This distinction lets STANDARD reports proceed while YOUTUBE and REACH require a readable advertiser partner. Summary formatting and advertiser-local segment dates reuse the metadata flow.

## Name lookup

`find()` in `metadata.ts`, with pure matching in `names.ts`; exposed as `find_entities`. Decision: "Name lookup done locally" in [decisions.md](../decisions.md).

- **Matching is local.** Google matches `displayName` exactly or not at all, and `:` returns `400`. So `find()` lists the scope with the largest page size and compares names itself.
- **Fold rule** (`foldName`): NFKC, then `İ`/`I`/`ı` → `i` **before** lowercasing (lowercasing `İ` alone gives `i` + U+0307), then any remaining `i` + U+0307 → `i`, which NFKC leaves alone (checked in Node, 2026-11-13). Accents are kept: `é` ≠ `e`. Ranking uses code-unit order, not `localeCompare`, so it doesn't depend on the host's ICU.
- **Statuses are checked first for every resource** (`checkStatuses`, shared with the client's filter builder). Advertiser statuses are applied locally to the cached directory, so the client's filter check alone would never see them.
- **Only the advertiser directory is cached** (per partner, 10 minutes, at most 50 partners). It's the only expensive part: one directory per visible partner. Partners and children are one or a few requests and stay uncached. **Sharing the cache across callers is safe** because every caller uses the process's one Google identity; **revisit** if a fork adds per-user Google credentials.
- **Directories are loaded without a status filter**, exactly as `list_advertisers` with no statuses, so local filtering gives the same rows.
- **Only complete directories are stored.** A directory cut by a page bound or the scan budget would hide advertisers for ten minutes. Completed directories stay stored even when the search as a whole is cut, so repeating a slow cold search continues where it stopped.
- **Denied partners are cached as denied** (same TTL) and reported as a note, not as an incomplete search: the account can see nothing there, and without the marker every search would ask again. Other failures aren't cached.
- **Expired directories are a miss.** If their reload fails, the partner counts as failed; the old entry isn't used.
- **Refresh on miss:** after matching, used directories older than 60 s that weren't loaded in this call are reloaded once, on zero matches (`refresh: 'zero_matches'`, the default and `find_entities`'s) or on no exact match (`'no_exact'`, for step 2's `get_performance`, which acts on a unique match and must not take a stale partial one). A failed or cut reload keeps the old entry and warns. This catches a just-created advertiser without reloading on every search.
- **Abort is recognised by the signal, never by the error:** `request.ts` reports a caller abort as an ordinary request error. After an abort no new work starts and the original error is rethrown, never counted as a failed partner.
- A combined caller may supply an earlier deadline; it caps both retries and the page-start scan budget. Passing a deadline does not shorten an in-flight first attempt, so the combined service also checks its stage mark before calling lookup or describe.
- **Bounds:** 3 partner directories at once per search, at most 50 partners (one partner page), 5 pages per child scope, 25 per directory. No page request starts after 25 s from the start of `find()`. A request started just before that can still run a full 30 s first attempt, so one `find()` can take about **55 s**.
- **`complete: false` means "may be missing matches"** (a cut scope, a failed or unstarted partner, more than 50 partners). The tool never renders it as "no match", and step 2 acts on a result only when it is complete.

## Metadata tools (`tools/metadata.ts`)

- **Same conventions as the report tools:** strict schemas, one text block, no `outputSchema`, safe errors.
- **Per-resource status enums** in each schema, so Claude can't send a status Google would reject for that resource.
- **One `get_metadata` tool** instead of five keeps the tool list short. Its `advertiserId` rule (required for child types, refused for partners and advertisers) is checked in the handler, because the schema can't express the dependency.
- **Size limits:** a list result is at most about 19,500 characters by construction (40 rows × 400, a wrapped token ≤ ~1,420, a few warnings), with a hard limit of 20,000. A detail result's hard limit is 16,700. An over-long result is refused **whole**, and **a refused list never contains a page token**, so a page can't be skipped silently.
- **The descriptions carry unit knowledge:** which `Micros` fields are money and which aren't, that impression budgets are counts, that planned spend doesn't cap spending, that archived entities are hidden unless asked for, and that IDs plug into the report filters (`FILTER_MEDIA_PLAN` is the campaign). Tests assert them exactly.

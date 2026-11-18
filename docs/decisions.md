# Technical decisions

The decisions that still shape the code, and why. Each entry is the current state; history is in git. Google API facts behind them are in [api-reference.md](api-reference.md); how the code applies them is in [architecture.md](architecture.md) and [`docs/code/`](code/README.md).

## Scope and safety

### Read-only towards DV360
The server never creates, changes, or deletes campaigns, insertion orders, line items, or saved reports. The only Google writes are creating and running its own `[MCP]` report queries and deleting them after 7 days. The `display-video` scope can write, so read-only is enforced in code: the DV360 client has only a GET request helper, and boundary tests forbid other HTTP method literals under `integrations/dv360/`.

**Why:** the server is meant for questions about campaigns, not for changing them, and a model with write access to ad spend is a large risk for little gain.

### OAuth user credentials, one Google identity per server
Both APIs are called as one DV360 user through OAuth user credentials (an `authorized_user` file from `gcloud auth application-default login`). One login carries both scopes, and one authorized fetch serves both APIs.

**Why:** DV360 access is granted to users; a service account often cannot be added to a DV360 partner. Everyone using one server process sees what that one account can see.

### Google's library for tokens only
`google-auth-library` only finds credentials and produces request headers; requests are plain `fetch`. `x-goog-user-project` is set on every request from the required `GOOGLE_CLOUD_QUOTA_PROJECT`, and the library gets the same value as `projectId`.

**Why:** no OAuth code of our own, and no library error objects (which can hold the refresh token) in our error paths. For `authorized_user` files the library takes the quota project from the file and ignores options, so the header must be explicit (verified in the 11.3.3 source). Setting `projectId` stops a slow project discovery (16.8 s without it, 2 ms with it). Requiring the setting avoids billing whatever project the machine's gcloud default happens to be.

### Safe errors and logs
Tool messages never contain Google's raw body, URLs, headers, tokens, or causes; Google's own message text is shown only for `400`s. Operational logs are stricter: fixed allowlists for statuses, reasons, and kinds, a random call ID, and no IDs, names, arguments, links, or messages.

**Why:** tool results reach a model and its transcript; logs end up in log files and log services.

## Transport and structure

### Local stdio server, remote add-ons in `src/remote/`
The server is a stdio process started by the MCP client. `runtime.ts` builds everything once and hands out servers; `index.ts` connects one to stdio. There is no HTTP transport or sign-in in this repository. A fork that wants to host the server remotely adds its HTTP transport, authorization, and deployment files under `src/remote/` (skipped by the boundary test) and wraps `createRuntime`.

**Why:** most people want the server on their own machine with their own Google login, which needs no hosting or sign-in. Keeping remote code out makes the core simple to read and change, and keeping it in new files lets a fork pull upstream changes without conflicts.

### Strict config parsing
`config.ts` is the only reader of the environment, is pure, and fails at startup on an invalid value.

**Why:** a wrong setting should stop the server with a clear message, not show up later as a confusing tool error.

### One text block per tool result
Results are one text block, with no `structuredContent` (except `health`).

**Why:** clients that forward both text and structured content would show the model every row twice.

## Reporting (Bid Manager)

### Start, then collect
`run_report` and `run_saved_report` return a ticket at once; `get_report` waits a bounded time (about 20 s) and either returns the result or says to call again. `get_performance` waits up to 20 s itself and returns a ticket otherwise.

**Why:** reports can take minutes to hours, and MCP clients cut off tool calls after an unknown, short time (calls of 19–25 s were accepted in testing).

### Labelled queries per request, 7-day cleanup
Every ad-hoc report is a new Bid Manager query titled `[MCP] <description> <UTC timestamp>`, run once, with no notifications. Cleanup deletes only `[MCP]` queries older than 7 days, at most once per 30 minutes per process, and never after a call's deadline. A saved report is run in place, unless its format differs or it would email people; then a silent `[MCP]` copy runs instead, so the saved report is never changed.

**Why:** queries need somewhere to live, the account's list must not fill up, and cleanup must never touch a query the server did not create.

### Google's own report file
The full result is Google's own file (XLSX by default, or CSV) behind its signed link, plus a paged preview read from that file. The download uses no credentials and only `https://storage.googleapis.com`.

**Why:** no storage of our own. The link is valid for about four months, and anyone with it can open the file, so it is treated as a secret in logs.

### A curated, live-verified field catalog
Only fields, filters, and combinations that reached `DONE` in a live report are offered, per report type (STANDARD, YOUTUBE, REACH). Validation runs locally before any Google call. The YOUTUBE set comes from a report built in the DV360 UI.

**Why:** Google does not document which fields each report type accepts and rejects bad combinations with a message that names no field. Each rejected report costs quota and confuses the user.

### Money is Revenue (advertiser currency)
Presets and descriptions report Revenue in the advertiser's currency, which is what the advertiser is billed. USD metrics are offered for adding up across currencies.

**Why:** it is the number account teams discuss with advertisers. Change the presets in `src/combined/presets.ts` if you need media cost instead.

### XLSX parsing with `read-excel-file`, with caps
XLSX downloads are capped at 3 MiB and CSV at 32 MiB, previews at 200 rows and 16,000 characters, and at most two files are parsed at once.

**Why:** the library holds the whole sheet in memory (about 100 MB per MB of file). The alternatives were unmaintained or had open advisories.

## Reliability

### Bounded retries that never duplicate work
At most 3 attempts with jittered backoff, inside a per-call budget (45 s by default, 40 s for report polling). `5xx`, timeouts, network errors, and rate limits are retried; `400`/`401`/`403` are not. `queries.create` and `queries.run` are never repeated after an ambiguous failure; a single lookup decides whether the report started.

**Why:** a blind retry of a report start can run the same report twice and use quota twice.

### Bid Manager quota guards
After `dailyLimitExceeded`, Bid Manager calls fail fast until midnight Pacific. Request starts are at least 250 ms apart.

**Why:** Bid Manager allows about 2,000 requests a day per project; once it is used up, every call fails anyway, and bursts trigger per-minute limits.

## Metadata (DV360)

### API v4, lossless pages, request-bound page tokens
DV360 API v4. One Google page per call, at most 40 rows, each with a proven length bound and no truncation. Page tokens are wrapped with a fingerprint of the request.

**Why:** v5 is a beta. A cut-off page would silently hide entities, and Google accepts a token from a different filter.

### Amounts in the advertiser's currency and time zone
Child entities are formatted with their advertiser's currency (one parallel `advertisers.get`), and budget segments are chosen by date in the advertiser's time zone.

**Why:** partner and advertiser currencies can differ, and "today" depends on the advertiser.

### Name lookup done locally
`find_entities` and `get_performance` list a scope and match names themselves (case-insensitive "contains", exact matches first, Turkish `İ`/`ı` folded to `i`). Advertisers can be searched across all visible partners, through a 10-minute in-process directory cache. An incomplete search never resolves a name.

**Why:** Google's name filter is exact-only. A partial search could miss an identically named entity.

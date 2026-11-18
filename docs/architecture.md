# Architecture and codebase guide

A local (stdio) MCP server for Google Display & Video 360: Node.js, TypeScript (ESM), and the official MCP TypeScript SDK. It exposes Bid Manager v2 performance reports and read-only DV360 v4 campaign metadata.

This is the entry point for working on the code: what each module owns, how requests flow, and the rules a change must keep. The code itself is the reference for signatures, messages, and exact values. Deeper notes sit in [`docs/code/`](code/README.md) and hold only what the code can't show: reasons, verified Google and SDK behaviour, and traps.

Related: [decisions.md](decisions.md) (why), [api-reference.md](api-reference.md) (Google API facts and live findings), [current-state.md](current-state.md) (status).

## Module map

| Module | Owns | Note |
|---|---|---|
| `src/index.ts` | The stdio entry point. Loads config, builds the stderr JSON logger and the runtime, serves one MCP server over stdio, handles signals. The only file that writes to the console or stderr. | [startup-and-stdio](code/startup-and-stdio.md) |
| `src/runtime.ts` | The only composition root. Builds one authorized fetch (both scopes), both clients, cleanup, the three services, and the tool runner **once per process**, and returns `createMcpServer()`. No I/O of its own. The seam a fork's own transport wraps. | [startup-and-stdio](code/startup-and-stdio.md) |
| `src/config.ts` | The only reader of `process.env`. Pure parsing of the required `GOOGLE_CLOUD_QUOTA_PROJECT` into a readonly `ServerConfig`. | [startup-and-stdio](code/startup-and-stdio.md) |
| `src/server.ts` | `createServer(deps)`: a new `McpServer` with all 14 tools registered. No transport logic. | [startup-and-stdio](code/startup-and-stdio.md) |
| `src/remote/` | Empty here. Reserved for a fork's deployment add-ons (HTTP transport, authorization); skipped by `boundaries.test.ts`. | — |
| `src/tools/call.ts` | Tool-call correlation, timing, and safe outcome logging without importing integration error classes. | [startup-and-stdio](code/startup-and-stdio.md#tool-call-logging-toolscallts) |
| `src/tools/health.ts` | `health` probe: no Google call. If it works and a Google tool fails, the problem is on Google's side. | — |
| `src/tools/reports.ts` | 5 reporting tools: strict schemas, descriptions, text rendering. | [bidmanager-reporting](code/bidmanager-reporting.md) |
| `src/tools/metadata.ts` | 7 read-only metadata tools (the five lists, `get_metadata`, `find_entities`): strict schemas, descriptions, text rendering, size limits. | [dv360-metadata](code/dv360-metadata.md) |
| `src/combined/presets.ts` | Pure preset report planning and filter assembly. | [combined-performance](code/combined-performance.md) |
| `src/combined/performance.ts` | Composes name lookup, target description, report start, and bounded collection with ticket-preserving failures. | [combined-performance](code/combined-performance.md) |
| `src/tools/performance.ts` | `get_performance`: strict schema, metadata header, reused reporting renderers, and response size guard. | [combined-performance](code/combined-performance.md) |
| `src/integrations/google/auth.ts` | Lazy ADC loading via `google-auth-library`, the explicit quota-project header, safe `GoogleCredentialsError`. | [google-layer](code/google-layer.md) |
| `src/integrations/google/errors.ts` | `GoogleApiError` base and the one HTTP error classifier both APIs use. | [google-layer](code/google-layer.md) |
| `src/integrations/google/request.ts` | The one request loop: per-attempt timeout, retries, deadline, cancellation, latch/pacer hooks, error mapping. `createGetJson` (GET only) and `createSendJson`. | [google-layer](code/google-layer.md) |
| `src/integrations/google/retry.ts` | Pure retry policy: failure classes, backoff, `Retry-After`, Pacific midnight, daily latch, pacer. | [google-layer](code/google-layer.md) |
| `src/integrations/google/log.ts` | Google log events, fixed status/reason allowlists, and the pure JSON logger with injected writer and clock. | [google-layer](code/google-layer.md) |
| `src/integrations/bidmanager/client.ts` | Typed Bid Manager v2 REST calls (7 methods), ID guards, response validation, `[MCP]`-only creation, one latch + pacer per client. | [bidmanager-reporting](code/bidmanager-reporting.md) |
| `src/integrations/bidmanager/errors.ts` | `BidManagerError` and its message table. | [google-layer](code/google-layer.md) |
| `src/integrations/bidmanager/titles.ts` | `[MCP] <description> <UTC timestamp>` titles and the 7-day expiry test. | [bidmanager-reporting](code/bidmanager-reporting.md) |
| `src/integrations/bidmanager/cleanup.ts` | Bounded, best-effort deletion of expired `[MCP]` queries, with a production throttle and a caller-deadline guard. The only caller of `deleteQuery`. | [bidmanager-reporting](code/bidmanager-reporting.md) |
| `src/integrations/bidmanager/fields.ts` | Live-verified field catalog for STANDARD, YOUTUBE, REACH and pure pre-flight validation. | [bidmanager-fields](code/bidmanager-fields.md) |
| `src/integrations/bidmanager/report-file.ts` | Credential-free download of Google's report file, XLSX/CSV parsing, totals/footer split, budgeted preview pages. | [bidmanager-report-file](code/bidmanager-report-file.md) |
| `src/integrations/bidmanager/reporting.ts` | The reporting service: start (validate, create, run, cleanup), collect (bounded wait, file read), saved-query listing, `queries.run` recovery. | [bidmanager-reporting](code/bidmanager-reporting.md) |
| `src/integrations/dv360/client.ts` | GET-only DV360 v4 reads (5 list, 5 get), guards, canonical filters, response validation. | [dv360-metadata](code/dv360-metadata.md) |
| `src/integrations/dv360/errors.ts` | `Dv360Error` and its message table. | [google-layer](code/google-layer.md) |
| `src/integrations/dv360/format.ts` | Pure, total formatting of names, enums, money, counts, budgets, and rows, with a proven 400-character row bound. | [dv360-metadata](code/dv360-metadata.md) |
| `src/integrations/dv360/names.ts` | Pure name folding (case, Turkish i forms, NFKC, whitespace), match kind, and ranking for name lookup. | [dv360-metadata](code/dv360-metadata.md#name-lookup) |
| `src/integrations/dv360/metadata.ts` | The metadata service: status defaults, request-bound page tokens, parallel advertiser lookup (currency, time zone), rows, details; `find()` name lookup with bounds, partner fan-out, and the per-process advertiser directory cache. | [dv360-metadata](code/dv360-metadata.md) |

## Dependency direction

```
index.ts ──► config.ts
   └──► runtime.ts ──► server.ts ──► tools/*  ──► integrations/bidmanager/{reporting, fields}
            │                                  ├─► integrations/dv360/metadata
            │                                  └─► combined/performance → reporting + metadata + presets
            │
            └──► builds once: google/auth → bidmanager/client + cleanup → reporting
                                          → dv360/client → metadata (+ names)

bidmanager/* ─┐
              ├──► google/{request, retry, log, errors} ──► google/auth
dv360/*     ──┘    (DV360 may use createGetJson only)
```

Lower modules never import higher ones. `server.ts` knows nothing about the transport; `tools/` knows nothing about `server.ts`; `integrations/` never imports the MCP SDK; `bidmanager/` and `dv360/` never import each other.

## Main flows

**Every MCP request.** The client starts the process and speaks JSON-RPC over stdin/stdout → `serveStdio` pins one `McpServer` from `runtime.createMcpServer()` for the connection → the SDK validates input against the tool's strict Zod schema → the handler calls a service with the parsed input plus `signal: ctx.mcpReq.signal` → it renders **one text block** (no `structuredContent`, no `outputSchema` except on `health`). Expected failures become `isError: true` with a safe message; handlers never throw. The runner wraps every handler, creates a random `callId` passed with the signal to its service, and emits one `tool.call` line on stderr; SDK rejections before a handler runs are outside this coverage.

**Report (start then collect).** `run_report` → `reporting.startAdHocReport`: validate dates and fields locally (problems → no Google call) → `createQuery` (`[MCP]` title, no notifications, `ONE_TIME`) → `runQuery` → `cleanup.run` → ticket. `get_report` → `reporting.collectReport`: poll `getReport` with waits of 5/10/20 s inside a 40 s budget → when `DONE`, `readReportFile` downloads Google's signed link → a preview page plus the link. `run_saved_report` runs a saved query in place, or through a silent `[MCP]` copy when the format differs or it would email people. Reports can take hours, so the start/collect split keeps every call under the client's time limit.

**Metadata.** `list_*` / `get_metadata` → `metadata.list/get` → for campaigns, insertion orders, and line items, the main call and `getAdvertiser` run in parallel (currency and time zone) → `format.ts` builds each row → page tokens are wrapped with a fingerprint of the request. `find_entities` → `metadata.find`: lists the scope locally (Google matches names exactly only), folds and ranks names with `names.ts`; advertisers without a partner fan out over every visible partner, three at a time, through a 10-minute directory cache, and no page request starts after 25 s.

**Combined performance.** `get_performance` → local preset/date validation → resolve supplied names top-down → describe advertiser and target → check parent consistency and partner requirements → start a report → collect while budget remains, otherwise return its ticket. `combined/` imports service interfaces and the field catalog, never clients; integrations never import it. Stage gates prevent late operations, while Google first attempts and file parsing can overrun their marks. [Combined performance](code/combined-performance.md) explains these constraints.

**Every Google call.** Client method → `request.ts` loop → `auth.ts` authorized fetch (token + `x-goog-user-project`) → one `fetch` per attempt. Failures become the API's own typed error. Retries follow `retry.ts`, never repeat `queries.create`/`queries.run` after an ambiguous failure, and are bounded by a per-call deadline (45 s for tools, 40 s for report polls) that never shortens a first attempt. Each attempt entering the authorized fetch emits one `google.request` outcome before any retry/latch decision event, correlated by the tool call's `callId`; its duration excludes the pacer wait.

## Rules a change must keep

Enforced by `src/boundaries.test.ts` (text checks, so code review still matters):

- `integrations/` never imports the MCP SDK. Tools never import Google clients or call `fetch`.
- Tools may import only `bidmanager/reporting.js`, `bidmanager/fields.js`, and `dv360/metadata.js` from `integrations/`. `server.ts` imports integrations and combined services as types only. Tools may also import `combined/performance.js` and `combined/presets.js`.
- Only `runtime.ts` calls the process-level factories (`createAuthorizedFetch`, `createBidManagerClient`, `createQueryCleanup`, `createReportingService`, `createDv360Client`, `createMetadataService`, `createPerformanceService`), and only `index.ts` calls `createRuntime`. `runtime.ts` reads no environment, writes no output, listens on nothing, and starts no timers. Only `config.ts` reads `process.env`. Nothing listens on a port.
- Only `cleanup.ts` deletes Bid Manager queries. Only `reporting.ts` creates or runs reports.
- `bidmanager/` and `dv360/` never import each other. `integrations/google/` imports neither.
- `combined/` imports only its own files and the reporting, metadata, and field-catalog service modules; no MCP SDK or direct fetch. `combined/presets.ts` remains pure and imports only field-catalog types. Integrations never import `combined/`.
- DV360 sends GET only: no `POST`/`PUT`/`PATCH`/`DELETE` literal under `dv360/`, and only `createGetJson` from `request.ts`. The account and scope can write, so this is the read-only guarantee.
- Bid Manager and DV360 code never calls `fetch(` directly (except `report-file.ts`, which is credential-free and must not reference the credential module). Only `report-file.ts` imports `read-excel-file`; `fflate` is test-only.
- `dv360/format.ts`, `dv360/names.ts`, and `google/retry.ts` stay pure: no `fetch`, clock, timers, crypto, or logging.
- `google/log.ts` stays pure: no fetch, ambient clock, timers, console, or process access. Its writer and clock are injected; constructing a date from that clock is allowed.
- **stdout is the protocol.** Nothing in `src/` writes to stdout (`console.log`/`info`/`debug`/`table`/`dir`/`trace`, `process.stdout`). Only `index.ts` may write to the console or stderr; lower layers emit events through the injected logger.
- Files under `src/remote/` are skipped by these checks; a fork's add-ons bring their own boundary test.

By convention and review:

- **No campaign writes**, and no change to saved team queries. The only Google writes are creating/running `[MCP]` queries and deleting expired ones.
- **Errors are safe by construction:** never a raw Google body, URL, header, token, cause, or `ErrorInfo.metadata` in an error, log event, or tool result. Google's own message text is shown only for 400s (and Bid Manager's 429).
- **Operational logs are stricter than tool messages:** no Google message text, error messages/stacks, URLs, tokens, account/resource IDs, names, arguments, headers, or bodies. External statuses, reasons, and kinds require fixed allowlists; a character pattern cannot prove they are safe. Only the randomly generated correlation ID is logged. Details and limits: [google-layer](code/google-layer.md#operational-logging-logts).
- **IDs are strings** matching `^[0-9]{1,20}$`, never numbers (int64 precision, no path or filter injection).
- **One text block per tool result**, so clients that forward both text and structured content can't duplicate rows.
- **Keep tool calls short.** Client time limits are unknown beyond about 25 s (Claude Code accepted pending `get_report` calls of 19–25 s). Long work uses start-then-collect.
- **Tool descriptions and layouts are contracts** with the model. Tests assert them exactly.
- Tools and Google integrations never receive caller credentials or use caller identity; every call runs as the server's one Google login.

## Runtime facts

| Item | Value | Consequence |
|---|---|---|
| Modules | ESM, `module: NodeNext` | Relative imports use `.js` in `.ts` source. |
| TypeScript | 7.x, `strict` | `readonly` arrays aren't assignable to mutable `string[]` parameters. |
| Node | Requires 24+ | Matches the tested development version and the container base image. |
| MCP SDK | `@modelcontextprotocol/server` and `/client` 2.4.0 | SDK behaviour in the notes was verified on these. Re-verify on upgrade. |
| Google auth | `google-auth-library` 11.3.3 | Its behaviour in the notes was verified by reading the source. Re-check on upgrade. |
| Build | `tsc -p tsconfig.build.json` → `dist/`, excluding tests | `dist/server.js` and `dist/index.js` read `../package.json` at runtime, so run from the repository (or ship `package.json` beside `dist/`). |

## Where to look when…

| Task | Start in |
|---|---|
| Adding a tool | `tools/health.ts` (pattern), then `server.ts` and `server.test.ts` (exact tool list). Steps in [startup-and-stdio](code/startup-and-stdio.md#adding-a-tool). |
| A Google call fails or retries oddly | `google/request.ts` and `retry.ts`; the API's `errors.ts` for the message. [google-layer](code/google-layer.md) |
| A report field is rejected or missing | `bidmanager/fields.ts`. Never add a field without a live `DONE` run. [bidmanager-fields](code/bidmanager-fields.md) |
| A report preview looks wrong | `bidmanager/report-file.ts`, then the renderer in `tools/reports.ts`. |
| A metadata row or amount looks wrong | `dv360/format.ts` (row bound test), then `metadata.ts`. |
| Changing presets, wording, or defaults | `combined/presets.ts`, the `DESCRIPTION` strings in `tools/*.ts` (asserted exactly in their tests), `bidmanager/titles.ts` (`[MCP]` prefix, 7-day expiry). See the README's "Customizing". |
| Startup, config, stdio errors | `config.ts`, `index.ts`, `runtime.ts`. |
| Hosting it remotely (in a fork) | `runtime.ts` (`createRuntime` / `createMcpServer`), then your own entry point under `src/remote/`. |
| Tests: how to run, conventions, gaps | [testing](code/testing.md) |

## Planned

Nothing planned in code. Open operational checks are listed in `current-state.md`.

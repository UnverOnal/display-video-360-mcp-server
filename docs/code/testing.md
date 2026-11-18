# Testing

## Running

```bash
npm test            # node --import tsx --test "src/**/*.test.ts"
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
```

- Built-in `node:test` with `node:assert/strict`, run from source through `tsx`. No framework, mocking library, or coverage tool.
- Node expands the quoted glob itself (needs a recent Node).
- Each `foo.test.ts` sits next to `foo.ts`.
- `index.test.ts` spawns the entry point as child processes (about 1 s in total). No test opens a network socket.
- 2026-11-18: 1,340 tests, 1,338 passed, 2 conditional skips, ~2 s. Both skips are in `fields.test.ts` and have no fixture in the verified catalog: distinct IDs rejected for a type without multi-ID support (every type has it), and a non-advertiser filter for YOUTUBE. A run that takes noticeably longer usually means an unclosed client or child process.

## Layers

The layers fail for different reasons, which tells you where to look. If `server.test.ts` passes and `index.test.ts` fails, the problem is in startup or the stdio wiring, not the tools.

| Layer | Files | How |
|---|---|---|
| Pure units | `log`, `tools/call`, `retry`, `format`, `fields`, `titles`, `config`, `runtime`, `health`, `combined/presets`, all `errors` | Plain inputs, no I/O |
| Integration units | Both `client`s, `auth`, `request`, `cleanup`, `reporting`, `metadata`, `report-file`, `combined/performance` | Injected fetch, loader, clock, sleep, random, logger (fake metadata/reporting services for combined performance). Synthetic `Response`s and fixtures. Never the network or real ADC. |
| Protocol in memory | `server.test.ts`, `tools/reports.test.ts`, `tools/metadata.test.ts`, `tools/performance.test.ts` | A real SDK `Client` over `InMemoryTransport`, fake services; performance rendering also has direct pure tests |
| Composition / redaction | `logging.test.ts` | Real Google clients, cleanup, both services, runner, JSON logger, and MCP server/client over `InMemoryTransport`; scripted authorized fetch, fake file reader, injected time. Checks the composed logging path without network or ADC. |
| Composition / reliability | `reliability.test.ts` | The same assembly, one test per reliability criterion (retries, budgets, `queries.run` recovery, latch, pacer, cleanup, cancellation, never-retried failures). |
| Composition / request counts | `request-counts.test.ts` | The same assembly with the real performance service; exact per-API request sequences, cache and cleanup behavior, polling timing, and zero-report-request refusal paths. |
| Process (stdio) | `index.test.ts` | `src/index.ts` as a child process: a real SDK client over `StdioClientTransport` (initialize, exact tool list, `health`, a Google tool failing without credentials, JSON log lines on stderr), plus exit on stdin close and signals with empty stdout, and a startup failure. Isolated `HOME` and a missing credentials file, so no real login is found. |
| Static rules | `boundaries.test.ts` | Text checks over non-test source; the rules are listed in [architecture.md](../architecture.md#rules-a-change-must-keep) |

## Conventions

| Rule | Why |
|---|---|
| Never read `process.env`; call `loadConfig({...})` with an explicit object (including a valid quota project). | Tests stay independent of the developer's shell. |
| Inject time, randomness, sleep, fetch, and credential loaders; never wait on real timers. | Retry and polling timing stays deterministic and fast. |
| Close every client (`t.after(() => client.close())`) and kill leftover child processes in `t.after`. | An open transport or a running child hangs the run. |
| Tests that wait on an event set `{ timeout: 5000 }`. | A regression fails instead of hanging. |
| Don't assert SDK-owned output: JSON Schema shape, SDK error text, timestamps (except with a fixed date). | Those change with the SDK. |
| `t.after` hooks run in registration order. | Register cleanup in the order it must run. |
| Assert complete Google event sequences, including each `google.request` before its attempt's latch/retry/give-up events. | Adding attempt logging must not weaken previous exact or positional checks to subset checks; calls without correlation must still omit the `callId` key entirely. |
| Process tests separate stderr lines starting with `{` from plain-text lifecycle lines, and assert stdout is empty outside the protocol. | Operational events can interleave with lifecycle output, and anything else on stdout breaks the protocol. A tool call must prove the production runner is wired; `listTools` emits no event. |
| Synthetic IDs, links, and data only; fake secret values to prove they don't leak. | No real account data in the repository. |
| Tool descriptions, layouts, and user-facing messages are asserted exactly. | They are contracts with the model; a change must be deliberate. |
| `fields.test.ts` membership snapshots are the live results. | Change them only with new live evidence. |

## Composition tests

All three composition files build on `composition-harness.test.ts` (helpers only, no tests; the `.test.ts` suffix keeps it out of `boundaries.test.ts`'s scan, which would flag the real factories it wires).

`logging.test.ts` assembles the real path: Google clients, cleanup, both services, the tool runner, the JSON logger, and the MCP server and client over `InMemoryTransport`, with a scripted authorized fetch, a fake file reader, and injected time. It guards what unit tests can't see: leakage and lost correlation hiding behind a fake service.

- **Markers** appear in URLs, bodies, names, page tokens, and error text, in two sorts: with punctuation, and letters/digits/underscore only (`privateTokenABC123`) in tempting code fields (status, reasons, kind), which a pattern-only sanitizer would accept. Raw, URI-encoded, and base64url forms are checked against every line, with distinctive numeric IDs. Known codes (`dailyLimitExceeded`, `NOT_FOUND`) must still appear, so dropping all diagnostics can't pass.
- It also checks the allowed key set per event type, one `tool.call` per invocation, distinct random IDs, and that every Google line carries its call's ID, including retries, cleanup, polling, and recovery.
- **Overlapping calls** with deferred responses finished in reverse order catch a shared mutable call ID, which sequential calls can't.
- **Real `ReportFileError` instances** are used because the service catches by `instanceof`: one link-keeping and one link-hiding failure.

`reliability.test.ts` uses the harness's extra controls:
- **Fake time throughout:** a scripted step can take time (`takes`), and each request records its start on the fake clock. With `mockTimeouts`, `AbortSignal.timeout` is mocked and records each attempt's timeout, so a clipped retry timeout is asserted exactly; a step slower than its timeout throws a `TimeoutError` at that timeout, as a real fetch would.
- **Held sleeps** block until the test releases them or their signal aborts, so a wait can be observed in progress, cancelled, or (for concurrent calls) kept from moving the shared clock early. The default instant sleep moves the clock at once, which makes concurrent calls look simultaneous.
- **Raw calls** (`start`) return the client promise plus a server-completion barrier (the call's `tool.call` line); concurrent calls are correlated by call ID, never by log position.
- **Characterization tests** (A-13) record today's behaviour that is known not to be ideal, with a comment saying so. Change them deliberately.

`request-counts.test.ts` exercises `get_performance` through the real performance service, so its request counts include the underlying lookup, reporting, and cleanup work.

- `cleanupMinIntervalMs` enables the production throttle when requested; the default remains unthrottled for existing composition cases.
- URL-aware `respond` selects responses for concurrent same-path directory requests without imposing partner issue order; other requests retain strict script order.
- `reads` records file-reader inputs, allowing the combined preview limit to be checked without downloading a file.

## Not covered by automated tests

| Gap | Covered instead by |
|---|---|
| A real MCP client (Claude Code, Claude Desktop) with a real Google login | Manual checks |
| Cancellation from a real client over stdio (Claude Code's Esc) | Not checked live; A-10 covers the in-session cancel offline |
| Real ADC discovery, token exchange, quota-project permissions, any live Google call | Manual live checks, recorded in `api-reference.md` |
| Protocol negotiation, unknown-argument stripping, other SDK internals | One-off spikes (SDK 2.4.0), see [startup-and-stdio](startup-and-stdio.md) |
| Google page-token stability while cleanup deletes | Accepted; best-effort cleanup |

## Adding tests

- A new module gets a `*.test.ts` next to it, following the conventions above.
- A new tool also updates `server.test.ts` (exact tool list) and the tool list in `index.test.ts`.
- A new boundary rule should be checked once against a deliberate violation before committing.

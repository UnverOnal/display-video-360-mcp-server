# Startup and stdio

Covers `src/index.ts`, `src/runtime.ts`, `src/config.ts`, `src/server.ts`, `src/tools/call.ts`, and `src/tools/health.ts`. Decisions behind them: "Local stdio server, remote add-ons in `src/remote/`" and "Strict config parsing" in [decisions.md](../decisions.md).

## Startup (`index.ts`, `runtime.ts`)

- **One of everything per process.** `createRuntime` builds the authorized fetch (both scopes, so one token serves both APIs), the clients, the cleanup instance, the three services and the tool runner once. Every server it hands out shares them. Building them per server would lose the token cache, the cleanup cursor, the Bid Manager latch and pacer, and the advertiser directory cache.
- **`createMcpServer()` returns a new server on every call.** stdio calls it once per connection. An HTTP transport in a fork can call it per request; that is the reason it is a factory.
- **`runtime.ts` has no I/O of its own:** no environment, console, timers, or listening (boundary test). The entry point chooses where logs go, so the same runtime serves a stdio or HTTP entry point.
- **No Google I/O at startup.** Factories are lazy, so the `health` tool works without a Google login and a missing login shows up as a tool error, not a crash. `GOOGLE_CLOUD_QUOTA_PROJECT` is still required at startup: it is validated before the transport starts.
- **stdout is the protocol.** Every diagnostic and JSON log line goes to stderr; one stray stdout line breaks the client's connection. Boundary tests forbid `console.log`/`info`/`debug` and `process.stdout` anywhere in `src/`. Operational events are JSON lines beginning with `{`; lifecycle lines (running, startup failure, stdio error) are plain text. Clients such as Claude Desktop keep stderr in their MCP log files.
- **`serveStdio`, not a hand-wired `StdioServerTransport`** (SDK 2.4.0): it picks the protocol era from the client's opening message and pins one server from the factory for the connection. Its `onerror` reports out-of-band errors; we print only the error class, since messages can quote client input.
- **Shutdown:** when the client closes stdin, the transport closes itself and the process exits naturally (no timers or sockets keep it alive). `SIGINT`/`SIGTERM` close the connection once. No `process.exit()`, so piped stderr drains. Verified by the stdio tests on Node 24 and SDK 2.4.0. Requests still running when stdin ends are aborted and not answered (SDK behaviour).
- **Cancellation works over stdio.** One server serves the connection, so a client's `notifications/cancelled` reaches the running call and aborts its Google work (reliability test A-10). A stateless HTTP transport does not have this property.
- **Startup errors** print the message without a stack, write nothing to stdout, and set exit code 1.

## Configuration (`config.ts`)

- **Pure and fail-fast.** It reads only the `env` object it gets, never logs or exits, and throws on an invalid value. It is the only reader of `process.env` in our code; `google-auth-library` still reads `GOOGLE_APPLICATION_CREDENTIALS` itself.
- **Quota project:** a project ID (`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`), not a number or a secret. Requiring it avoids silently using whatever quota project the machine's gcloud configuration picks.

## Server factory (`server.ts`)

- **Version source:** `package.json` imported with `with { type: 'json' }`. Not `npm_package_version` (missing under `node dist/index.js`) and not `readFileSync`. `../package.json` resolves from both `src/` and `dist/`, so the built output needs `package.json` beside `dist/`.
- **SDK behaviour (verified, SDK 2.4.0):** `initialize` answers protocol `2025-11-25`. An older supported version (`2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`) is echoed back. An unknown one gets `2025-11-25` and the client decides. Only the `tools` capability is advertised; the SDK's `listChanged: true` means nothing here, since the tool list is fixed.
- A throwing tool handler becomes a tool result with `isError: true` carrying the **raw** error message (SDK behaviour), so handlers must catch expected errors themselves.

## Tool-call logging (`tools/call.ts`)

The runner wraps every handler (including `health` and the local `list_report_fields`) and logs one `tool.call` line: tool name, random `callId`, outcome, duration. It lives in `tools/` and sees only the common result shape, so tools never import Google error classes. The result is returned unchanged. `createServer` takes the runner optionally; without one a fresh ID is made and nothing is logged, which keeps lightweight fixtures simple. The stdio smoke test in `index.test.ts` proves production wires it.

- **Record errors before rendering them:** call `call.failed(error)` in the handler's catch. The runner can't reconstruct an exception from text. A recorded failure or an `isError` result gives `outcome: 'error'`; an `isError` result with no recorded exception logs no class. A body that throws is logged and rethrown unchanged (the SDK then exposes the raw message, so handlers must keep catching expected errors).
- **Errors are described narrowly:** only a code-owned constructor name (identifier pattern, else `Object`) and a `kind` from the fixed `LOGGED_KINDS` list (unknown string → `other`, non-string → omitted). Never message, stack, cause, or diagnostics. Inspection can throw (getters, revoked proxies), so it falls back to `Object` rather than losing the result.
- **Preview failures are observable:** `collectReport` catches file errors and returns `done_no_preview`, so `get_report` calls `call.note(result.reason)`. The note supplies a kind without changing the outcome: a link-keeping failure (`too_large`, `timeout`, `busy`, `deferred`) is `ok`, a link-hiding one is `error`.
- **First recording wins,** and a `failed` kind beats a note. `LOGGED_KINDS` completeness against the integration error kinds is a compile-time check in `logging.test.ts`.
- **Not covered:** SDK schema rejections (they never reach a handler) and `listTools`.

## Adding a tool

1. Create `src/tools/<name>.ts` with a strict `z.object({...}).strict()` input schema and a registration function accepting dependencies and the optional shared runner. Keep rendering in pure, exported functions so tests can call them directly.
2. Google-backed tools call one service in `integrations/` (extend the tool-import allowlist in `boundaries.test.ts` only deliberately). Pass `ctx.mcpReq.signal` through as `signal` and the runner's `call.callId` as `callId` to every service request. Keep correlation out of schemas, display arguments, and page-token fingerprints.
3. Annotate truthfully: Google reads are `readOnlyHint: true, openWorldHint: true`. The report start tools are marked destructive because cleanup can delete expired `[MCP]` queries.
4. Wrap every handler in the runner using the exact registered tool name, including handlers with no service call. Return one text block. In the catch, call `call.failed(error)` before mapping the error to `isError: true` with a safe message; preserve existing result semantics. Use `call.note` only for an allowlisted non-thrown result kind that needs to be observed.
5. Register it in `server.ts`, pass new dependencies through `ServerDependencies` from `runtime.ts`, and update `server.test.ts` (it asserts the exact tool names and order) and the tool list in `index.test.ts`.

`health` uses `z.object({})` without `.strict()`, so unknown arguments are silently stripped (SDK behaviour, verified). It is the only tool with an `outputSchema` and `structuredContent`.

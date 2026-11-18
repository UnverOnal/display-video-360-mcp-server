# Code notes

The codebase guide is [`docs/architecture.md`](../architecture.md): module map, flows, boundary rules, and where to look. Start there.

These notes go deeper on one area each. They hold **only what the code can't tell you**:

- why something is built the way it is, and the alternatives rejected;
- behaviour verified against Google, the MCP SDK, or a library (with date or version);
- constraints a change must not break, and traps;
- known issues and what is still unverified.

They don't restate signatures, exports, message tables, defaults, or test case lists. Read those in the source and tests.

| Note | Covers |
|---|---|
| [startup-and-stdio.md](startup-and-stdio.md) | `index.ts`, `runtime.ts`, `config.ts`, `server.ts`, `tools/call.ts`, `tools/health.ts`, and adding a tool |
| [google-layer.md](google-layer.md) | `integrations/google/*` and both APIs' `errors.ts`: credentials, error classification, the request loop, retries |
| [bidmanager-reporting.md](bidmanager-reporting.md) | Bid Manager `client.ts`, `titles.ts`, `cleanup.ts`, `reporting.ts`, and `tools/reports.ts` |
| [bidmanager-fields.md](bidmanager-fields.md) | `bidmanager/fields.ts`: what the catalog's evidence is, and what isn't verified |
| [bidmanager-report-file.md](bidmanager-report-file.md) | `bidmanager/report-file.ts`: Google's file layout, size caps, the preview budget |
| [dv360-metadata.md](dv360-metadata.md) | DV360 `client.ts`, `format.ts`, `metadata.ts`, and `tools/metadata.ts` |
| [combined-performance.md](combined-performance.md) | Combined performance orchestration, stage gates, and ticket preservation |
| [testing.md](testing.md) | Running tests, suite layers, conventions, what isn't automated |

## Keeping them current

- **Update a note in the same change** when the knowledge in it changes: a module's role or a flow, a constraint, a verified external behaviour, a known issue, or a non-obvious decision. A change that only alters internals the code already shows needs no doc update.
- **New module:** add a row to the module map in `architecture.md`. Add a section to the matching note only if the module has knowledge worth recording. Add a new note only for a new area.
- **Removed module:** remove its row and any section about it.
- **Tests:** update `testing.md` only when layers, conventions, harnesses, or automated-test gaps change, not for new cases.
- **Accuracy:** mark verified behaviour with its date and version; mark the unverified as unverified. Link `decisions.md` for history instead of retelling it, and put Google API findings in `api-reference.md`. No line numbers.
- **No secrets:** no credentials, tokens, real account IDs, signed links, or customer data.


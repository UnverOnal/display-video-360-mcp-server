# src/integrations/

Shared Google credential loading and authorized requests live in `google/auth.ts`. It delegates ADC discovery and token refresh to `google-auth-library`, explicitly sets the configured quota project, and returns safe typed credential errors. The entry point wires it into the running server.

Bid Manager API v2 lives in `bidmanager/`: typed REST requests, safe error classification, `[MCP]` title helpers, and bounded cleanup. The client uses an authorized fetch from `google/auth.ts`; cleanup is the only caller allowed to delete queries. The reporting service wires these modules into the server.

Display & Video 360 API v4 lives in `dv360/`: GET-only typed reads for partners, advertisers, campaigns, insertion orders, and line items (`client.ts`), independent error classification (`errors.ts`), pure formatting with a proven row bound (`format.ts`), and the metadata service (`metadata.ts`: status defaults, request-bound page tokens, advertiser currency and time-zone lookup, rows, and details). It uses `google/auth.ts` and never imports `bidmanager/`; the entry point wires it into the server through the metadata service. See `docs/code/dv360-metadata.md`.

`bidmanager/fields.ts` provides the curated field catalog and pure pre-flight request validation, with no I/O. Its memberships are live-verified (M3 step 3); see `docs/code/bidmanager-fields.md`.

Rules (enforced by `src/boundaries.test.ts`):
- The DV360 and Bid Manager integrations never import each other; DV360 requests are GET-only.
- Nothing in this directory imports the MCP SDK (`@modelcontextprotocol/*`).
- Tools in `src/tools/` call functions exported from here; they never call Google directly.

See `docs/architecture.md` (boundary rule) and `docs/code/README.md`.

See `docs/code/google-layer.md` for the auth cache rules, errors, and operator login command.

`bidmanager/report-file.ts` downloads Google report files without credentials, parses XLSX/CSV, separates data, totals, and footer, and returns a page within a character budget.

`bidmanager/reporting.ts` orchestrates report starts, collection, and saved-query discovery for the MCP tool adapters, with process-level cleanup and preview concurrency limits.

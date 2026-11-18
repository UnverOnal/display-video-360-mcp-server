# Current state

- **Version 1.0.0 (2026-11-18):** local stdio server with 14 read-only tools (metadata, reporting, combined performance). Typecheck, build, and the offline suite pass.
- **Verified live:** the tools against real Google accounts; findings in [api-reference.md](api-reference.md).

## Known issues

- With an External OAuth consent screen in Testing mode, the Google login expires after 7 days and has to be repeated.
- `get_performance` has not yet been seen returning a pending ticket live (its reports always finished within the wait); the path is covered offline.
- Cancelling a call from Claude Code over stdio has not been checked live (covered offline).

## Next steps

- None planned. Ideas: an `npx` install path, per-preset configuration without code changes.

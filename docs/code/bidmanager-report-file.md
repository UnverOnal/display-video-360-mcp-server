# Report file reader

Covers `bidmanager/report-file.ts`: downloads Google's report file, parses XLSX or CSV, separates data, totals, and footer, and returns a preview page within a character budget. Files stay at Google; nothing is cached or written. Decisions: "Report file reader" and "the full file is Google's own `.xlsx`" in [decisions.md](../decisions.md). The verified file layout is in [api-reference.md](../api-reference.md#bid-manager-api-v2) (CSV layout, XLSX layout, rate formats, REACH).

## Download

- **No credentials.** Google's link is a V2-signed Cloud Storage URL (`GoogleAccessId`, `Expires`, `Signature`), so the module must not reference the credential module (boundary rule). It is the only Google-facing code allowed to call `fetch` directly, and it is never retried.
- **The link is a bearer secret:** anyone with it can download the report. Never log it or put it in errors.
- **Only** HTTPS `storage.googleapis.com`, no userinfo, no non-default port, no redirects.
- **Size caps:** 3 MiB for XLSX, 32 MiB for CSV, checked on `Content-Length` and again while streaming (the reader is cancelled once a cap is exceeded).
- **Why 3 MiB for XLSX:** parsing measured at about 100 MB of memory per MB of compressed XLSX (199 MB for 1.2 MB, 551 MB for 5 MB, 879 MB for 10 MB, measured 2026-11-11). That's also why the reporting service allows only 2 concurrent reads.
- **Live (2026-11-11):** a link with one signature character changed returns 403, reported as "the link may have expired". Download failures with 400/401/403/404/410 carry that hint.

## Parsing

- **XLSX via `read-excel-file`** (only this module may import it), so we don't maintain ZIP/XML code. Google's XLSX uses inline strings and raw numeric values. Numbers stay strings (`parseNumber: s => s`): values are returned exactly as in the file.
- **CSV:** strict UTF-8, BOM stripped, quoted newlines handled.
- **Layout (verified on two real exports and live runs, 2026-11-11):** header, data rows, an optional totals row, a blank row, then footer lines.
- **Totals:** only the **last** data-block row can be totals, and only if all its dimension cells are blank and the block has at least two rows. Google adds totals only then; a lone blank-dimension row stays data. Totals never count in `totalRows` or appear in a page. Empty totals cells (e.g. advertiser-currency amounts in a mixed-currency report) stay empty.
- **Footer:** `Report Time` and `Date Range` take the first occurrence; `Group By` lines append; `Filter by …` lines become label/value pairs; the missing-rows notice and the previous-month billing note become warnings; anything else becomes a note. Each string is capped at 300 characters and the footer at 3,000 in total, with one "Some footer lines were shortened." note. **Expect that note on most real reports:** `Filter by` values list every partner the account sees.
- **`read-excel-file` drops trailing empty rows,** so a trailing separator with no footer can vanish; the parser then notes "no footer".

## Preview budget

- **Strict invariant:** `text.length + (totalsText ? 1 + totalsText.length : 0) <= maxChars` (default 16,000). The cell cap is derived from the column count so the header, one row, and totals always fit. Below 8 characters per cell, the file is rejected as `too_many_columns`.
- **Why 16,000:** it keeps a `get_report` result under Claude Code's ~10,000-token tool-result warning (decision). Characters are not tokens, so this is an approximation. Claude Code showed an 18.6k-character page in full (live, 2026-11-11).
- The page stops at `limit` rows or the budget; `cutBy` says which. `nextOffset` exists only when rows remain. Shortened cells end in `…`.
- The tool layer must send either the text or the arrays, once, and account for its own text separately.

## Known issues

- Compressed byte caps don't guard against ZIP bombs. Accepted, because links come from our own account's API responses.
- Concurrent XLSX reads multiply memory, which is why the service limits them.
- The download timeout doesn't bound synchronous parsing.
- Real files were checked in LibreOffice Calc, not Microsoft Excel.
- **Verified real-world sizes:** a monthly report of 14,315 rows gave a first page of 128 rows (cut by budget) and parsed in 179 ms. Files above the cap: 16.5 MB and 38.5 MB returned the link and advice.

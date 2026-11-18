# Combined performance

Covers `combined/performance.ts`, `combined/presets.ts`, and `tools/performance.ts`. Decisions: "Start, then collect", "Money is Revenue (advertiser currency)", and "Name lookup done locally" in [decisions.md](../decisions.md). Live preset/filter evidence is in [api-reference](../api-reference.md).

The combined service depends on reporting and metadata services, preserving the independence of both Google integrations. Presets stay pure, so local refusals happen before any metadata or reporting request.

Description runs before every report start. This costs a metadata round trip but prevents wrong target IDs or inconsistent parents from consuming shared reporting quota. YOUTUBE and REACH also need the advertiser's partner. An incomplete name search never resolves, even with one exact match: an unsearched scope may contain another exact match. The caller can retry with an explicit ID.

Stage marks are relative to entry: resolution and describe start only before 45 s; report start only before 50 s; its retry/cleanup deadline is 65 s. The 90 s call budget chooses the remaining collection wait, capped at 20 s, reserving 15 s for reading. Less than five seconds of wait means the ticket returns immediately. A failed collect also preserves the ticket to prevent duplicate starts.

These are start gates, not hard end-to-end timeouts. Google retries are clipped to their deadline, but each separate first attempt can run 30 s. Run recovery has its independent 10 s attempt; download can take 20 s and parsing is not interruptible. Resolution can therefore end around 75 s with no report. A late report start can take around 120 s including recovery; collection can end around 100–105 s including download and parsing. Typical ID paths are approximately 30–38 s, cold advertiser lookup adds 12–20 s, and warm lookup adds 1–4 s. These are models from the plan, not new live measurements.

The fallback for unverified YouTube target filters requests advertiser-wide rows grouped at the target level and identifies the requested row. It deliberately leaves pagination and Google's original file intact instead of filtering server-side or using advertiser totals for one entity. All three target filters passed the 2026-11-16 probe, so today's configuration does not take this path; it remains tested for a restricted filter-level set.

Report titles include only preset and breakdown because titles appear in the account's report list. Start warnings are rendered once on every result path. Oversized previews lose their preview and totals text while retaining the ticket and download link.

REACH reports without a day, week, or month dimension are limited by Google to 93 days (verified live, 2026-11-17); `get_performance` does not clamp or pre-check the range. The tool description tells the caller, and Google's `invalid_request` fails at `queries.create` before anything runs.

# Bid Manager field catalog

Covers `bidmanager/fields.ts`: the curated dimensions, filters, and metrics per report type (STANDARD, YOUTUBE, REACH), and pure pre-flight validation. The catalog itself (codes, names, memberships, notes, rules) is the source; read it there. Decision: "A curated, live-verified field catalog" in [decisions.md](../decisions.md). Google's behaviour on bad fields: [api-reference.md](../api-reference.md#bid-manager-api-v2).

## Why a curated catalog

Google doesn't document which fields each report type accepts. It rejects bad combinations with a generic message that names no field (`The combination of dimensions, metrics, and filters in your report is invalid.`). So the catalog holds **only fields that reached `DONE` in a live run**, and validation catches mistakes before they cost quota. Combinations beyond single-field membership are still left to Google, whose 400 text reaches Claude.

## Evidence rules (keep them when changing the catalog)

- **Type membership** needs a `DONE` run with the full list for that type. Enum existence, accepted creation, or a passing unit test is not evidence.
- **Numeric-ID filtering** needs a `DONE` filtered run where every row matches. Grouping (`types`) and filtering (`filterTypes`) are verified separately, so they can differ: YOUTUBE filters by partner but partner grouping is unverified there.
- **Multi-ID filters** (several IDs of one code act as OR) need an alternatives run. Verified for all three types **with `FILTER_ADVERTISER` only**; other codes are assumed.
- **A failed or timed-out scope check keeps the cautious rule.**
- The unit tests' membership snapshots *are* the live results. Change them only with new live evidence.

## What the evidence is (three live checks, 2026-11-09)

- **STANDARD:** the full list reached `DONE` (about 2 min). No partner filter is needed.
- **REACH:** the full list reached `DONE`. Unfiltered creation was rejected with `You cannot select more than one Partner to report on.`, hence exactly one partner (`one_partner`).
- **YOUTUBE:** the same partner-scope rejection applied. Probing field by field failed (generic errors). The catalog is the field list of a report the user built in DV360's **Instant reporting** UI (Instant reports are Bid Manager queries; Offline reporting offers only Floodlight and Inventory Availability), re-run as an `[MCP]` copy to `DONE` (359 rows). The DV360 editor also greys out Revenue eCPA with YouTube Ad / YouTube Ad ID.
- **Required dimension:** advertiser-currency money metrics need `FILTER_ADVERTISER_CURRENCY` in all three types (`Advertiser Currency must be included as a dimension.`). This was tested per group (all such metrics together) and is **assumed for each metric** in the group.
- **Names follow Google's CSV headers** where they differ from the reference, e.g. `Revenue (Adv Currency)` and `YouTube: Revenue eCPV (USD)`.
- **The totals row** first broke the alternatives check: Google appends one to files with two or more data rows. Fixed in the probe; see [bidmanager-report-file](bidmanager-report-file.md).
- The probe scripts and logs are archived in `~/Desktop/dv360-plans-archive-2026-11-12.zip` (local only).

## Not verified (known gaps)

- **YOUTUBE has no Date/Week/Month, no partner grouping, and no device or country breakdowns**, because the reference report didn't include them. Adding them needs a new reference report or probe and a `DONE` run.
- **YOUTUBE campaign, insertion order, and line item filters** are verified (live, 2026-11-16 probe): each filtered report returned only the filtered entity, with views and revenue equal to its row in the unfiltered report (impressions within one run-to-run drift of at most a few). The earlier run on 2026-11-09 reached `DONE` with 0 rows and proved nothing; the probe's pass rule needed rows > 0. Test impressions to within a few, not exactly: Google's numbers drift between runs. Details in `api-reference.md`.
- Partner-currency metrics are left out on purpose: USD is the common currency for adding amounts across advertisers.

## Validation behaviour worth knowing

- Pure and typed. It is **not** a runtime validator for arbitrary JSON; the tool's Zod schema guards that first.
- It collects all problems in a fixed order (fields, then required dimensions, then filters, then scope), caps the list at 10 plus a "…and n more" line, and quotes and cuts received codes. Filter values are never echoed.
- It reports missing required dimensions but doesn't add them.
- Only valid partner filters count toward the one-partner scope; advertiser filters don't satisfy it.
- There's no limit on field or filter counts; the tool schemas bound them (27 dimensions, 35 metrics, 20 filters).
- Catalog data is deeply frozen, so one consumer can't change another's view.

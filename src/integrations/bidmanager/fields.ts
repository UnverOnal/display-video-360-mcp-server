export const REPORT_TYPES = Object.freeze(['STANDARD', 'YOUTUBE', 'REACH'] as const);
export type ReportType = (typeof REPORT_TYPES)[number];

export type DimensionEntry = {
  readonly code: `FILTER_${string}`;
  readonly name: string;
  readonly types: readonly ReportType[];
  readonly filterTypes: readonly ReportType[];
  readonly note?: string;
};

export type MetricEntry = {
  readonly code: `METRIC_${string}`;
  readonly name: string;
  readonly types: readonly ReportType[];
  readonly note?: string;
};

const STANDARD: readonly ReportType[] = Object.freeze(['STANDARD']);
const YOUTUBE: readonly ReportType[] = Object.freeze(['YOUTUBE']);
const REACH: readonly ReportType[] = Object.freeze(['REACH']);
const STANDARD_YOUTUBE: readonly ReportType[] = Object.freeze(['STANDARD', 'YOUTUBE']);
const STANDARD_REACH: readonly ReportType[] = Object.freeze(['STANDARD', 'REACH']);
const NO_TYPES: readonly ReportType[] = Object.freeze([]);

const REVENUE = 'Revenue billed to the client; not the same as media cost.';
const MEDIA_COST = 'What was paid for the media; not the same as revenue billed to the client.';
const RATE = 'A rate: recompute it from its counts; never add or average it across rows.';
const ADVERTISER_AMOUNT = "In each advertiser's currency: never add across currencies; group by Advertiser Currency or use the USD version.";
const ADVERTISER_RATE = "In each advertiser's currency; compare across currencies with the USD version.";
const USD_AMOUNT = 'In US dollars, so it can be added across currencies.';
const USD_RATE = 'In US dollars.';
const NON_ADDITIVE = 'Not additive: never add or average it across rows; run the report at the level you need instead.';

function dimension(
  code: DimensionEntry['code'], name: string, types: readonly ReportType[],
  filterTypes: readonly ReportType[] = NO_TYPES, note?: string,
): DimensionEntry {
  return Object.freeze({ code, name, types, filterTypes, ...(note === undefined ? {} : { note }) });
}

function metric(code: MetricEntry['code'], name: string, types: readonly ReportType[], ...notes: string[]): MetricEntry {
  return Object.freeze({ code, name, types, ...(notes.length ? { note: notes.join(' ') } : {}) });
}

// Live-verified memberships (step-3 live checks, 2026-11-09): every type's list reached DONE.
// YOUTUBE campaign, insertion order, and line item ID filters: M6 step 2 live probe, 2026-11-16 (filtered rows match the
// unfiltered reference at each level; see docs/code/bidmanager-fields.md).
// YOUTUBE is exactly the DV360-built reference report's field list (plan §7.8).
export const DIMENSIONS: readonly DimensionEntry[] = Object.freeze([
  dimension('FILTER_DATE', 'Date', STANDARD_REACH),
  dimension('FILTER_WEEK', 'Week', STANDARD_REACH),
  dimension('FILTER_MONTH', 'Month', STANDARD_REACH),
  // YOUTUBE filters by partner (verified) but grouping by partner was never verified there.
  dimension('FILTER_PARTNER', 'Partner ID', STANDARD_REACH, REPORT_TYPES),
  dimension('FILTER_PARTNER_NAME', 'Partner', STANDARD_REACH),
  dimension('FILTER_ADVERTISER', 'Advertiser ID', REPORT_TYPES, REPORT_TYPES),
  dimension('FILTER_ADVERTISER_NAME', 'Advertiser', REPORT_TYPES),
  dimension('FILTER_MEDIA_PLAN', 'Campaign ID', REPORT_TYPES, REPORT_TYPES),
  dimension('FILTER_MEDIA_PLAN_NAME', 'Campaign', REPORT_TYPES),
  dimension('FILTER_INSERTION_ORDER', 'Insertion Order ID', REPORT_TYPES, REPORT_TYPES),
  dimension('FILTER_INSERTION_ORDER_NAME', 'Insertion Order', REPORT_TYPES),
  dimension('FILTER_LINE_ITEM', 'Line Item ID', REPORT_TYPES, REPORT_TYPES),
  dimension('FILTER_LINE_ITEM_NAME', 'Line Item', REPORT_TYPES),
  dimension('FILTER_CREATIVE_ID', 'Creative ID', STANDARD),
  dimension('FILTER_CREATIVE', 'Creative', STANDARD),
  dimension('FILTER_TRUEVIEW_AD_GROUP_AD_ID', 'YouTube Ad ID', YOUTUBE),
  dimension('FILTER_TRUEVIEW_AD', 'YouTube Ad', YOUTUBE),
  dimension('FILTER_ADVERTISER_CURRENCY', 'Advertiser Currency', REPORT_TYPES, NO_TYPES,
    'Group by this before adding advertiser-currency money metrics.'),
  dimension('FILTER_PARTNER_CURRENCY', 'Partner Currency', STANDARD_REACH),
  dimension('FILTER_INVENTORY_SOURCE_ID', 'Inventory Source ID', STANDARD),
  dimension('FILTER_INVENTORY_SOURCE_EXTERNAL_ID', 'Inventory Source ID (external)', STANDARD),
  dimension('FILTER_INVENTORY_SOURCE_NAME', 'Inventory Source', STANDARD),
  dimension('FILTER_SITE_ID', 'App/URL ID', STANDARD),
  dimension('FILTER_APP_URL', 'App/URL', STANDARD),
  dimension('FILTER_EXCHANGE', 'Exchange', STANDARD),
  dimension('FILTER_DEVICE_TYPE', 'Device Type', STANDARD_REACH),
  dimension('FILTER_COUNTRY', 'Country', STANDARD_REACH),
]);

export const METRICS: readonly MetricEntry[] = Object.freeze([
  metric('METRIC_IMPRESSIONS', 'Impressions', REPORT_TYPES),
  metric('METRIC_CLICKS', 'Clicks', REPORT_TYPES),
  metric('METRIC_CTR', 'Click Rate (CTR)', REPORT_TYPES, RATE),
  metric('METRIC_REVENUE_ADVERTISER', 'Revenue (Adv Currency)', REPORT_TYPES, REVENUE, ADVERTISER_AMOUNT),
  metric('METRIC_REVENUE_USD', 'Revenue (USD)', REPORT_TYPES, REVENUE, USD_AMOUNT),
  metric('METRIC_MEDIA_COST_ADVERTISER', 'Media Cost (Advertiser Currency)', STANDARD_YOUTUBE, MEDIA_COST, ADVERTISER_AMOUNT),
  metric('METRIC_MEDIA_COST_USD', 'Media Cost (USD)', STANDARD_YOUTUBE, MEDIA_COST, USD_AMOUNT),
  metric('METRIC_TOTAL_MEDIA_COST_ADVERTISER', 'Total Media Cost (Advertiser Currency)', STANDARD_REACH, ADVERTISER_AMOUNT),
  metric('METRIC_TOTAL_MEDIA_COST_USD', 'Total Media Cost (USD)', STANDARD_REACH, USD_AMOUNT),
  metric('METRIC_REVENUE_ECPM_ADVERTISER', 'Revenue eCPM (Adv Currency)', STANDARD, RATE, ADVERTISER_RATE),
  metric('METRIC_REVENUE_ECPM_USD', 'Revenue eCPM (USD)', STANDARD, RATE, USD_RATE),
  metric('METRIC_REVENUE_ECPC_ADVERTISER', 'Revenue eCPC (Adv Currency)', STANDARD, RATE, ADVERTISER_RATE),
  metric('METRIC_REVENUE_ECPC_USD', 'Revenue eCPC (USD)', STANDARD_YOUTUBE, RATE, USD_RATE),
  metric('METRIC_REVENUE_ECPA_ADVERTISER', 'Revenue eCPA (Adv Currency)', STANDARD, RATE, ADVERTISER_RATE),
  metric('METRIC_REVENUE_ECPA_USD', 'Revenue eCPA (USD)', STANDARD, RATE, USD_RATE),
  metric('METRIC_REVENUE_VIEWABLE_ECPM_ADVERTISER', 'Revenue Viewable eCPM (Adv Currency)', STANDARD, RATE, ADVERTISER_RATE),
  metric('METRIC_REVENUE_VIEWABLE_ECPM_USD', 'Revenue Viewable eCPM (USD)', STANDARD, RATE, USD_RATE),
  metric('METRIC_TOTAL_CONVERSIONS', 'Total Conversions', STANDARD),
  metric('METRIC_LAST_IMPRESSIONS', 'Post-View Conversions', STANDARD),
  metric('METRIC_CM360_POST_VIEW_REVENUE', 'CM360 Post-View Revenue', STANDARD),
  metric('METRIC_RICH_MEDIA_VIDEO_PLAYS', 'Starts (Video)', STANDARD),
  metric('METRIC_RICH_MEDIA_VIDEO_FIRST_QUARTILE_COMPLETES', 'First-Quartile Views (Video)', STANDARD_YOUTUBE),
  metric('METRIC_RICH_MEDIA_VIDEO_MIDPOINTS', 'Midpoint Views (Video)', STANDARD_YOUTUBE),
  metric('METRIC_RICH_MEDIA_VIDEO_THIRD_QUARTILE_COMPLETES', 'Third-Quartile Views (Video)', STANDARD_YOUTUBE),
  metric('METRIC_RICH_MEDIA_VIDEO_COMPLETIONS', 'Complete Views (Video)', STANDARD_YOUTUBE),
  metric('METRIC_VIDEO_COMPLETION_RATE', 'Completion Rate (Video)', STANDARD_YOUTUBE, RATE),
  metric('METRIC_TRUEVIEW_VIEWS', 'TrueView: Views', YOUTUBE),
  metric('METRIC_TRUEVIEW_VIEW_RATE', 'TrueView: View Rate', YOUTUBE, RATE),
  metric('METRIC_TRUEVIEW_CPV_ADVERTISER', 'YouTube: Revenue eCPV (Adv Currency)', YOUTUBE, RATE, ADVERTISER_RATE),
  metric('METRIC_TRUEVIEW_CPV_USD', 'YouTube: Revenue eCPV (USD)', YOUTUBE, RATE, USD_RATE),
  metric('METRIC_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS', 'Active View: Viewable Impressions', STANDARD),
  metric('METRIC_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS', 'Active View: Measurable Impressions', STANDARD),
  metric('METRIC_ACTIVE_VIEW_PCT_VIEWABLE_IMPRESSIONS', 'Active View: % Viewable Impressions', STANDARD, RATE),
  metric('METRIC_UNIQUE_REACH_TOTAL_REACH', 'Unique Reach: Total Reach', REACH, NON_ADDITIVE),
  metric('METRIC_UNIQUE_REACH_AVERAGE_IMPRESSION_FREQUENCY', 'Unique Reach: Average Impression Frequency', REACH, NON_ADDITIVE),
]);

// Scope settings have live evidence from the first and second checks.
export type ScopeRule = 'none' | 'one_partner';
export const SCOPE_RULES: Readonly<Record<ReportType, ScopeRule>> = Object.freeze({
  STANDARD: 'none', YOUTUBE: 'one_partner', REACH: 'one_partner',
});
// Group-level live prerequisite evidence is conservatively applied to each metric.
export const REQUIRED_DIMENSIONS: Readonly<Record<ReportType, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  STANDARD: Object.freeze({
    METRIC_REVENUE_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_MEDIA_COST_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_TOTAL_MEDIA_COST_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_REVENUE_ECPM_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_REVENUE_ECPC_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_REVENUE_ECPA_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_REVENUE_VIEWABLE_ECPM_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
  }),
  YOUTUBE: Object.freeze({
    METRIC_REVENUE_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_MEDIA_COST_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_TRUEVIEW_CPV_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
  }),
  REACH: Object.freeze({
    METRIC_REVENUE_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
    METRIC_TOTAL_MEDIA_COST_ADVERTISER: Object.freeze(['FILTER_ADVERTISER_CURRENCY']),
  }),
});
// Verified with two advertiser IDs per type (third live check); assumed for the other filter codes.
export const MULTI_ID_FILTER_TYPES: readonly ReportType[] = Object.freeze(['STANDARD', 'YOUTUBE', 'REACH']);

export type ReportTypeCatalog = {
  readonly dimensions: readonly DimensionEntry[];
  readonly filters: readonly DimensionEntry[];
  readonly metrics: readonly MetricEntry[];
};

export function isReportType(value: string): value is ReportType {
  return REPORT_TYPES.some(type => type === value);
}

export function catalogFor(type: ReportType): ReportTypeCatalog {
  return {
    dimensions: Object.freeze(DIMENSIONS.filter(entry => entry.types.includes(type))),
    filters: Object.freeze(DIMENSIONS.filter(entry => entry.filterTypes.includes(type))),
    metrics: Object.freeze(METRICS.filter(entry => entry.types.includes(type))),
  };
}

export type FieldRequest = {
  readonly type: string;
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly filters?: readonly { readonly type: string; readonly value: string }[];
};

export type ValidatedParameters = {
  readonly type: ReportType;
  readonly groupBys: readonly string[];
  readonly filters: readonly { readonly type: string; readonly value: string }[];
  readonly metrics: readonly string[];
};

export type FieldValidation =
  | { readonly ok: true; readonly params: ValidatedParameters }
  | { readonly ok: false; readonly problems: readonly string[] };

const dimensionsByCode = new Map<string, DimensionEntry>(DIMENSIONS.map(entry => [entry.code, entry]));
const metricsByCode = new Map<string, MetricEntry>(METRICS.map(entry => [entry.code, entry]));
const filterCodes = DIMENSIONS.filter(entry => entry.filterTypes.length).map(entry => entry.code);

function quoted(value: string): string {
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
}

function alternatives(values: readonly string[]): string {
  if (values.length < 2) return values.join('');
  if (values.length === 2) return values.join(' or ');
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}

export function validateReportFields(request: FieldRequest): FieldValidation {
  const { type } = request;
  if (!isReportType(type)) {
    return { ok: false, problems: [`Unknown report type ${quoted(type)}. Use STANDARD, YOUTUBE, or REACH.`] };
  }
  const reportType: ReportType = type;

  const problems: string[] = [];
  if (!request.dimensions.length) problems.push('Add at least one dimension.');
  if (!request.metrics.length) problems.push('Add at least one metric.');

  function checkFields(codes: readonly string[], kind: 'Dimension' | 'Metric'): void {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    const entries = kind === 'Dimension' ? dimensionsByCode : metricsByCode;
    const otherEntries = kind === 'Dimension' ? metricsByCode : dimensionsByCode;
    const otherKind = kind === 'Dimension' ? 'metric' : 'dimension';
    for (const code of codes) {
      if (seen.has(code)) {
        if (!duplicates.has(code)) problems.push(`${kind} ${quoted(code)} is listed more than once.`);
        duplicates.add(code);
        continue;
      }
      seen.add(code);
      const entry = entries.get(code);
      if (otherEntries.has(code)) problems.push(`${quoted(code)} is a ${otherKind}, not a ${kind.toLowerCase()}.`);
      else if (!entry) problems.push(`Unknown ${kind.toLowerCase()} ${quoted(code)}.`);
      else if (!entry.types.includes(reportType)) {
        problems.push(`${kind} ${quoted(code)} is not available in ${type} reports. It is available in ${entry.types.join(', ')} reports.`);
      }
    }
  }

  checkFields(request.dimensions, 'Dimension');
  checkFields(request.metrics, 'Metric');

  const missingRequirements = new Map<string, string[]>();
  const validFields = [
    ...request.dimensions.filter(code => dimensionsByCode.get(code)?.types.includes(type)),
    ...request.metrics.filter(code => metricsByCode.get(code)?.types.includes(type)),
  ];
  for (const code of new Set(validFields)) {
    for (const required of REQUIRED_DIMENSIONS[type][code] ?? []) {
      if (request.dimensions.includes(required)) continue;
      const fields = missingRequirements.get(required) ?? [];
      fields.push(code);
      missingRequirements.set(required, fields);
    }
  }
  for (const [required, codes] of missingRequirements) {
    problems.push(`Add the dimension ${JSON.stringify(required)}: ${type} reports need it for ${codes.map(code => JSON.stringify(code)).join(', ')}.`);
  }

  const seenFilters = new Map<string, Set<string>>();
  const partnerValues = new Set<string>();
  for (const filter of request.filters ?? []) {
    const entry = dimensionsByCode.get(filter.type);
    const previousValues = seenFilters.get(filter.type) ?? new Set<string>();
    let problem: string | undefined;
    if (!entry) problem = `Unknown filter ${quoted(filter.type)}.`;
    else if (!entry.filterTypes.length) {
      problem = `Filtering by ${quoted(filter.type)} is not supported. Filter by ${alternatives(filterCodes)}.`;
    } else if (!entry.filterTypes.includes(type)) {
      problem = `Filter ${quoted(filter.type)} is not available in ${type} reports. It is available in ${entry.filterTypes.join(', ')} reports.`;
    } else if (!/^[0-9]{1,20}$/.test(filter.value)) problem = `Filter ${quoted(filter.type)} needs a numeric ID.`;
    else if (previousValues.has(filter.value)) problem = `Filter ${quoted(filter.type)} with the same ID is listed more than once.`;
    else if (previousValues.size && !MULTI_ID_FILTER_TYPES.includes(type)) {
      problem = `Filter ${quoted(filter.type)} can be used only once in ${type} reports.`;
    }
    if (problem !== undefined) problems.push(problem);
    else if (filter.type === 'FILTER_PARTNER') partnerValues.add(filter.value);
    previousValues.add(filter.value);
    seenFilters.set(filter.type, previousValues);
  }

  if (SCOPE_RULES[type] === 'one_partner' && partnerValues.size !== 1) {
    problems.push(`${type} reports need exactly one FILTER_PARTNER filter.`);
  }
  if (problems.length) {
    return { ok: false, problems: problems.length > 10
      ? [...problems.slice(0, 10), `…and ${problems.length - 10} more problems.`] : problems };
  }
  return {
    ok: true,
    params: {
      type,
      groupBys: [...request.dimensions],
      filters: (request.filters ?? []).map(({ type: filterType, value }) => ({ type: filterType, value })),
      metrics: [...request.metrics],
    },
  };
}

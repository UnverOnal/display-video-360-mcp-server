import type { ReportType } from '../integrations/bidmanager/fields.js';

export type TargetLevel = 'campaign' | 'insertionOrder' | 'lineItem';
type Level = 'advertiser' | TargetLevel;

function preset(type: ReportType, metrics: readonly string[]) {
  return Object.freeze({ type, metrics: Object.freeze(metrics) });
}

// Every preset ran DONE live for each breakdown kind it allows (M6 step 2 probe, 2026-11-16).
export const PRESETS = Object.freeze({
  delivery: preset('STANDARD', [
    'METRIC_IMPRESSIONS', 'METRIC_CLICKS', 'METRIC_CTR', 'METRIC_REVENUE_ADVERTISER',
    'METRIC_REVENUE_ECPM_ADVERTISER', 'METRIC_REVENUE_ECPC_ADVERTISER',
  ]),
  video: preset('STANDARD', [
    'METRIC_IMPRESSIONS', 'METRIC_RICH_MEDIA_VIDEO_PLAYS',
    'METRIC_RICH_MEDIA_VIDEO_FIRST_QUARTILE_COMPLETES', 'METRIC_RICH_MEDIA_VIDEO_MIDPOINTS',
    'METRIC_RICH_MEDIA_VIDEO_THIRD_QUARTILE_COMPLETES', 'METRIC_RICH_MEDIA_VIDEO_COMPLETIONS',
    'METRIC_VIDEO_COMPLETION_RATE', 'METRIC_REVENUE_ADVERTISER',
  ]),
  viewability: preset('STANDARD', [
    'METRIC_IMPRESSIONS', 'METRIC_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
    'METRIC_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS', 'METRIC_ACTIVE_VIEW_PCT_VIEWABLE_IMPRESSIONS',
    'METRIC_REVENUE_ADVERTISER', 'METRIC_REVENUE_VIEWABLE_ECPM_ADVERTISER',
  ]),
  conversions: preset('STANDARD', [
    'METRIC_IMPRESSIONS', 'METRIC_CLICKS', 'METRIC_TOTAL_CONVERSIONS', 'METRIC_LAST_IMPRESSIONS',
    'METRIC_REVENUE_ADVERTISER', 'METRIC_REVENUE_ECPA_ADVERTISER',
  ]),
  youtube: preset('YOUTUBE', [
    'METRIC_IMPRESSIONS', 'METRIC_TRUEVIEW_VIEWS', 'METRIC_TRUEVIEW_VIEW_RATE', 'METRIC_CLICKS',
    'METRIC_REVENUE_ADVERTISER', 'METRIC_TRUEVIEW_CPV_ADVERTISER',
  ]),
  reach: preset('REACH', [
    'METRIC_IMPRESSIONS', 'METRIC_UNIQUE_REACH_TOTAL_REACH',
    'METRIC_UNIQUE_REACH_AVERAGE_IMPRESSION_FREQUENCY', 'METRIC_REVENUE_ADVERTISER',
  ]),
});
export type PresetName = keyof typeof PRESETS;

export const BREAKDOWNS = Object.freeze([
  'total', 'day', 'week', 'month', 'campaign', 'insertion_order', 'line_item',
] as const);
export type BreakdownName = (typeof BREAKDOWNS)[number];

// Levels at which YOUTUBE reports filter by the entity's ID, verified live on 2026-11-16 (M6 step 2 probe).
// Keep in step with filterTypes in fields.ts (a test checks it).
export const YOUTUBE_FILTER_LEVELS: readonly TargetLevel[] = Object.freeze(['campaign', 'insertionOrder', 'lineItem']);

const LEVELS: readonly Level[] = ['advertiser', 'campaign', 'insertionOrder', 'lineItem'];
const LEVEL_LABELS: Record<Level, string> = {
  advertiser: 'advertiser', campaign: 'campaign', insertionOrder: 'insertion order', lineItem: 'line item',
};
const LEVEL_CODES: Record<Level, string> = {
  advertiser: 'FILTER_ADVERTISER', campaign: 'FILTER_MEDIA_PLAN',
  insertionOrder: 'FILTER_INSERTION_ORDER', lineItem: 'FILTER_LINE_ITEM',
};
const CHILD_LEVELS = {
  campaign: 'campaign', insertion_order: 'insertionOrder', line_item: 'lineItem',
} as const;
const TIME_DIMENSIONS = { day: 'FILTER_DATE', week: 'FILTER_WEEK', month: 'FILTER_MONTH' } as const;

export type ReportPlanInput = {
  readonly preset: PresetName;
  readonly breakdown: BreakdownName;
  readonly targetLevel: Level;
  readonly youtubeFilterLevels: readonly TargetLevel[];
};
export type ReportShape = {
  readonly type: ReportType;
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly targetFilter: boolean;
  readonly partnerFilter: boolean;
  readonly requestedRowLevel?: TargetLevel;
};

export function planReport(input: ReportPlanInput):
  { readonly ok: true; readonly shape: ReportShape } | { readonly ok: false; readonly problem: string } {
  const { preset: presetName, breakdown, targetLevel, youtubeFilterLevels } = input;
  const selected = PRESETS[presetName];
  const timeDimension = breakdown === 'day' || breakdown === 'week' || breakdown === 'month'
    ? TIME_DIMENSIONS[breakdown] : undefined;
  if (presetName === 'youtube' && timeDimension !== undefined) {
    return { ok: false, problem: "The youtube preset can't be split by day, week, or month: YouTube reports have no date dimensions. Use breakdown total or a level, or a STANDARD preset (delivery, video) for daily numbers." };
  }
  const childLevel = breakdown === 'campaign' || breakdown === 'insertion_order' || breakdown === 'line_item'
    ? CHILD_LEVELS[breakdown] : undefined;
  if (childLevel !== undefined && LEVELS.indexOf(childLevel) <= LEVELS.indexOf(targetLevel)) {
    return { ok: false, problem: `breakdown ${breakdown} must be a level below the ${LEVEL_LABELS[targetLevel]}.` };
  }
  const fallback = presetName === 'youtube' && targetLevel !== 'advertiser'
    && !youtubeFilterLevels.includes(targetLevel);
  if (fallback && breakdown !== 'total') {
    return { ok: false, problem: `YouTube reports can't be filtered to one ${LEVEL_LABELS[targetLevel]}, so the youtube preset can't break it down further. Use a STANDARD preset (delivery, video) for that breakdown.` };
  }
  const dimensionCode = LEVEL_CODES[childLevel ?? targetLevel];
  return { ok: true, shape: {
    type: selected.type,
    dimensions: Object.freeze([
      ...(timeDimension === undefined ? [] : [timeDimension]),
      dimensionCode, `${dimensionCode}_NAME`, 'FILTER_ADVERTISER_CURRENCY',
    ]),
    metrics: selected.metrics,
    targetFilter: targetLevel !== 'advertiser' && !fallback,
    partnerFilter: selected.type === 'YOUTUBE' || selected.type === 'REACH',
    ...(fallback ? { requestedRowLevel: targetLevel } : {}),
  } };
}

export function reportFilters(shape: ReportShape, ids: {
  readonly advertiserId: string;
  readonly targetId?: string;
  readonly targetLevel: Level;
  readonly partnerId?: string;
}): readonly { readonly type: string; readonly value: string }[] {
  if (shape.targetFilter && ids.targetId === undefined) throw new Error('reportFilters needs targetId for this report shape.');
  if (shape.partnerFilter && ids.partnerId === undefined) throw new Error('reportFilters needs partnerId for this report shape.');
  return [
    { type: 'FILTER_ADVERTISER', value: ids.advertiserId },
    ...(shape.targetFilter ? [{ type: LEVEL_CODES[ids.targetLevel], value: ids.targetId as string }] : []),
    ...(shape.partnerFilter ? [{ type: 'FILTER_PARTNER', value: ids.partnerId as string }] : []),
  ];
}

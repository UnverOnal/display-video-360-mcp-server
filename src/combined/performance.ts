import { safeErrorMessage as reportError, toDataRange, type DateRangeInput, type ReportFormat, type ReportingService, type StartedReport, type CollectResult } from '../integrations/bidmanager/reporting.js';
import type { ReportType } from '../integrations/bidmanager/fields.js';
import { safeErrorMessage as metadataError, type MetadataService, type TargetLevel, type MatchKind, type FindResult, type FindParents, type DescribedAdvertiser, type DescribedTarget } from '../integrations/dv360/metadata.js';
import { planReport, reportFilters, type PresetName, type BreakdownName } from './presets.js';

export const PERFORMANCE_BUDGET_MS = 90_000;
export const PREVIEW_ROWS = 50;
export type PerformanceRequest = {
  readonly advertiserId?: string; readonly advertiserName?: string;
  readonly campaignId?: string; readonly campaignName?: string;
  readonly insertionOrderId?: string; readonly insertionOrderName?: string;
  readonly lineItemId?: string; readonly lineItemName?: string;
  readonly preset?: PresetName;
  readonly breakdown?: BreakdownName;
  readonly dateRange?: DateRangeInput;
  readonly format?: ReportFormat;
  readonly signal?: AbortSignal;
  readonly callId?: string;
};
export type ResolvedLevel = {
  readonly level: 'advertiser' | TargetLevel;
  readonly id: string; readonly name?: string;
  readonly matched: 'id' | MatchKind;
};
export type PerformanceResult =
  | { readonly kind: 'invalid'; readonly problems: readonly string[] }
  | { readonly kind: 'unresolved'; readonly level: 'advertiser' | TargetLevel;
      readonly reason: 'none' | 'ambiguous' | 'incomplete'; readonly find: FindResult;
      readonly path: readonly ResolvedLevel[]; readonly parents: FindParents }
  | { readonly kind: 'not_started'; readonly path: readonly ResolvedLevel[]; readonly message: string }
  | { readonly kind: 'report'; readonly path: readonly ResolvedLevel[];
      readonly advertiser?: DescribedAdvertiser; readonly target?: DescribedTarget;
      readonly preset: PresetName; readonly breakdown: BreakdownName; readonly reportType: ReportType;
      readonly dateRange: { readonly text: string; readonly isDefault: boolean };
      readonly started: StartedReport; readonly collected?: CollectResult;
      readonly collectFailed?: true;   // the report started but checking it threw; the ticket is still returned
      readonly requestedRow?: { readonly level: TargetLevel; readonly id: string };
      readonly notes: readonly string[]; readonly warnings: readonly string[] };
export type PerformanceDependencies = {
  readonly metadata: Pick<MetadataService, 'find' | 'describeTarget'>;
  readonly reporting: Pick<ReportingService, 'startAdHocReport' | 'collectReport'>;
  readonly youtubeFilterLevels: readonly TargetLevel[];
  readonly now?: () => Date;
};
export type PerformanceService = { getPerformance(request: PerformanceRequest): Promise<PerformanceResult> };
export function safeErrorMessage(error: unknown): string {
  const message = reportError(error);
  return message === reportError(undefined) ? metadataError(error) : message;
}
const LEVELS = ['advertiser', 'campaign', 'insertionOrder', 'lineItem'] as const;
const LABELS = { advertiser: 'advertiser', campaign: 'campaign', insertionOrder: 'insertion order', lineItem: 'line item' };
const TOO_LONG = 'The name lookup took too long to start the report in this call. Call get_performance again: the lookup results are cached for 10 minutes, so it will be faster.';

export function createPerformanceService(dependencies: PerformanceDependencies): PerformanceService {
  const now = dependencies.now ?? (() => new Date());
  return { async getPerformance(request) {
    const entry = now().getTime();
    const R = entry + 45_000, S = entry + 50_000, SD = entry + 65_000, D = entry + PERFORMANCE_BUDGET_MS;
    const { preset = 'delivery', breakdown = 'total', signal, callId } = request;
    const dateRange = request.dateRange ?? { preset: 'LAST_7_DAYS' };
    const path: ResolvedLevel[] = [];
    const notStarted = (): PerformanceResult => ({ kind: 'not_started', path, message: TOO_LONG });
    const abort = () => { signal?.throwIfAborted(); };
    const problems: string[] = [];
    let targetLevel: typeof LEVELS[number] = 'advertiser';
    for (const level of LEVELS) {
      const id = request[`${level}Id`], name = request[`${level}Name`];
      if (id !== undefined || name !== undefined) targetLevel = level;
      if (id !== undefined && name !== undefined) problems.push(`Give either ${level}Id or ${level}Name, not both.`);
      if (id !== undefined && !/^[0-9]{1,20}$/.test(id)) problems.push('IDs must be numeric.');
      if (name !== undefined) {
        if (name.trim().length === 0) problems.push('name must not be empty.');
        if (name.trim().length > 200) problems.push('name must be at most 200 characters.');
      }
    }
    if (request.advertiserId === undefined && request.advertiserName === undefined) problems.push('Give the advertiser: advertiserId, or advertiserName to search for it.');
    const planned = planReport({ preset, breakdown, targetLevel, youtubeFilterLevels: dependencies.youtubeFilterLevels });
    if (!planned.ok) problems.push(planned.problem);
    const range = toDataRange(dateRange);
    if (!range.ok) problems.push(range.problem);
    if (problems.length || !planned.ok) return { kind: 'invalid', problems };
    const ids: Partial<Record<typeof LEVELS[number], string>> = {};
    for (const level of LEVELS) {
      const id = request[`${level}Id`], name = request[`${level}Name`];
      if (id === undefined && name === undefined) continue;
      if (id !== undefined) { ids[level] = id; path.push({ level, id, matched: 'id' }); continue; }
      if (now().getTime() >= R) return notStarted();
      const parents: FindParents = { resource: level,
        ...(level === 'advertiser' ? {} : { advertiserId: ids.advertiser }),
        ...(level === 'insertionOrder' || level === 'lineItem' ? { campaignId: ids.campaign } : {}),
        ...(level === 'lineItem' ? { insertionOrderId: ids.insertionOrder } : {}),
      };
      const found = await dependencies.metadata.find({ ...parents, name: name!.trim(), ...(level === 'advertiser' ? { refresh: 'no_exact' as const } : {}), deadline: R, signal, callId });
      abort();
      const match = found.exactMatches === 1 ? found.matches.find(item => item.kind === 'exact')
        : found.exactMatches === 0 && found.totalMatches === 1 ? found.matches[0] : undefined;
      if (!found.complete || match === undefined) return { kind: 'unresolved', level, find: found, parents, path,
        reason: !found.complete ? 'incomplete' : found.totalMatches === 0 ? 'none' : 'ambiguous' };
      ids[level] = match.id;
      path.push({ level, id: match.id, name: match.name, matched: match.kind });
    }
    if (now().getTime() >= R) return notStarted();
    const described = await dependencies.metadata.describeTarget({ advertiserId: ids.advertiser!,
      ...(targetLevel === 'advertiser' ? {} : { target: { resource: targetLevel, id: ids[targetLevel]! } }), deadline: R, signal, callId });
    abort();
    const { advertiser, target } = described;
    if (target !== undefined && target.resource !== 'campaign' && ids.campaign !== undefined && target.campaignId !== undefined && target.campaignId !== ids.campaign) {
      return { kind: 'invalid', problems: [`The ${LABELS[target.resource]} ${target.id} is not in campaign ${ids.campaign}.`] };
    }
    if (target?.resource === 'lineItem' && ids.insertionOrder !== undefined && target.insertionOrderId !== undefined && target.insertionOrderId !== ids.insertionOrder) {
      return { kind: 'invalid', problems: [`The line item ${target.id} is not in insertion order ${ids.insertionOrder}.`] };
    }
    const { shape } = planned;
    if (shape.partnerFilter && (advertiser === undefined || advertiser.partnerId === undefined)) {
      return { kind: 'invalid', problems: [`${shape.type === 'YOUTUBE' ? 'YouTube' : 'Reach'} reports need the advertiser's partner, ${advertiser === undefined
        ? `and the advertiser could not be read: ${described.advertiserProblem}` : "and Google's record of the advertiser has no partner."}`] };
    }
    const warnings = [...described.warnings];
    if (advertiser === undefined) warnings.push(`The advertiser's details could not be read (${described.advertiserProblem}); the report runs without them.`);
    for (let i = 0; i < path.length; i++) {
      const item = path[i];
      const detail = item.level === 'advertiser' ? advertiser : item.level === target?.resource ? target : undefined;
      if (detail) path[i] = { ...item, name: detail.name };
    }
    if (now().getTime() >= S) return notStarted();
    const start = await dependencies.reporting.startAdHocReport({ type: shape.type, dimensions: shape.dimensions, metrics: shape.metrics,
      filters: reportFilters(shape, { advertiserId: ids.advertiser!, targetId: ids[targetLevel], targetLevel, partnerId: advertiser?.partnerId }),
      dateRange, format: request.format ?? 'XLSX', name: `get_performance ${preset} ${breakdown}`, deadline: SD, signal, callId });
    if (!start.ok) return { kind: 'invalid', problems: start.problems };
    let collected: CollectResult | undefined;
    let collectFailed = false;
    const waitBudgetMs = Math.min(20_000, D - now().getTime() - 15_000);
    if (waitBudgetMs >= 5_000) {
      try { collected = await dependencies.reporting.collectReport({ ...start.report.ticket, limit: PREVIEW_ROWS, waitBudgetMs, signal, callId }); }
      catch (error) { collectFailed = true; warnings.push(`The report started, but checking it failed (${safeErrorMessage(error)}). Call get_report with the ticket.`); }
    }
    const notes: string[] = [];
    const requestedRow = shape.requestedRowLevel === undefined ? undefined : { level: shape.requestedRowLevel, id: ids[targetLevel]! };
    if (requestedRow) {
      const level = LABELS[requestedRow.level];
      notes.push(`This YouTube report lists every ${level} of the advertiser: Google can't filter YouTube reports to one ${level}. Answer with the row whose ${level[0].toUpperCase() + level.slice(1)} ID is ${requestedRow.id} only, and never use the totals row for it.`);
    }
    if (shape.type === 'STANDARD' && target?.lineItemType?.startsWith('LINE_ITEM_TYPE_YOUTUBE_AND_PARTNERS')) notes.push(collected?.status === 'done' && collected.page.totalRows === 0
      ? 'This is a YouTube line item and this report has no rows for it; try the youtube preset.' : 'This is a YouTube line item; the youtube preset gives its views and view rate.');
    if (shape.type === 'REACH' && breakdown !== 'total') notes.push("Unique reach and frequency can't be added up across these rows; for the total, run breakdown total.");
    return { kind: 'report', path, advertiser, target, preset, breakdown, reportType: shape.type,
      dateRange: { text: dateRange.preset ?? `${dateRange.startDate} to ${dateRange.endDate}`, isDefault: request.dateRange === undefined },
      started: start.report, collected, ...(collectFailed ? { collectFailed: true as const } : {}), requestedRow, notes, warnings };
  } };
}

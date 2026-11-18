import type { ResourceType } from './client.js';

export const MAX_NAME_CHARS = 80;
export const MAX_ENUM_CHARS = 40;
export const MAX_STATUS_CHARS = 24;
export const MAX_ROW_CHARS = 400;

export type SummaryContext = {
  readonly currency?: string;
  readonly today: string;
};

export type ChosenSegment = { readonly label: 'current' | 'next' | 'last'; readonly segment: unknown };

const ENUM_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;
const ID_PATTERN = /^[0-9]{1,20}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SEPARATOR = ' · ';

const BUDGET_UNIT_LABELS = new Map([
  ['BUDGET_UNIT_CURRENCY', 'in currency'],
  ['BUDGET_UNIT_IMPRESSIONS', 'in impressions'],
]);
const AUTOMATION_LABELS = new Map([
  ['INSERTION_ORDER_AUTOMATION_TYPE_NONE', 'manual'],
  ['INSERTION_ORDER_AUTOMATION_TYPE_BUDGET', 'automatic budget'],
  ['INSERTION_ORDER_AUTOMATION_TYPE_BID_BUDGET', 'automatic bid and budget'],
]);
const PACING_PERIOD_LABELS = new Map([
  ['PACING_PERIOD_DAILY', 'daily'],
  ['PACING_PERIOD_FLIGHT', 'flight'],
]);
const PACING_TYPE_LABELS = new Map([
  ['PACING_TYPE_AHEAD', 'ahead'],
  ['PACING_TYPE_ASAP', 'asap'],
  ['PACING_TYPE_EVEN', 'even'],
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);   // never leave half a surrogate pair
  return `${head}…`;
}

function label(table: ReadonlyMap<string, string>, value: unknown): string {
  return typeof value === 'string' ? table.get(value) ?? '?' : '?';
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function elementCount(count: number): string {
  return count > 999 ? '999+' : String(count);
}

export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '?';
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f·]/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? '(no name)' : cut(text, max);
}

export function enumText(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || !ENUM_PATTERN.test(value)) return '?';
  const text = value.length > prefix.length && value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return cut(text, MAX_ENUM_CHARS);
}

export function statusText(value: unknown): string {
  if (typeof value !== 'string' || !ENUM_PATTERN.test(value)) return '?';
  const prefix = 'ENTITY_STATUS_';
  const text = value.length > prefix.length && value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return cut(text, MAX_STATUS_CHARS);
}

export function formatDate(value: unknown): string {
  const date = record(value);
  const year = date?.year;
  const month = date?.month;
  const day = date?.day;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '?';
  if ((year as number) < 1 || (year as number) > 9999 || (month as number) < 1 || (month as number) > 12
    || (day as number) < 1 || (day as number) > 31) return '?';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatDateRange(value: unknown): string {
  const range = record(value);
  if (!range) return '?';
  const start = range.startDate === undefined || range.startDate === null ? '?' : formatDate(range.startDate);
  const end = range.endDate === undefined || range.endDate === null ? 'open' : formatDate(range.endDate);
  return `${start}–${end}`;
}

export function formatMoney(micros: unknown, currency: string | undefined): string {
  if (typeof micros !== 'string' || !/^-?[0-9]{1,18}$/.test(micros)) return '?';
  const negative = micros.startsWith('-');
  const absolute = BigInt(negative ? micros.slice(1) : micros);
  const hundredths = (absolute + 5000n) / 10000n;           // half away from zero
  const whole = groupDigits((hundredths / 100n).toString());
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  const sign = negative && hundredths !== 0n ? '-' : '';
  const suffix = currency !== undefined && CURRENCY_PATTERN.test(currency) ? currency : '(advertiser currency)';
  return `${sign}${whole}.${fraction} ${suffix}`;
}

export function formatCount(value: unknown): string {
  let digits: string | undefined;
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value)) digits = BigInt(value).toString();
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && String(value).length <= 15) digits = String(value);
  return digits === undefined ? '?' : groupDigits(digits);
}

type UsableSegment = { readonly segment: unknown; readonly start: string; readonly end: string; readonly index: number };

function usableSegments(segments: unknown): { usable: UsableSegment[]; unusable: { segment: unknown; index: number }[] } {
  const usable: UsableSegment[] = [];
  const unusable: { segment: unknown; index: number }[] = [];
  if (!Array.isArray(segments)) return { usable, unusable };
  segments.forEach((segment: unknown, index) => {
    const range = record(record(segment)?.dateRange);
    const start = formatDate(range?.startDate);
    const end = formatDate(range?.endDate);
    if (start !== '?' && end !== '?' && start <= end) usable.push({ segment, start, end, index });
    else unusable.push({ segment, index });
  });
  return { usable, unusable };
}

function best(candidates: UsableSegment[], better: (a: UsableSegment, b: UsableSegment) => boolean): UsableSegment | undefined {
  let chosen: UsableSegment | undefined;
  for (const candidate of candidates) if (!chosen || better(candidate, chosen)) chosen = candidate;
  return chosen;
}

export function chooseSegment(segments: unknown, today: string): ChosenSegment | undefined {
  const { usable } = usableSegments(segments);   // candidates are already in index order, so strict comparisons keep the lower index on ties
  const current = best(usable.filter(item => item.start <= today && today <= item.end), (a, b) => a.start > b.start);
  if (current) return { label: 'current', segment: current.segment };
  const next = best(usable.filter(item => item.start > today), (a, b) => a.start < b.start);
  if (next) return { label: 'next', segment: next.segment };
  const last = best(usable.filter(item => item.end < today), (a, b) => a.end > b.end);
  return last ? { label: 'last', segment: last.segment } : undefined;
}

export function orderSegments(segments: unknown): readonly unknown[] {
  const { usable, unusable } = usableSegments(segments);
  const ordered = [...usable].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : a.index - b.index);
  return [...ordered.map(item => item.segment), ...unusable.map(item => item.segment)];
}

function amountByUnit(unit: unknown, value: unknown, currency: string | undefined): string {
  if (unit === 'BUDGET_UNIT_CURRENCY') return formatMoney(value, currency);
  if (unit === 'BUDGET_UNIT_IMPRESSIONS') return `${formatCount(value)} impressions`;
  return '?';
}

function currencyCode(config: Record<string, unknown>): string {
  const code = config.currencyCode;
  return typeof code === 'string' && CURRENCY_PATTERN.test(code) ? code : '?';
}

function insertionOrderParts(entity: Record<string, unknown>, context: SummaryContext): string[] {
  const parts: string[] = [];
  if (typeof entity.campaignId === 'string' && ID_PATTERN.test(entity.campaignId)) parts.push(`campaign ${entity.campaignId}`);
  const budget = record(entity.budget);
  if (budget) {
    parts.push(`budget ${label(BUDGET_UNIT_LABELS, budget.budgetUnit)}, ${label(AUTOMATION_LABELS, budget.automationType)}`);
    const segments = Array.isArray(budget.budgetSegments) ? budget.budgetSegments as unknown[] : [];
    const prefix = segments.length >= 2 ? `segments ${elementCount(segments.length)}, ` : '';
    const chosen = chooseSegment(segments, context.today);
    if (chosen) {
      const segment = record(chosen.segment) ?? {};
      parts.push(`${prefix}segment ${chosen.label} ${formatDateRange(segment.dateRange)} ${amountByUnit(budget.budgetUnit, segment.budgetAmountMicros, context.currency)}`);
    } else {
      parts.push(`${prefix}${segments.length === 0 ? 'segment none' : 'segment ?'}`);
    }
  }
  const pacing = record(entity.pacing);
  if (pacing) {
    let part = `pacing ${label(PACING_PERIOD_LABELS, pacing.pacingPeriod)} ${label(PACING_TYPE_LABELS, pacing.pacingType)}`;
    if (pacing.dailyMaxMicros !== undefined) part += `, daily max ${formatMoney(pacing.dailyMaxMicros, context.currency)}`;
    else if (pacing.dailyMaxImpressions !== undefined) part += `, daily max ${formatCount(pacing.dailyMaxImpressions)} impressions`;
    parts.push(part);
  }
  return parts;
}

function flightPart(entity: Record<string, unknown>): string {
  const flight = record(entity.flight);
  if (flight?.flightDateType === 'LINE_ITEM_FLIGHT_DATE_TYPE_CUSTOM') return `flight ${formatDateRange(flight.dateRange)}`;
  if (flight?.flightDateType === 'LINE_ITEM_FLIGHT_DATE_TYPE_INHERITED') {
    return flight.dateRange === undefined ? 'flight inherited' : `flight inherited ${formatDateRange(flight.dateRange)}`;
  }
  return 'flight ?';
}

function lineItemBudgetPart(entity: Record<string, unknown>, context: SummaryContext): string {
  const budget = record(entity.budget);
  switch (budget?.budgetAllocationType) {
    case 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED':
      // Live data: YouTube & Partners line items have a fixed allocation but no maxAmount at all; the amount
      // lives on the insertion order (with automatic budget, DV360 splits it). "fixed" is left out: it misled readers.
      if (budget.maxAmount === undefined) return 'budget: no amount on the line item (see its insertion order)';
      return `budget fixed ${amountByUnit(budget.budgetUnit, budget.maxAmount, context.currency)}`;
    case 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_AUTOMATIC':
      return `budget automatic (insertion order)${budget.maxAmount === undefined ? '' : ` ${amountByUnit(budget.budgetUnit, budget.maxAmount, context.currency)}`}`;
    case 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED':
      return 'budget unlimited';   // Google ignores maxAmount here, so it is never shown
    default:
      return 'budget ?';
  }
}

function bidPart(entity: Record<string, unknown>, context: SummaryContext): string {
  const strategy = record(entity.bidStrategy);
  const present = (key: string) => strategy !== undefined && strategy[key] !== undefined && strategy[key] !== null;
  if (present('fixedBid')) return `bid fixed ${formatMoney(record(strategy!.fixedBid)?.bidAmountMicros, context.currency)}`;
  if (present('maximizeSpendAutoBid')) {
    return `bid maximize spend (${enumText(record(strategy!.maximizeSpendAutoBid)?.performanceGoalType, 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_')})`;
  }
  if (present('performanceGoalAutoBid')) {
    // The goal amount is not shown: its unit depends on the goal type.
    return `bid performance goal (${enumText(record(strategy!.performanceGoalAutoBid)?.performanceGoalType, 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_')})`;
  }
  if (present('youtubeAndPartnersBid')) {
    return `bid YouTube and partners (${enumText(record(strategy!.youtubeAndPartnersBid)?.type, 'YOUTUBE_AND_PARTNERS_BIDDING_STRATEGY_TYPE_')})`;
  }
  if (present('demandGenBid')) return 'bid Demand Gen';
  return 'bid ?';
}

export function summarize(type: ResourceType, entity: object, context: SummaryContext): readonly string[] {
  const data = record(entity) ?? {};
  const parts: string[] = [];
  switch (type) {
    case 'partner': {
      const config = record(data.generalConfig);
      if (config) parts.push(`currency ${currencyCode(config)}`);
      break;
    }
    case 'advertiser': {
      const config = record(data.generalConfig);
      if (config) {
        parts.push(`currency ${currencyCode(config)}`);
        parts.push(`time zone ${clean(config.timeZone, 40)}`);
      }
      break;
    }
    case 'campaign': {
      const goal = record(data.campaignGoal);
      if (goal) parts.push(`goal ${enumText(goal.campaignGoalType, 'CAMPAIGN_GOAL_TYPE_')}`);
      const flight = record(data.campaignFlight);
      if (flight) {
        parts.push(`planned ${formatDateRange(flight.plannedDates)}`);
        if (flight.plannedSpendAmountMicros !== undefined) {
          parts.push(`planned spend ${formatMoney(flight.plannedSpendAmountMicros, context.currency)} (does not cap spend)`);
        }
      }
      const budgets = Array.isArray(data.campaignBudgets) ? data.campaignBudgets as unknown[] : [];
      parts.push(budgets.length === 0 ? 'budget unlimited' : `budgets ${elementCount(budgets.length)}`);
      break;
    }
    case 'insertionOrder':
      parts.push(...insertionOrderParts(data, context));
      break;
    case 'lineItem':
      if (typeof data.insertionOrderId === 'string' && ID_PATTERN.test(data.insertionOrderId)) parts.push(`IO ${data.insertionOrderId}`);
      parts.push(enumText(data.lineItemType, 'LINE_ITEM_TYPE_'));
      parts.push(flightPart(data), lineItemBudgetPart(data, context), bidPart(data, context));
      break;
  }
  return parts;
}

export function formatRow(id: string, name: string, status: string, parts: readonly string[]): string {
  return `- ${id}${SEPARATOR}${name}${SEPARATOR}${status}${parts.map(part => `${SEPARATOR}${part}`).join('')}`;
}

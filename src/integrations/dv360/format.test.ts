import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ENUM_CHARS, MAX_NAME_CHARS, MAX_ROW_CHARS, MAX_STATUS_CHARS, chooseSegment, clean, enumText, formatCount,
  formatDate, formatDateRange, formatMoney, formatRow, orderSegments, statusText, summarize,
} from './format.js';

const day = (year: number, month: number, dayOfMonth: number) => ({ year, month, day: dayOfMonth });
const range = (a: [number, number, number], b: [number, number, number]) => ({ startDate: day(...a), endDate: day(...b) });
const segment = (a: [number, number, number], b: [number, number, number], amount = '1000000') =>
  ({ budgetAmountMicros: amount, dateRange: range(a, b) });
const TODAY = '2026-11-12';

test('constants match the plan', () => {
  assert.deepEqual([MAX_NAME_CHARS, MAX_ENUM_CHARS, MAX_STATUS_CHARS, MAX_ROW_CHARS], [80, 40, 24, 400]);
});

test('clean removes controls and the separator, collapses whitespace, and cuts at max', () => {
  assert.equal(clean('Brand\u0000 \n\t·  Name\u0085', 80), 'Brand Name');
  assert.equal(clean('   ', 80), '(no name)');
  assert.equal(clean('·', 80), '(no name)');
  assert.equal(clean(42, 80), '?');
  assert.equal(clean(undefined, 80), '?');
  assert.equal(clean('x'.repeat(80), 80), 'x'.repeat(80));
  assert.equal(clean('x'.repeat(81), 80), `${'x'.repeat(79)}…`);
  assert.equal(clean('Türkçe İşlem ışık', 80), 'Türkçe İşlem ışık');
});

test('clean never leaves half a surrogate pair at the cut', () => {
  const text = `${'a'.repeat(78)}😀tail`;
  const result = clean(text, 80);
  assert.equal(result, `${'a'.repeat(78)}…`);
  assert.ok(result.length <= 80);
  assert.equal(clean(`${'a'.repeat(77)}😀tail`, 80), `${'a'.repeat(77)}😀…`);
});

test('enumText removes the prefix, caps open enums at 40 characters, and rejects odd values', () => {
  assert.equal(enumText('LINE_ITEM_TYPE_DISPLAY_DEFAULT', 'LINE_ITEM_TYPE_'), 'DISPLAY_DEFAULT');
  assert.equal(enumText('OTHER_VALUE', 'LINE_ITEM_TYPE_'), 'OTHER_VALUE');
  assert.equal(enumText('LINE_ITEM_TYPE_', 'LINE_ITEM_TYPE_'), 'LINE_ITEM_TYPE_');
  for (const value of ['lowercase', 'HAS SPACE', '1STARTS_WITH_DIGIT', '', 42, null, undefined, `A${'B'.repeat(80)}`]) {
    assert.equal(enumText(value, 'X_'), '?');
  }
  const long = `LINE_ITEM_TYPE_${'YOUTUBE_AND_PARTNERS_NON_SKIPPABLE_OVER_THE_TOP'}`;
  assert.equal(long.length - 'LINE_ITEM_TYPE_'.length, 47);   // the real value is 47 characters (the plan said 46)
  assert.equal(enumText(long, 'LINE_ITEM_TYPE_'), `${'YOUTUBE_AND_PARTNERS_NON_SKIPPABLE_OVER_THE_TOP'.slice(0, 39)}…`);
  const forty = 'A'.repeat(40);
  assert.equal(enumText(forty, 'X_'), forty);
  assert.equal(enumText('A'.repeat(41), 'X_'), `${'A'.repeat(39)}…`);
});

test('statusText strips ENTITY_STATUS_ and cuts unknown long statuses at 24', () => {
  assert.equal(statusText('ENTITY_STATUS_ACTIVE'), 'ACTIVE');
  assert.equal(statusText('ENTITY_STATUS_SCHEDULED_FOR_DELETION'), 'SCHEDULED_FOR_DELETION');
  assert.equal(statusText(`ENTITY_STATUS_${'N'.repeat(30)}`), `${'N'.repeat(23)}…`);
  assert.equal(statusText('ENTITY_STATUS_'.concat('N'.repeat(24))), 'N'.repeat(24));
  for (const value of ['active', 7, undefined, null, '']) assert.equal(statusText(value), '?');
});

test('formatDate and formatDateRange', () => {
  assert.equal(formatDate(day(2026, 3, 7)), '2026-03-07');
  assert.equal(formatDate(day(9, 1, 1)), '0009-01-01');
  for (const value of [undefined, null, 'x', { year: 2026, month: 13, day: 1 }, { year: 2026, month: 0, day: 1 },
    { year: 2026, month: 1, day: 32 }, { year: 0, month: 1, day: 1 }, { year: 10000, month: 1, day: 1 },
    { year: '2026', month: 1, day: 1 }, { year: 2026.5, month: 1, day: 1 }, { year: 2026, month: 1 }]) {
    assert.equal(formatDate(value), '?');
  }
  assert.equal(formatDateRange(range([2026, 3, 1], [2026, 3, 31])), '2026-03-01–2026-03-31');
  assert.equal(formatDateRange({ startDate: day(2026, 3, 1) }), '2026-03-01–open');
  assert.equal(formatDateRange({ endDate: day(2026, 3, 31) }), '?–2026-03-31');
  assert.equal(formatDateRange({}), '?–open');
  assert.equal(formatDateRange({ startDate: day(2026, 3, 1), endDate: { year: 1 } }), '2026-03-01–?');
  for (const value of [undefined, null, [], 'x', 5]) assert.equal(formatDateRange(value), '?');
  assert.equal(formatDateRange(range([2026, 1, 1], [2026, 12, 31])).length, 21);
});

test('formatMoney converts micros with half-away-from-zero rounding and labels the currency', () => {
  assert.equal(formatMoney('15800000', 'TRY'), '15.80 TRY');
  assert.equal(formatMoney('1234567890000', 'EUR'), '1,234,567.89 EUR');
  assert.equal(formatMoney('5000', undefined), '0.01 (advertiser currency)');
  assert.equal(formatMoney('4999', 'USD'), '0.00 USD');
  assert.equal(formatMoney('0', 'USD'), '0.00 USD');
  assert.equal(formatMoney('-15800000', 'USD'), '-15.80 USD');
  assert.equal(formatMoney('-5000', 'USD'), '-0.01 USD');
  assert.equal(formatMoney('-4999', 'USD'), '0.00 USD');
  assert.equal(formatMoney('15800000', 'try'), '15.80 (advertiser currency)');
  assert.equal(formatMoney('15800000', 'TRYY'), '15.80 (advertiser currency)');
  assert.equal(formatMoney('007', 'USD'), '0.00 USD');
});

test('formatMoney keeps 18-digit values exact and rejects longer or malformed values', () => {
  assert.equal(formatMoney('123456789012345678', 'USD'), '123,456,789,012.35 USD');
  assert.equal(formatMoney('999999999999999999', 'USD'), '1,000,000,000,000.00 USD');
  assert.equal(formatMoney('1234567890123456789', 'USD'), '?');
  for (const value of [12, 1.5, null, undefined, '1.5', 'abc', '', '-', '--1', '+5', ' 5', '5 ', {}]) {
    assert.equal(formatMoney(value, 'USD'), '?');
  }
});

test('formatCount adds separators and never divides', () => {
  assert.equal(formatCount('15800000'), '15,800,000');
  assert.equal(formatCount(15800000), '15,800,000');
  assert.equal(formatCount('0'), '0');
  assert.equal(formatCount('000123'), '123');
  assert.equal(formatCount('999999999999999'), '999,999,999,999,999');
  for (const value of ['1000000000000000', 1000000000000000, -1, 1.5, 'abc', '', '-5', null, undefined, {}, Number.NaN]) {
    assert.equal(formatCount(value), '?');
  }
});

test('segment choice is by date, never by array position', () => {
  const december = segment([2026, 12, 1], [2026, 12, 31], '3');
  const november = segment([2026, 11, 1], [2026, 11, 30], '2');
  const august = segment([2026, 8, 1], [2026, 8, 31], '1');
  // December listed before November, today in October: the next segment is November.
  assert.deepEqual(chooseSegment([december, november], '2026-10-15'), { label: 'next', segment: november });
  assert.deepEqual(chooseSegment([december, november], '2026-11-12'), { label: 'current', segment: november });
  assert.deepEqual(chooseSegment([august, december, november], '2027-03-01'), { label: 'last', segment: december });
  assert.deepEqual(chooseSegment([december, august], '2026-10-01'), { label: 'next', segment: december });
  assert.deepEqual(chooseSegment([august], '2026-10-01'), { label: 'last', segment: august });
  assert.equal(chooseSegment([], TODAY), undefined);
  assert.equal(chooseSegment(undefined, TODAY), undefined);
  assert.equal(chooseSegment('x', TODAY), undefined);
});

test('segment choice handles overlaps, ties, boundaries, and malformed dates', () => {
  const wide = segment([2026, 1, 1], [2026, 12, 31], 'wide');
  const narrow = segment([2026, 11, 1], [2026, 11, 30], 'narrow');
  assert.equal((chooseSegment([wide, narrow], TODAY)!.segment as { budgetAmountMicros: string }).budgetAmountMicros, 'narrow');
  assert.equal((chooseSegment([narrow, wide], TODAY)!.segment as { budgetAmountMicros: string }).budgetAmountMicros, 'narrow');
  const first = segment([2026, 11, 1], [2026, 11, 30], 'first');
  const second = segment([2026, 11, 1], [2026, 11, 30], 'second');
  assert.equal(chooseSegment([first, second], TODAY)!.segment, first);
  const futureA = segment([2027, 1, 1], [2027, 1, 31], 'a');
  const futureB = segment([2027, 1, 1], [2027, 2, 28], 'b');
  assert.equal(chooseSegment([futureA, futureB], TODAY)!.segment, futureA);
  const pastA = segment([2026, 1, 1], [2026, 3, 31], 'a');
  const pastB = segment([2026, 2, 1], [2026, 3, 31], 'b');
  assert.equal(chooseSegment([pastA, pastB], TODAY)!.segment, pastA);
  const startsToday = segment([2026, 11, 12], [2026, 11, 20]);
  const endsToday = segment([2026, 11, 1], [2026, 11, 12]);
  assert.equal(chooseSegment([startsToday], TODAY)!.label, 'current');
  assert.equal(chooseSegment([endsToday], TODAY)!.label, 'current');
  const malformed = [{ dateRange: { startDate: day(2026, 13, 1), endDate: day(2026, 14, 1) } }, { budgetAmountMicros: '1' },
    { dateRange: range([2026, 12, 1], [2026, 11, 1]) }, null, 'x'];
  assert.equal(chooseSegment(malformed, TODAY), undefined);
  assert.equal(chooseSegment([...malformed, narrow], TODAY)!.segment, narrow);
});

test('orderSegments sorts a copy: usable by start then end then index, unusable last in array order', () => {
  const late = segment([2026, 12, 1], [2026, 12, 31], 'late');
  const early = segment([2026, 1, 1], [2026, 6, 30], 'early');
  const tieShort = segment([2026, 7, 1], [2026, 7, 31], 'short');
  const tieLong = segment([2026, 7, 1], [2026, 8, 31], 'long');
  const bad = { budgetAmountMicros: 'bad' };
  const input = [bad, late, tieLong, early, tieShort];
  const ordered = orderSegments(input);
  assert.deepEqual(ordered, [early, tieShort, tieLong, late, bad]);
  assert.deepEqual(input, [bad, late, tieLong, early, tieShort]);
  assert.deepEqual(orderSegments(undefined), []);
});

const context = { currency: 'TRY', today: TODAY };
const budgetOf = (budgetUnit: string, segments: unknown[] = [segment([2026, 11, 1], [2026, 11, 30], '15800000')], automationType = 'INSERTION_ORDER_AUTOMATION_TYPE_NONE') =>
  ({ budgetUnit, automationType, budgetSegments: segments });
const pacing = { pacingPeriod: 'PACING_PERIOD_FLIGHT', pacingType: 'PACING_TYPE_AHEAD' };

test('summarize partner and advertiser', () => {
  assert.deepEqual(summarize('partner', { generalConfig: { currencyCode: 'USD' } }, context), ['currency USD']);
  assert.deepEqual(summarize('partner', { generalConfig: { currencyCode: 'usd' } }, context), ['currency ?']);
  assert.deepEqual(summarize('partner', {}, context), []);
  assert.deepEqual(summarize('advertiser', { generalConfig: { currencyCode: 'EUR', timeZone: 'Europe/Istanbul' } }, context),
    ['currency EUR', 'time zone Europe/Istanbul']);
  assert.deepEqual(summarize('advertiser', { generalConfig: { currencyCode: 'EUR' } }, context), ['currency EUR', 'time zone ?']);
  assert.deepEqual(summarize('advertiser', { generalConfig: { currencyCode: 'EUR', timeZone: `Z${'x'.repeat(60)}\n` } }, context)[1],
    `time zone Z${'x'.repeat(38)}…`);
});

test('summarize campaigns: goal, planned dates and spend, budgets', () => {
  const campaign = {
    campaignGoal: { campaignGoalType: 'CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS' },
    campaignFlight: { plannedDates: range([2026, 3, 1], [2026, 3, 31]), plannedSpendAmountMicros: '2500000000' },
  };
  assert.deepEqual(summarize('campaign', campaign, context), [
    'goal BRAND_AWARENESS', 'planned 2026-03-01–2026-03-31', 'planned spend 2,500.00 TRY (does not cap spend)', 'budget unlimited',
  ]);
  assert.deepEqual(summarize('campaign', { ...campaign, campaignBudgets: [{}, {}] }, { today: TODAY }).slice(2),
    ['planned spend 2,500.00 (advertiser currency) (does not cap spend)', 'budgets 2']);
  assert.equal(summarize('campaign', { campaignBudgets: new Array(1000).fill({}) }, context).at(-1), 'budgets 999+');
  assert.deepEqual(summarize('campaign', { campaignFlight: { plannedDates: range([2026, 3, 1], [2026, 3, 31]) } }, context),
    ['planned 2026-03-01–2026-03-31', 'budget unlimited']);
  assert.deepEqual(summarize('campaign', {}, context), ['budget unlimited']);
});

test('summarize insertion orders: units, automation, segments, pacing', () => {
  const currencyOrder = {
    campaignId: '77', budget: budgetOf('BUDGET_UNIT_CURRENCY', undefined, 'INSERTION_ORDER_AUTOMATION_TYPE_BID_BUDGET'),
    pacing: { ...pacing, pacingPeriod: 'PACING_PERIOD_DAILY', pacingType: 'PACING_TYPE_EVEN', dailyMaxMicros: '250000000' },
  };
  assert.deepEqual(summarize('insertionOrder', currencyOrder, context), [
    'campaign 77', 'budget in currency, automatic bid and budget', 'segment current 2026-11-01–2026-11-30 15.80 TRY',
    'pacing daily even, daily max 250.00 TRY',
  ]);
  // Impression amounts are plain counts, never divided or shown as money (verified against the DV360 UI).
  const impressionOrder = { budget: budgetOf('BUDGET_UNIT_IMPRESSIONS'), pacing: { ...pacing, dailyMaxImpressions: '5000' } };
  assert.deepEqual(summarize('insertionOrder', impressionOrder, context), [
    'budget in impressions, manual', 'segment current 2026-11-01–2026-11-30 15,800,000 impressions',
    'pacing flight ahead, daily max 5,000 impressions',
  ]);
  const manySegments = budgetOf('BUDGET_UNIT_CURRENCY', [
    segment([2026, 12, 1], [2026, 12, 31]), segment([2026, 11, 1], [2026, 11, 30]), segment([2026, 8, 1], [2026, 8, 31])]);
  assert.equal(summarize('insertionOrder', { budget: manySegments }, context)[1], 'segments 3, segment current 2026-11-01–2026-11-30 1.00 TRY');
  assert.equal(summarize('insertionOrder', { budget: budgetOf('BUDGET_UNIT_CURRENCY', new Array(1000).fill(segment([2026, 11, 1], [2026, 11, 30]))) }, context)[1]
    .startsWith('segments 999+, segment current'), true);
  assert.equal(summarize('insertionOrder', { budget: budgetOf('BUDGET_UNIT_CURRENCY', []) }, context)[1], 'segment none');
  assert.equal(summarize('insertionOrder', { budget: { budgetUnit: 'BUDGET_UNIT_CURRENCY' } }, context)[1], 'segment none');
  assert.equal(summarize('insertionOrder', { budget: budgetOf('BUDGET_UNIT_CURRENCY', [{ x: 1 }]) }, context)[1], 'segment ?');
  assert.equal(summarize('insertionOrder', { budget: budgetOf('BUDGET_UNIT_CURRENCY', [{ x: 1 }, { y: 2 }]) }, context)[1], 'segments 2, segment ?');
  assert.deepEqual(summarize('insertionOrder', { budget: budgetOf('BUDGET_UNIT_UNSPECIFIED', undefined, 'WHATEVER') }, context).slice(0, 2),
    ['budget ?, ?', 'segment current 2026-11-01–2026-11-30 ?']);
  assert.deepEqual(summarize('insertionOrder', {}, context), []);
  assert.equal(summarize('insertionOrder', { pacing: { pacingPeriod: 'PACING_PERIOD_UNSPECIFIED' } }, context)[0], 'pacing ? ?');
});

test('every closed enum table maps its documented values and rejects others', () => {
  const rows: [string, string, string][] = [
    ['INSERTION_ORDER_AUTOMATION_TYPE_NONE', 'manual', 'automationType'],
    ['INSERTION_ORDER_AUTOMATION_TYPE_BUDGET', 'automatic budget', 'automationType'],
    ['INSERTION_ORDER_AUTOMATION_TYPE_BID_BUDGET', 'automatic bid and budget', 'automationType'],
  ];
  for (const [value, expected] of rows) {
    assert.ok(summarize('insertionOrder', { budget: budgetOf('BUDGET_UNIT_CURRENCY', [], value) }, context)[0].endsWith(`, ${expected}`));
  }
  for (const [value, expected] of [['PACING_PERIOD_DAILY', 'daily'], ['PACING_PERIOD_FLIGHT', 'flight']]) {
    assert.ok(summarize('insertionOrder', { pacing: { pacingPeriod: value, pacingType: 'PACING_TYPE_ASAP' } }, context)[0].startsWith(`pacing ${expected} asap`));
  }
  for (const [value, expected] of [['PACING_TYPE_AHEAD', 'ahead'], ['PACING_TYPE_ASAP', 'asap'], ['PACING_TYPE_EVEN', 'even']]) {
    assert.equal(summarize('insertionOrder', { pacing: { pacingPeriod: 'PACING_PERIOD_FLIGHT', pacingType: value } }, context)[0], `pacing flight ${expected}`);
  }
  assert.equal(summarize('insertionOrder', { pacing: { pacingPeriod: 'daily', pacingType: 'PACING_TYPE_PROTOTYPE' } }, context)[0], 'pacing ? ?');
  assert.equal(summarize('insertionOrder', { pacing: { pacingPeriod: '__proto__', pacingType: 'constructor' } }, context)[0], 'pacing ? ?');
});

const lineItem = (overrides: Record<string, unknown> = {}) => ({
  insertionOrderId: '9', lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT',
  flight: { flightDateType: 'LINE_ITEM_FLIGHT_DATE_TYPE_CUSTOM', dateRange: range([2026, 3, 1], [2026, 3, 31]) },
  budget: { budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED', budgetUnit: 'BUDGET_UNIT_CURRENCY', maxAmount: '15800000' },
  bidStrategy: { fixedBid: { bidAmountMicros: '2500000' } },
  ...overrides,
});

test('summarize line items: flight variants', () => {
  assert.deepEqual(summarize('lineItem', lineItem(), context), [
    'IO 9', 'DISPLAY_DEFAULT', 'flight 2026-03-01–2026-03-31', 'budget fixed 15.80 TRY', 'bid fixed 2.50 TRY',
  ]);
  const inherited = (dateRange?: unknown) => lineItem({ flight: { flightDateType: 'LINE_ITEM_FLIGHT_DATE_TYPE_INHERITED', ...(dateRange ? { dateRange } : {}) } });
  assert.equal(summarize('lineItem', inherited(range([2026, 1, 1], [2026, 12, 31])), context)[2], 'flight inherited 2026-01-01–2026-12-31');
  assert.equal(summarize('lineItem', inherited(), context)[2], 'flight inherited');
  assert.equal(summarize('lineItem', lineItem({ flight: { flightDateType: 'LINE_ITEM_FLIGHT_DATE_TYPE_UNSPECIFIED' } }), context)[2], 'flight ?');
  assert.equal(summarize('lineItem', lineItem({ flight: undefined }), context)[2], 'flight ?');
  assert.deepEqual(summarize('lineItem', { lineItemType: 'LINE_ITEM_TYPE_VIDEO_DEFAULT' }, context), ['VIDEO_DEFAULT', 'flight ?', 'budget ?', 'bid ?']);
  assert.equal(summarize('lineItem', {}, context)[0], '?');
});

test('summarize line item budgets by allocation type and unit', () => {
  const budget = (budgetAllocationType: string, budgetUnit: string, maxAmount?: string) =>
    lineItem({ budget: { budgetAllocationType: `LINE_ITEM_BUDGET_ALLOCATION_TYPE_${budgetAllocationType}`, budgetUnit, ...(maxAmount === undefined ? {} : { maxAmount }) } });
  const part = (item: object) => summarize('lineItem', item, context)[3];
  assert.equal(part(budget('FIXED', 'BUDGET_UNIT_CURRENCY', '15800000')), 'budget fixed 15.80 TRY');
  assert.equal(part(budget('FIXED', 'BUDGET_UNIT_IMPRESSIONS', '15800000')), 'budget fixed 15,800,000 impressions');
  assert.equal(part(budget('FIXED', 'BUDGET_UNIT_UNSPECIFIED', '15800000')), 'budget fixed ?');
  // Live data (2026-11-12): YouTube & Partners line items are FIXED with no maxAmount; that is stated, not shown as '?'.
  assert.equal(part(budget('FIXED', 'BUDGET_UNIT_CURRENCY')), 'budget: no amount on the line item (see its insertion order)');
  assert.equal(part(budget('FIXED', 'BUDGET_UNIT_CURRENCY', 'not-a-number')), 'budget fixed ?');
  assert.equal(part(budget('AUTOMATIC', 'BUDGET_UNIT_CURRENCY')), 'budget automatic (insertion order)');
  assert.equal(part(budget('AUTOMATIC', 'BUDGET_UNIT_CURRENCY', '15800000')), 'budget automatic (insertion order) 15.80 TRY');
  assert.equal(part(budget('AUTOMATIC', 'BUDGET_UNIT_IMPRESSIONS', '15800000')), 'budget automatic (insertion order) 15,800,000 impressions');
  assert.equal(part(budget('UNLIMITED', 'BUDGET_UNIT_CURRENCY')), 'budget unlimited');
  // Google ignores maxAmount for unlimited budgets, so it must never be shown, even when present.
  assert.equal(part(budget('UNLIMITED', 'BUDGET_UNIT_CURRENCY', '15800000')), 'budget unlimited');
  assert.equal(part(budget('UNSPECIFIED', 'BUDGET_UNIT_CURRENCY', '15800000')), 'budget ?');
  assert.equal(part(lineItem({ budget: { budgetAllocationType: 'SOMETHING_ELSE' } })), 'budget ?');
  assert.equal(part(lineItem({ budget: undefined })), 'budget ?');
});

test('summarize line item bid strategies: each key, priority, and unknown keys', () => {
  const bid = (bidStrategy: unknown) => summarize('lineItem', lineItem({ bidStrategy }), context)[4];
  assert.equal(bid({ fixedBid: { bidAmountMicros: '2500000' } }), 'bid fixed 2.50 TRY');
  assert.equal(bid({ maximizeSpendAutoBid: { performanceGoalType: 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_CPA' } }), 'bid maximize spend (CPA)');
  assert.equal(bid({ maximizeSpendAutoBid: {} }), 'bid maximize spend (?)');
  assert.equal(bid({ performanceGoalAutoBid: { performanceGoalType: 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_VIEWABLE_CPM', performanceGoalAmountMicros: '999' } }),
    'bid performance goal (VIEWABLE_CPM)');   // the goal amount is never shown
  assert.equal(bid({ youtubeAndPartnersBid: { type: 'YOUTUBE_AND_PARTNERS_BIDDING_STRATEGY_TYPE_TARGET_CPV' } }), 'bid YouTube and partners (TARGET_CPV)');
  assert.equal(bid({ demandGenBid: { anything: 1 } }), 'bid Demand Gen');
  assert.equal(bid({ fixedBid: { bidAmountMicros: '2500000' }, maximizeSpendAutoBid: {}, demandGenBid: {} }), 'bid fixed 2.50 TRY');
  assert.equal(bid({ performanceGoalAutoBid: {}, youtubeAndPartnersBid: {} }), 'bid performance goal (?)');
  assert.equal(bid({ somethingNew: {} }), 'bid ?');
  assert.equal(bid({ fixedBid: null, demandGenBid: {} }), 'bid Demand Gen');
  assert.equal(bid({}), 'bid ?');
  assert.equal(bid(undefined), 'bid ?');
});

test('summarize is total: odd entities never throw', () => {
  for (const type of ['partner', 'advertiser', 'campaign', 'insertionOrder', 'lineItem'] as const) {
    for (const entity of [{}, { generalConfig: 5, budget: 'x', flight: [], bidStrategy: 7, pacing: null, campaignBudgets: 'x' }]) {
      assert.ok(Array.isArray(summarize(type, entity, context)));
    }
  }
});

test('formatRow joins fields without shortening them', () => {
  assert.equal(formatRow('1', 'Name', 'ACTIVE', []), '- 1 · Name · ACTIVE');
  assert.equal(formatRow('1', 'Name', 'ACTIVE', ['a', 'b']), '- 1 · Name · ACTIVE · a · b');
  const long = 'x'.repeat(500);
  assert.equal(formatRow('1', long, 'ACTIVE', [long]).length, '- 1 · '.length + 500 + ' · ACTIVE · '.length + 500);
});

// Worst-case rows: every field yields its longest possible part. The maxima below are exact, so any formatter
// change that moves the bound fails visibly. Two differences from the plan's estimate: rounding an 18-digit
// value up gives -1,000,000,000,000.00 (21 characters, not 19), which adds 2 per money part; and the YouTube
// bidding enum can be at most 37 characters (80 minus its 43-character prefix), not 40.
const ID20 = '9'.repeat(20);
const NAME = 'N'.repeat(100);
const STATUS = `ENTITY_STATUS_${'S'.repeat(30)}`;
const ENUM60 = 'E'.repeat(60);
// enumText only accepts raw values of at most 80 characters, so a long prefix leaves less room (the YouTube
// bidding prefix is 43 characters, leaving 37); fill each enum to the longest value it can accept.
const fill = (prefix: string) => `${prefix}${'E'.repeat(80 - prefix.length)}`;
const MONEY = '-999999999999999999';
const COUNT = '999999999999999';
const WIDE = segment([2026, 1, 1], [2026, 12, 31], MONEY);
const WIDE_COUNT = segment([2026, 1, 1], [2026, 12, 31], COUNT);
const worstContext = { today: TODAY };   // no known currency: the longest suffix
const worst = {
  partner: { generalConfig: { currencyCode: 'USD' } },
  advertiser: { generalConfig: { currencyCode: 'USD', timeZone: 'Z'.repeat(60) } },
  campaign: {
    campaignGoal: { campaignGoalType: fill('CAMPAIGN_GOAL_TYPE_') },
    campaignFlight: { plannedDates: range([2026, 1, 1], [2026, 12, 31]), plannedSpendAmountMicros: MONEY },
    campaignBudgets: new Array(1000).fill({}),
  },
  insertionOrder: {
    campaignId: ID20,
    budget: budgetOf('BUDGET_UNIT_IMPRESSIONS', new Array(1000).fill(WIDE_COUNT), 'INSERTION_ORDER_AUTOMATION_TYPE_BID_BUDGET'),
    pacing: { pacingPeriod: 'PACING_PERIOD_DAILY', pacingType: 'PACING_TYPE_ASAP', dailyMaxImpressions: COUNT },
  },
  insertionOrderMoney: {
    campaignId: ID20,
    budget: budgetOf('BUDGET_UNIT_CURRENCY', new Array(1000).fill(WIDE), 'INSERTION_ORDER_AUTOMATION_TYPE_BID_BUDGET'),
    pacing: { pacingPeriod: 'PACING_PERIOD_DAILY', pacingType: 'PACING_TYPE_ASAP', dailyMaxMicros: MONEY },
  },
  lineItem: {
    insertionOrderId: ID20, lineItemType: fill('LINE_ITEM_TYPE_'),
    flight: { flightDateType: 'LINE_ITEM_FLIGHT_DATE_TYPE_INHERITED', dateRange: range([2026, 1, 1], [2026, 12, 31]) },
    budget: { budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_AUTOMATIC', budgetUnit: 'BUDGET_UNIT_CURRENCY', maxAmount: MONEY },
    bidStrategy: { youtubeAndPartnersBid: { type: fill('YOUTUBE_AND_PARTNERS_BIDDING_STRATEGY_TYPE_') } },
  },
};

function worstRow(type: keyof typeof worst): string {
  const resource = type === 'insertionOrderMoney' ? 'insertionOrder' : type;
  return formatRow(ID20, clean(NAME, MAX_NAME_CHARS), statusText(STATUS), summarize(resource, worst[type], worstContext));
}

test('worst-case rows stay within MAX_ROW_CHARS, with exact maxima per type', () => {
  const lengths = Object.fromEntries((Object.keys(worst) as (keyof typeof worst)[]).map(type => [type, worstRow(type).length]));
  assert.deepEqual(lengths, {
    partner: 147, advertiser: 200, campaign: 308, insertionOrder: 364, insertionOrderMoney: 385, lineItem: 390,
  });
  for (const length of Object.values(lengths)) assert.ok(length <= MAX_ROW_CHARS, `row of ${length} exceeds ${MAX_ROW_CHARS}`);
  assert.ok(Math.max(...Object.values(lengths)) <= MAX_ROW_CHARS);
});

test('worst-case alternatives are no longer than the rows above', () => {
  const longestMoney = formatMoney(MONEY, undefined);
  assert.equal(longestMoney.length, 43);
  const alternatives = [
    `pacing daily even, daily max ${formatCount(COUNT)} impressions`,
    `budget fixed ${formatCount(COUNT)} impressions`,
    `budget automatic (insertion order) ${formatCount(COUNT)} impressions`,
    `bid fixed ${longestMoney}`,
    `bid performance goal (${enumText(`BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_${ENUM60}`, 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_')})`,
    `bid maximize spend (${enumText(`BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_${ENUM60}`, 'BIDDING_STRATEGY_PERFORMANCE_GOAL_TYPE_')})`,
  ];
  const limits = [60, 44, 66, 53, 63, 61];
  alternatives.forEach((text, index) => assert.ok(text.length <= limits[index] + 2, `${text.length} > ${limits[index] + 2}: ${text}`));
});

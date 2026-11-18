import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIMENSIONS, validateReportFields } from '../integrations/bidmanager/fields.js';
import {
  BREAKDOWNS, PRESETS, YOUTUBE_FILTER_LEVELS, planReport, reportFilters,
  type PresetName, type TargetLevel,
} from './presets.js';

const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];
const LEVELS = ['advertiser', 'campaign', 'insertionOrder', 'lineItem'] as const;
const ALL_TARGET_LEVELS: readonly TargetLevel[] = ['campaign', 'insertionOrder', 'lineItem'];
const FILTER_CODES = {
  advertiser: 'FILTER_ADVERTISER', campaign: 'FILTER_MEDIA_PLAN',
  insertionOrder: 'FILTER_INSERTION_ORDER', lineItem: 'FILTER_LINE_ITEM',
} as const;
const IDS = { advertiserId: '100', targetId: '200', partnerId: '300' };

test('every accepted preset, breakdown and target passes the field validation', () => {
  let accepted = 0;
  for (const youtubeFilterLevels of [YOUTUBE_FILTER_LEVELS, []] as const) {
    for (const preset of PRESET_NAMES) for (const breakdown of BREAKDOWNS) for (const targetLevel of LEVELS) {
      const plan = planReport({ preset, breakdown, targetLevel, youtubeFilterLevels });
      if (!plan.ok) continue;
      accepted++;
      const { shape } = plan;
      const filters = reportFilters(shape, { ...IDS, targetLevel });
      const label = `${preset} ${breakdown} ${targetLevel}`;
      const result = validateReportFields({ type: shape.type, dimensions: shape.dimensions, metrics: shape.metrics, filters });
      assert.ok(result.ok, `${label}: ${result.ok ? '' : result.problems.join(' | ')}`);
      assert.equal(shape.type, PRESETS[preset].type, label);
      assert.ok(shape.dimensions.includes('FILTER_ADVERTISER_CURRENCY'), label);
      assert.ok(shape.metrics.includes('METRIC_REVENUE_ADVERTISER'), label);
    }
  }
  assert.ok(accepted > 100);
});

test('the YouTube filter levels are exactly those the catalog lets YOUTUBE filter by', () => {
  for (const level of ALL_TARGET_LEVELS) {
    const entry = DIMENSIONS.find(dimension => dimension.code === FILTER_CODES[level]);
    assert.equal(entry?.filterTypes.includes('YOUTUBE'), YOUTUBE_FILTER_LEVELS.includes(level), level);
  }
});

test('with every YouTube filter level verified, youtube filters to the target and has no fallback', () => {
  for (const targetLevel of ALL_TARGET_LEVELS) {
    const plan = planReport({ preset: 'youtube', breakdown: 'total', targetLevel, youtubeFilterLevels: ALL_TARGET_LEVELS });
    assert.ok(plan.ok);
    assert.equal(plan.shape.targetFilter, true);
    assert.equal(plan.shape.requestedRowLevel, undefined);
    assert.deepEqual(reportFilters(plan.shape, { ...IDS, targetLevel }), [
      { type: 'FILTER_ADVERTISER', value: '100' },
      { type: FILTER_CODES[targetLevel], value: '200' },
      { type: 'FILTER_PARTNER', value: '300' },
    ]);
  }
});

test('dimensions follow the breakdown, then the advertiser currency', () => {
  const dimensions = (preset: PresetName, breakdown: (typeof BREAKDOWNS)[number], targetLevel: (typeof LEVELS)[number]) => {
    const plan = planReport({ preset, breakdown, targetLevel, youtubeFilterLevels: [] });
    assert.ok(plan.ok, `${preset} ${breakdown} ${targetLevel}`);
    return plan.shape.dimensions;
  };
  assert.deepEqual(dimensions('delivery', 'total', 'campaign'),
    ['FILTER_MEDIA_PLAN', 'FILTER_MEDIA_PLAN_NAME', 'FILTER_ADVERTISER_CURRENCY']);
  assert.deepEqual(dimensions('delivery', 'total', 'advertiser'),
    ['FILTER_ADVERTISER', 'FILTER_ADVERTISER_NAME', 'FILTER_ADVERTISER_CURRENCY']);
  assert.deepEqual(dimensions('delivery', 'day', 'lineItem'),
    ['FILTER_DATE', 'FILTER_LINE_ITEM', 'FILTER_LINE_ITEM_NAME', 'FILTER_ADVERTISER_CURRENCY']);
  assert.deepEqual(dimensions('reach', 'week', 'campaign'),
    ['FILTER_WEEK', 'FILTER_MEDIA_PLAN', 'FILTER_MEDIA_PLAN_NAME', 'FILTER_ADVERTISER_CURRENCY']);
  assert.deepEqual(dimensions('video', 'month', 'insertionOrder'),
    ['FILTER_MONTH', 'FILTER_INSERTION_ORDER', 'FILTER_INSERTION_ORDER_NAME', 'FILTER_ADVERTISER_CURRENCY']);
  assert.deepEqual(dimensions('delivery', 'line_item', 'campaign'),
    ['FILTER_LINE_ITEM', 'FILTER_LINE_ITEM_NAME', 'FILTER_ADVERTISER_CURRENCY']);
  assert.deepEqual(dimensions('youtube', 'campaign', 'advertiser'),
    ['FILTER_MEDIA_PLAN', 'FILTER_MEDIA_PLAN_NAME', 'FILTER_ADVERTISER_CURRENCY']);
});

test('partner and target filters follow the report type and target level', () => {
  const filtersFor = (preset: PresetName, targetLevel: (typeof LEVELS)[number]) => {
    const plan = planReport({ preset, breakdown: 'total', targetLevel, youtubeFilterLevels: [] });
    assert.ok(plan.ok);
    return reportFilters(plan.shape, { ...IDS, targetLevel }).map(filter => filter.type);
  };
  assert.deepEqual(filtersFor('delivery', 'advertiser'), ['FILTER_ADVERTISER']);
  assert.deepEqual(filtersFor('delivery', 'campaign'), ['FILTER_ADVERTISER', 'FILTER_MEDIA_PLAN']);
  assert.deepEqual(filtersFor('reach', 'lineItem'), ['FILTER_ADVERTISER', 'FILTER_LINE_ITEM', 'FILTER_PARTNER']);
  assert.deepEqual(filtersFor('youtube', 'advertiser'), ['FILTER_ADVERTISER', 'FILTER_PARTNER']);
});

test('reportFilters throws when an ID the shape needs is missing', () => {
  const target = planReport({ preset: 'delivery', breakdown: 'total', targetLevel: 'campaign', youtubeFilterLevels: [] });
  const partner = planReport({ preset: 'reach', breakdown: 'total', targetLevel: 'advertiser', youtubeFilterLevels: [] });
  assert.ok(target.ok && partner.ok);
  assert.throws(() => reportFilters(target.shape, { advertiserId: '100', targetLevel: 'campaign' }), /needs targetId/);
  assert.throws(() => reportFilters(partner.shape, { advertiserId: '100', targetLevel: 'advertiser' }), /needs partnerId/);
});

test('the youtube preset refuses day, week and month with the exact message', () => {
  for (const breakdown of ['day', 'week', 'month'] as const) {
    assert.deepEqual(planReport({ preset: 'youtube', breakdown, targetLevel: 'advertiser', youtubeFilterLevels: [] }), {
      ok: false,
      problem: "The youtube preset can't be split by day, week, or month: YouTube reports have no date dimensions. Use breakdown total or a level, or a STANDARD preset (delivery, video) for daily numbers.",
    });
  }
});

test('a child breakdown must be below the target, with the exact message', () => {
  const refused = (breakdown: (typeof BREAKDOWNS)[number], targetLevel: (typeof LEVELS)[number]) =>
    planReport({ preset: 'delivery', breakdown, targetLevel, youtubeFilterLevels: [] });
  assert.deepEqual(refused('campaign', 'campaign'), { ok: false, problem: 'breakdown campaign must be a level below the campaign.' });
  assert.deepEqual(refused('campaign', 'lineItem'), { ok: false, problem: 'breakdown campaign must be a level below the line item.' });
  assert.deepEqual(refused('insertion_order', 'insertionOrder'), { ok: false, problem: 'breakdown insertion_order must be a level below the insertion order.' });
  assert.deepEqual(refused('line_item', 'lineItem'), { ok: false, problem: 'breakdown line_item must be a level below the line item.' });
  assert.equal(refused('line_item', 'insertionOrder').ok, true);
  assert.equal(refused('campaign', 'advertiser').ok, true);
});

test('youtube without a verified filter level falls back to an advertiser-wide report at the target level', () => {
  for (const targetLevel of ALL_TARGET_LEVELS) {
    const plan = planReport({ preset: 'youtube', breakdown: 'total', targetLevel, youtubeFilterLevels: [] });
    assert.ok(plan.ok);
    assert.equal(plan.shape.targetFilter, false);
    assert.equal(plan.shape.requestedRowLevel, targetLevel);
    assert.equal(plan.shape.partnerFilter, true);
    assert.deepEqual(reportFilters(plan.shape, { ...IDS, targetLevel }).map(filter => filter.type),
      ['FILTER_ADVERTISER', 'FILTER_PARTNER']);
  }
  const advertiser = planReport({ preset: 'youtube', breakdown: 'total', targetLevel: 'advertiser', youtubeFilterLevels: [] });
  assert.ok(advertiser.ok);
  assert.equal(advertiser.shape.requestedRowLevel, undefined);
});

test('the youtube fallback refuses a child breakdown with the exact message', () => {
  assert.deepEqual(planReport({ preset: 'youtube', breakdown: 'line_item', targetLevel: 'campaign', youtubeFilterLevels: [] }), {
    ok: false,
    problem: "YouTube reports can't be filtered to one campaign, so the youtube preset can't break it down further. Use a STANDARD preset (delivery, video) for that breakdown.",
  });
  assert.deepEqual(planReport({ preset: 'youtube', breakdown: 'line_item', targetLevel: 'insertionOrder', youtubeFilterLevels: ['campaign'] }), {
    ok: false,
    problem: "YouTube reports can't be filtered to one insertion order, so the youtube preset can't break it down further. Use a STANDARD preset (delivery, video) for that breakdown.",
  });
  // A verified level keeps its child breakdowns.
  assert.equal(planReport({ preset: 'youtube', breakdown: 'line_item', targetLevel: 'campaign', youtubeFilterLevels: ['campaign'] }).ok, true);
  // The advertiser is always filterable, so it never falls back.
  assert.equal(planReport({ preset: 'youtube', breakdown: 'line_item', targetLevel: 'advertiser', youtubeFilterLevels: [] }).ok, true);
});

test('other presets never use the YouTube fallback', () => {
  for (const preset of PRESET_NAMES.filter(name => name !== 'youtube')) {
    const plan = planReport({ preset, breakdown: 'total', targetLevel: 'lineItem', youtubeFilterLevels: [] });
    assert.ok(plan.ok);
    assert.equal(plan.shape.targetFilter, true);
    assert.equal(plan.shape.requestedRowLevel, undefined);
  }
});

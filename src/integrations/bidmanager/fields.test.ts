import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryParameters } from './client.js';
import {
  DIMENSIONS,
  METRICS,
  MULTI_ID_FILTER_TYPES,
  REPORT_TYPES,
  SCOPE_RULES,
  REQUIRED_DIMENSIONS,
  catalogFor,
  isReportType,
  validateReportFields,
  type FieldRequest,
  type ReportType,
} from './fields.js';

const FILTER_CODES = [
  'FILTER_PARTNER', 'FILTER_ADVERTISER', 'FILTER_MEDIA_PLAN', 'FILTER_INSERTION_ORDER', 'FILTER_LINE_ITEM',
];
const SHARED_DIMENSIONS = [
  'FILTER_DATE', 'FILTER_WEEK', 'FILTER_MONTH',
  'FILTER_PARTNER', 'FILTER_PARTNER_NAME', 'FILTER_ADVERTISER', 'FILTER_ADVERTISER_NAME',
  'FILTER_MEDIA_PLAN', 'FILTER_MEDIA_PLAN_NAME', 'FILTER_INSERTION_ORDER', 'FILTER_INSERTION_ORDER_NAME',
  'FILTER_LINE_ITEM', 'FILTER_LINE_ITEM_NAME',
];
const SHARED_CURRENCY_DIMENSIONS = ['FILTER_ADVERTISER_CURRENCY', 'FILTER_PARTNER_CURRENCY'];
const SHARED_BREAKDOWNS = ['FILTER_DEVICE_TYPE', 'FILTER_COUNTRY'];
const COMMON_METRICS = [
  'METRIC_IMPRESSIONS', 'METRIC_CLICKS', 'METRIC_CTR', 'METRIC_REVENUE_ADVERTISER', 'METRIC_REVENUE_USD',
];
const MEDIA_COST_METRICS = ['METRIC_MEDIA_COST_ADVERTISER', 'METRIC_MEDIA_COST_USD'];
const TOTAL_COST_METRICS = ['METRIC_TOTAL_MEDIA_COST_ADVERTISER', 'METRIC_TOTAL_MEDIA_COST_USD'];
const COMMON_RATE_METRICS = [
  'METRIC_REVENUE_ECPM_ADVERTISER', 'METRIC_REVENUE_ECPM_USD',
  'METRIC_REVENUE_ECPC_ADVERTISER', 'METRIC_REVENUE_ECPC_USD',
];
const VIEWABLE_RATE_METRICS = ['METRIC_REVENUE_VIEWABLE_ECPM_ADVERTISER', 'METRIC_REVENUE_VIEWABLE_ECPM_USD'];
const CONVERSION_METRICS = ['METRIC_TOTAL_CONVERSIONS', 'METRIC_LAST_IMPRESSIONS'];
const VIDEO_METRICS = [
  'METRIC_RICH_MEDIA_VIDEO_PLAYS', 'METRIC_RICH_MEDIA_VIDEO_FIRST_QUARTILE_COMPLETES',
  'METRIC_RICH_MEDIA_VIDEO_MIDPOINTS', 'METRIC_RICH_MEDIA_VIDEO_THIRD_QUARTILE_COMPLETES',
  'METRIC_RICH_MEDIA_VIDEO_COMPLETIONS', 'METRIC_VIDEO_COMPLETION_RATE',
];
const VIEWABILITY_METRICS = [
  'METRIC_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS', 'METRIC_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
  'METRIC_ACTIVE_VIEW_PCT_VIEWABLE_IMPRESSIONS',
];

// Live-verified snapshot (step-3 live checks, 2026-11-09). Every type's list reached DONE; YOUTUBE is
// the DV360-built reference report's field list (plan §7.8). Change only with new live evidence.
const EXPECTED_CATALOG: Record<ReportType, { dimensions: readonly string[]; filters: readonly string[]; metrics: readonly string[] }> = {
  STANDARD: {
    dimensions: [
      ...SHARED_DIMENSIONS, 'FILTER_CREATIVE_ID', 'FILTER_CREATIVE', ...SHARED_CURRENCY_DIMENSIONS,
      'FILTER_INVENTORY_SOURCE_ID', 'FILTER_INVENTORY_SOURCE_EXTERNAL_ID', 'FILTER_INVENTORY_SOURCE_NAME',
      'FILTER_SITE_ID', 'FILTER_APP_URL', 'FILTER_EXCHANGE', ...SHARED_BREAKDOWNS,
    ],
    filters: FILTER_CODES,
    metrics: [
      ...COMMON_METRICS, ...MEDIA_COST_METRICS, ...TOTAL_COST_METRICS, ...COMMON_RATE_METRICS,
      'METRIC_REVENUE_ECPA_ADVERTISER', 'METRIC_REVENUE_ECPA_USD', ...VIEWABLE_RATE_METRICS,
      ...CONVERSION_METRICS, 'METRIC_CM360_POST_VIEW_REVENUE', ...VIDEO_METRICS, ...VIEWABILITY_METRICS,
    ],
  },
  YOUTUBE: {
    dimensions: [
      'FILTER_ADVERTISER', 'FILTER_ADVERTISER_NAME', 'FILTER_MEDIA_PLAN', 'FILTER_MEDIA_PLAN_NAME',
      'FILTER_INSERTION_ORDER', 'FILTER_INSERTION_ORDER_NAME', 'FILTER_LINE_ITEM', 'FILTER_LINE_ITEM_NAME',
      'FILTER_TRUEVIEW_AD_GROUP_AD_ID', 'FILTER_TRUEVIEW_AD', 'FILTER_ADVERTISER_CURRENCY',
    ],
    // Campaign, insertion order, and line item ID filters verified live on 2026-11-16 (M6 step 2 probe).
    filters: FILTER_CODES,
    metrics: [
      ...COMMON_METRICS, ...MEDIA_COST_METRICS, 'METRIC_REVENUE_ECPC_USD', ...VIDEO_METRICS.slice(1),
      'METRIC_TRUEVIEW_VIEWS', 'METRIC_TRUEVIEW_VIEW_RATE', 'METRIC_TRUEVIEW_CPV_ADVERTISER', 'METRIC_TRUEVIEW_CPV_USD',
    ],
  },
  REACH: {
    dimensions: [...SHARED_DIMENSIONS, ...SHARED_CURRENCY_DIMENSIONS, ...SHARED_BREAKDOWNS],
    filters: FILTER_CODES,
    metrics: [
      ...COMMON_METRICS, ...TOTAL_COST_METRICS,
      'METRIC_UNIQUE_REACH_TOTAL_REACH', 'METRIC_UNIQUE_REACH_AVERAGE_IMPRESSION_FREQUENCY',
    ],
  },
};

const BASE_REQUEST: FieldRequest = {
  type: 'STANDARD', dimensions: ['FILTER_ADVERTISER'], metrics: ['METRIC_IMPRESSIONS'],
  filters: [{ type: 'FILTER_PARTNER', value: '123' }],
};

function problems(overrides: Partial<FieldRequest>): readonly string[] {
  const result = validateReportFields({ ...BASE_REQUEST, ...overrides });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected field validation to fail');
  return result.problems;
}

test('report types, scope, prerequisite, and alternatives settings match the live-verified snapshot', () => {
  assert.deepEqual(REPORT_TYPES, ['STANDARD', 'YOUTUBE', 'REACH']);
  assert.deepEqual(SCOPE_RULES, { STANDARD: 'none', YOUTUBE: 'one_partner', REACH: 'one_partner' });
  assert.deepEqual(REQUIRED_DIMENSIONS, {
    STANDARD: Object.fromEntries([
      'METRIC_REVENUE_ADVERTISER', 'METRIC_MEDIA_COST_ADVERTISER', 'METRIC_TOTAL_MEDIA_COST_ADVERTISER',
      'METRIC_REVENUE_ECPM_ADVERTISER', 'METRIC_REVENUE_ECPC_ADVERTISER', 'METRIC_REVENUE_ECPA_ADVERTISER',
      'METRIC_REVENUE_VIEWABLE_ECPM_ADVERTISER',
    ].map(code => [code, ['FILTER_ADVERTISER_CURRENCY']])),
    YOUTUBE: {
      METRIC_REVENUE_ADVERTISER: ['FILTER_ADVERTISER_CURRENCY'],
      METRIC_MEDIA_COST_ADVERTISER: ['FILTER_ADVERTISER_CURRENCY'],
      METRIC_TRUEVIEW_CPV_ADVERTISER: ['FILTER_ADVERTISER_CURRENCY'],
    },
    REACH: {
      METRIC_REVENUE_ADVERTISER: ['FILTER_ADVERTISER_CURRENCY'],
      METRIC_TOTAL_MEDIA_COST_ADVERTISER: ['FILTER_ADVERTISER_CURRENCY'],
    },
  });
  assert.deepEqual(MULTI_ID_FILTER_TYPES, ['STANDARD', 'YOUTUBE', 'REACH']);
});

test('catalog codes, memberships, names, and notes satisfy their invariants', () => {
  for (const [entries, pattern] of [[DIMENSIONS, /^FILTER_[A-Z0-9_]+$/], [METRICS, /^METRIC_[A-Z0-9_]+$/]] as const) {
    assert.equal(new Set(entries.map(entry => entry.code)).size, entries.length);
    for (const entry of entries) {
      assert.match(entry.code, pattern);
      assert.ok(entry.types.length > 0, entry.code);
      assert.deepEqual(entry.types, REPORT_TYPES.filter(type => entry.types.includes(type)), entry.code);
      assert.ok(entry.name.length > 0, entry.code);
      assert.equal(entry.name, entry.name.trim());
      if (Object.hasOwn(entry, 'note')) {
        assert.equal(typeof entry.note, 'string');
        assert.ok(entry.note && entry.note.trim().length > 0, entry.code);
      } else {
        assert.equal(entry.note, undefined);
      }
    }
  }
  for (const type of REPORT_TYPES) {
    const catalog = catalogFor(type);
    for (const entries of [catalog.dimensions, catalog.metrics]) {
      assert.equal(new Set(entries.map(entry => entry.name)).size, entries.length, type);
    }
  }
});

test('only the five ID dimensions have filter memberships and memberships use canonical order', () => {
  assert.deepEqual(DIMENSIONS.filter(entry => entry.filterTypes.length > 0).map(entry => entry.code), FILTER_CODES);
  for (const entry of DIMENSIONS) {
    assert.deepEqual(entry.filterTypes, REPORT_TYPES.filter(type => entry.filterTypes.includes(type)));
    // filterTypes are verified separately from grouping: YOUTUBE filters by partner without grouping by it.
  }
  for (const settings of [MULTI_ID_FILTER_TYPES]) {
    assert.equal(new Set(settings).size, settings.length);
    assert.ok(settings.every(type => REPORT_TYPES.includes(type)));
  }
});

for (const type of REPORT_TYPES) {
  test(`${type} catalog matches the live-verified membership snapshot in catalog order`, () => {
    const catalog = catalogFor(type);
    assert.deepEqual({
      dimensions: catalog.dimensions.map(entry => entry.code),
      filters: catalog.filters.map(entry => entry.code),
      metrics: catalog.metrics.map(entry => entry.code),
    }, EXPECTED_CATALOG[type]);
    assert.ok(catalog.dimensions.length && catalog.filters.length && catalog.metrics.length);
    assert.deepEqual(catalog.dimensions, DIMENSIONS.filter(entry => entry.types.includes(type)));
    assert.deepEqual(catalog.metrics, METRICS.filter(entry => entry.types.includes(type)));
    assert.deepEqual(catalog.filters, DIMENSIONS.filter(entry => entry.filterTypes.includes(type)));
    // Filters need not be groupable: YOUTUBE's partner filter is verified, grouping by partner is not.
  });
}

test('catalog state and each returned catalog array are frozen and entries retain identity', () => {
  for (const array of [DIMENSIONS, METRICS, REPORT_TYPES, SCOPE_RULES, REQUIRED_DIMENSIONS, MULTI_ID_FILTER_TYPES]) {
    assert.ok(Object.isFrozen(array));
  }
  for (const entry of [...DIMENSIONS, ...METRICS]) {
    assert.ok(Object.isFrozen(entry), entry.code);
    assert.ok(Object.isFrozen(entry.types), entry.code);
  }
  for (const entry of DIMENSIONS) assert.ok(Object.isFrozen(entry.filterTypes), entry.code);
  for (const type of REPORT_TYPES) {
    const first = catalogFor(type);
    const second = catalogFor(type);
    for (const key of ['dimensions', 'filters', 'metrics'] as const) {
      assert.ok(Object.isFrozen(first[key]));
      assert.notEqual(first[key], second[key]);
      assert.equal(first[key][0], second[key][0]);
    }
  }
});

test('money, rate, reach, and currency notes have the exact prescribed wording', () => {
  const expected = {
    METRIC_REVENUE_ADVERTISER: "Revenue billed to the client; not the same as media cost. In each advertiser's currency: never add across currencies; group by Advertiser Currency or use the USD version.",
    METRIC_MEDIA_COST_USD: 'What was paid for the media; not the same as revenue billed to the client. In US dollars, so it can be added across currencies.',
    METRIC_REVENUE_ECPM_ADVERTISER: "A rate: recompute it from its counts; never add or average it across rows. In each advertiser's currency; compare across currencies with the USD version.",
    METRIC_REVENUE_ECPM_USD: 'A rate: recompute it from its counts; never add or average it across rows. In US dollars.',
    METRIC_CTR: 'A rate: recompute it from its counts; never add or average it across rows.',
    METRIC_UNIQUE_REACH_TOTAL_REACH: 'Not additive: never add or average it across rows; run the report at the level you need instead.',
    FILTER_ADVERTISER_CURRENCY: 'Group by this before adding advertiser-currency money metrics.',
  };
  for (const [code, note] of Object.entries(expected)) {
    assert.equal([...DIMENSIONS, ...METRICS].find(entry => entry.code === code)?.note, note, code);
  }
  const impressions = METRICS.find(entry => entry.code === 'METRIC_IMPRESSIONS');
  assert.ok(impressions);
  assert.equal(Object.hasOwn(impressions, 'note'), false);
  for (const metric of METRICS) {
    if (metric.note?.includes('A rate: recompute it from its counts; never add or average it across rows.')) {
      assert.equal(metric.note.includes('can be added'), false, metric.code);
    }
  }
});

test('isReportType matches exact case-sensitive supported types', () => {
  for (const type of REPORT_TYPES) assert.equal(isReportType(type), true);
  for (const type of ['standard', '', 'UNIQUE_REACH_AUDIENCE', ' STANDARD']) assert.equal(isReportType(type), false);
});

test('successful validation copies frozen input in input order and drops extra filter properties', () => {
  const filter = Object.freeze({ type: 'FILTER_PARTNER', value: '000123', extra: 'omit me' });
  const request = Object.freeze({
    type: 'STANDARD',
    dimensions: Object.freeze(['FILTER_COUNTRY', 'FILTER_ADVERTISER']),
    metrics: Object.freeze(['METRIC_CLICKS', 'METRIC_IMPRESSIONS']),
    filters: Object.freeze([filter]),
  });
  const result = validateReportFields(request);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Expected successful validation');
  assert.deepEqual(result.params, {
    type: 'STANDARD', groupBys: ['FILTER_COUNTRY', 'FILTER_ADVERTISER'],
    metrics: ['METRIC_CLICKS', 'METRIC_IMPRESSIONS'], filters: [{ type: 'FILTER_PARTNER', value: '000123' }],
  });
  assert.notEqual(result.params.groupBys, request.dimensions);
  assert.notEqual(result.params.metrics, request.metrics);
  assert.notEqual(result.params.filters, request.filters);
  assert.notEqual(result.params.filters[0], filter);
  // This assignment is the compile-time compatibility check required by the plan.
  const params: QueryParameters = result.params;
  assert.equal(params, result.params);
});

test('omitted filters normalize to a new empty array when scope is not required', t => {
  const type = REPORT_TYPES.find(candidate => SCOPE_RULES[candidate] === 'none');
  if (!type) {
    t.skip('Every current type requires a scope filter; omitted filters are covered by the scope tests.');
    return;
  }
  const request = { type, dimensions: [catalogFor(type).dimensions[0].code], metrics: [catalogFor(type).metrics[0].code] };
  const result = validateReportFields(request);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.params.filters, []);
});

for (const type of REPORT_TYPES) {
  test(`${type} accepts all its catalog fields and one ID per supported filter`, () => {
    const catalog = catalogFor(type);
    const result = validateReportFields({
      type, dimensions: catalog.dimensions.map(entry => entry.code), metrics: catalog.metrics.map(entry => entry.code),
      filters: catalog.filters.map(entry => ({ type: entry.code, value: '123' })),
    });
    assert.equal(result.ok, true);
  });
}

test('unknown report type short-circuits all other invalid fields', () => {
  assert.deepEqual(problems({ type: 'standard', dimensions: [], metrics: [], filters: [{ type: 'bad', value: 'bad' }] }),
    ['Unknown report type "standard". Use STANDARD, YOUTUBE, or REACH.']);
});

test('empty dimensions and metrics report both non-empty requirements in order', () => {
  assert.deepEqual(problems({ dimensions: [], metrics: [] }), ['Add at least one dimension.', 'Add at least one metric.']);
});

for (const count of [2, 3]) {
  test(`${count} copies of a dimension and metric produce only one duplicate problem per code`, () => {
    assert.deepEqual(problems({
      dimensions: Array.from({ length: count }, () => 'FILTER_ADVERTISER'),
      metrics: Array.from({ length: count }, () => 'METRIC_IMPRESSIONS'),
    }), ['Dimension "FILTER_ADVERTISER" is listed more than once.', 'Metric "METRIC_IMPRESSIONS" is listed more than once.']);
  });
}

test('dimension and metric mixups, unknown codes, and wrong report types have precise messages', () => {
  assert.deepEqual(problems({
    dimensions: ['METRIC_IMPRESSIONS', 'FILTER_UNKNOWN', 'FILTER_TRUEVIEW_AD'],
    metrics: ['FILTER_ADVERTISER', 'METRIC_UNKNOWN', 'METRIC_TRUEVIEW_VIEWS'],
  }), [
    '"METRIC_IMPRESSIONS" is a metric, not a dimension.',
    'Unknown dimension "FILTER_UNKNOWN".',
    'Dimension "FILTER_TRUEVIEW_AD" is not available in STANDARD reports. It is available in YOUTUBE reports.',
    '"FILTER_ADVERTISER" is a dimension, not a metric.',
    'Unknown metric "METRIC_UNKNOWN".',
    'Metric "METRIC_TRUEVIEW_VIEWS" is not available in STANDARD reports. It is available in YOUTUBE reports.',
  ]);
});

test('repeated invalid fields report their first membership problem and one duplicate problem', () => {
  assert.deepEqual(problems({
    dimensions: ['unknown', 'unknown', 'unknown'], metrics: ['FILTER_DATE', 'FILTER_DATE', 'FILTER_DATE'],
  }), [
    'Unknown dimension "unknown".', 'Dimension "unknown" is listed more than once.',
    '"FILTER_DATE" is a dimension, not a metric.', 'Metric "FILTER_DATE" is listed more than once.',
  ]);
});

test('availability messages list multiple supported types in REPORT_TYPES order', () => {
  assert.deepEqual(problems({ type: 'REACH', metrics: ['METRIC_MEDIA_COST_USD'] }), [
    'Metric "METRIC_MEDIA_COST_USD" is not available in REACH reports. It is available in STANDARD, YOUTUBE reports.',
  ]);
});

test('filter membership checks precede value validation and preserve filter input order', () => {
  assert.deepEqual(problems({ filters: [
    ...BASE_REQUEST.filters!, { type: 'FILTER_UNKNOWN', value: 'bad' }, { type: 'FILTER_DATE', value: 'bad' },
  ] }), [
    'Unknown filter "FILTER_UNKNOWN".',
    'Filtering by "FILTER_DATE" is not supported. Filter by FILTER_PARTNER, FILTER_ADVERTISER, FILTER_MEDIA_PLAN, FILTER_INSERTION_ORDER, or FILTER_LINE_ITEM.',
  ]);
});

test('filters unavailable for the selected type report their supported types', t => {
  const entry = DIMENSIONS.find(candidate => candidate.filterTypes.length > 0 && candidate.filterTypes.length < REPORT_TYPES.length);
  if (!entry) {
    t.skip('Every ID filter supports all three types; no unavailable-filter case exists.');
    return;
  }
  const type = REPORT_TYPES.find(candidate => !entry.filterTypes.includes(candidate))!;
  assert.deepEqual(problems({ type, filters: [...BASE_REQUEST.filters!, { type: entry.code, value: '1' }] }), [
    `Filter "${entry.code}" is not available in ${type} reports. It is available in ${entry.filterTypes.join(', ')} reports.`,
  ]);
});

for (const value of ['', 'abc', '1'.repeat(21), '-1', '1.5', ' 123 ', '1\n']) {
  test(`invalid numeric ID ${JSON.stringify(value)} gets one safe filter value problem`, () => {
    assert.deepEqual(problems({ filters: [...BASE_REQUEST.filters!, { type: 'FILTER_ADVERTISER', value }] }),
      ['Filter "FILTER_ADVERTISER" needs a numeric ID.']);
  });
}

for (const value of ['0', '000123', '1'.repeat(20)]) {
  test(`numeric filter ID ${value} is accepted without number conversion`, () => {
    const result = validateReportFields({ ...BASE_REQUEST, filters: [{ type: 'FILTER_PARTNER', value }] });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.params.filters[0].value, value);
  });
}

for (const type of REPORT_TYPES) {
  test(`${type} rejects identical filter IDs before the alternatives restriction`, () => {
    assert.deepEqual(problems({ type, filters: [
      { type: 'FILTER_PARTNER', value: '123' }, { type: 'FILTER_PARTNER', value: '123' },
    ] }), ['Filter "FILTER_PARTNER" with the same ID is listed more than once.']);
  });
}

test('different filter IDs are accepted for a type with verified alternatives', t => {
  const type = MULTI_ID_FILTER_TYPES[0];
  if (!type) {
    t.skip('No type has verified alternatives before the authorized live check.');
    return;
  }
  const filter = catalogFor(type).filters.find(entry => entry.code !== 'FILTER_PARTNER');
  if (!filter) {
    t.skip('No non-partner filter supports an alternatives fixture for this type.');
    return;
  }
  assert.equal(validateReportFields({ ...BASE_REQUEST, type, filters: [
    { type: 'FILTER_PARTNER', value: '123' },
    { type: filter.code, value: '123' }, { type: filter.code, value: '456' },
  ] }).ok, true);
});

test('different filter IDs are rejected for a type without verified alternatives', t => {
  const type = REPORT_TYPES.find(candidate => !MULTI_ID_FILTER_TYPES.includes(candidate));
  if (!type) {
    t.skip('Every type has verified alternatives; the rejection branch has no catalog fixture.');
    return;
  }
  assert.deepEqual(problems({ type, filters: [
    { type: 'FILTER_PARTNER', value: '123' }, { type: 'FILTER_PARTNER', value: '456' },
  ] }), [`Filter "FILTER_PARTNER" can be used only once in ${type} reports.`]);
});

test('problems follow non-empty, dimension, filter, and scope rule ordering', () => {
  const type = REPORT_TYPES.find(candidate => SCOPE_RULES[candidate] === 'one_partner') ?? REPORT_TYPES[0];
  assert.deepEqual(problems({ type, dimensions: ['bad'], metrics: [], filters: [{ type: 'bad', value: 'bad' }] }), [
    'Add at least one metric.', 'Unknown dimension "bad".', 'Unknown filter "bad".',
    ...(SCOPE_RULES[type] === 'one_partner' ? [`${type} reports need exactly one FILTER_PARTNER filter.`] : []),
  ]);
});

test('diagnostics cut raw codes at 64 characters and JSON-escape quotes and newlines', () => {
  assert.deepEqual(problems({ dimensions: ['x'.repeat(65), 'quote"\n'] }), [
    `Unknown dimension "${'x'.repeat(64)}…".`, 'Unknown dimension "quote\\\"\\n".',
  ]);
  assert.deepEqual(problems({ dimensions: ['x'.repeat(64)] }), [`Unknown dimension "${'x'.repeat(64)}".`]);
});

test('problem cap preserves the first ten problems and counts omitted problems', () => {
  assert.deepEqual(problems({ dimensions: Array.from({ length: 15 }, (_, index) => `bad${index}`) }), [
    ...Array.from({ length: 10 }, (_, index) => `Unknown dimension "bad${index}".`), '…and 5 more problems.',
  ]);
});

test('exactly ten problems have no overflow entry and scope errors count toward overflow', () => {
  const dimensions = Array.from({ length: 10 }, (_, index) => `bad${index}`);
  const firstTen = dimensions.map(code => `Unknown dimension "${code}".`);
  assert.deepEqual(problems({ dimensions }), firstTen);
  const type = REPORT_TYPES.find(candidate => SCOPE_RULES[candidate] === 'one_partner');
  if (type) assert.deepEqual(problems({ type, dimensions, filters: [] }), [...firstTen, '…and 1 more problems.']);
});

test('field membership matching is case sensitive', () => {
  assert.deepEqual(problems({ dimensions: ['filter_date'] }), ['Unknown dimension "filter_date".']);
});

for (const type of REPORT_TYPES.filter(candidate => SCOPE_RULES[candidate] === 'one_partner')) {
  const message = `${type} reports need exactly one FILTER_PARTNER filter.`;
  test(`${type} requires a scope filter when filters are omitted`, () => {
    assert.deepEqual(problems({ type, filters: undefined }), [message]);
  });
  test(`${type} rejects non-numeric scope values and still reports missing scope`, () => {
    assert.deepEqual(problems({ type, filters: [{ type: 'FILTER_PARTNER', value: 'secret-value' }] }),
      ['Filter "FILTER_PARTNER" needs a numeric ID.', message]);
  });
  test(`${type} accepts a valid partner filter as scope`, () => {
    assert.equal(validateReportFields({ ...BASE_REQUEST, type }).ok, true);
  });
  test(`${type} advertiser-only filtering does not satisfy partner scope`, t => {
    if (!catalogFor(type).filters.some(entry => entry.code === 'FILTER_ADVERTISER')) {
      t.skip('Advertiser filtering was not retained for this type.');
      return;
    }
    assert.deepEqual(problems({ type, filters: [{ type: 'FILTER_ADVERTISER', value: '123' }] }), [message]);
  });
  test(`${type} non-scope filters do not satisfy scope`, t => {
    const filter = catalogFor(type).filters.find(entry => entry.code !== 'FILTER_PARTNER' && entry.code !== 'FILTER_ADVERTISER');
    if (!filter) {
      t.skip('No non-scope filter was retained for this type.');
      return;
    }
    assert.deepEqual(problems({ type, filters: [{ type: filter.code, value: '123' }] }), [message]);
  });
}


test('scope rules and nested prerequisite maps satisfy catalog invariants', () => {
  assert.deepEqual(Object.keys(SCOPE_RULES), REPORT_TYPES);
  assert.deepEqual(Object.keys(REQUIRED_DIMENSIONS), REPORT_TYPES);
  for (const type of REPORT_TYPES) {
    assert.ok(['none', 'one_partner'].includes(SCOPE_RULES[type]));
    const catalog = catalogFor(type);
    assert.ok(Object.isFrozen(REQUIRED_DIMENSIONS[type]));
    for (const [field, required] of Object.entries(REQUIRED_DIMENSIONS[type])) {
      assert.ok([...catalog.dimensions, ...catalog.metrics].some(entry => entry.code === field));
      assert.ok(Object.isFrozen(required));
      assert.equal(new Set(required).size, required.length);
      for (const code of required) {
        assert.notEqual(code, field);
        assert.ok(catalog.dimensions.some(entry => entry.code === code));
      }
    }
  }
});

test('five advertiser-currency names match the observed STANDARD CSV headers', () => {
  for (const [code, name] of Object.entries({
    METRIC_REVENUE_ADVERTISER: 'Revenue (Adv Currency)',
    METRIC_REVENUE_ECPM_ADVERTISER: 'Revenue eCPM (Adv Currency)',
    METRIC_REVENUE_ECPC_ADVERTISER: 'Revenue eCPC (Adv Currency)',
    METRIC_REVENUE_ECPA_ADVERTISER: 'Revenue eCPA (Adv Currency)',
    METRIC_REVENUE_VIEWABLE_ECPM_ADVERTISER: 'Revenue Viewable eCPM (Adv Currency)',
  })) assert.equal(METRICS.find(entry => entry.code === code)?.name, name);
});

test('required dimensions reject missing prerequisites and accept them when added', t => {
  const fixture = REPORT_TYPES.flatMap(type => Object.entries(REQUIRED_DIMENSIONS[type])
    .filter(([code]) => code.startsWith('METRIC_')).map(([code, required]) => ({ type, code, required })))[0];
  if (!fixture) {
    t.skip('No metric prerequisites have been established by the second live check yet.');
    return;
  }
  const { type, code, required } = fixture;
  const dimensions = catalogFor(type).dimensions.map(entry => entry.code).filter(value => !required.includes(value));
  assert.deepEqual(problems({ type, dimensions, metrics: [code] }), required.map(value =>
    `Add the dimension ${JSON.stringify(value)}: ${type} reports need it for ${JSON.stringify(code)}.`));
  assert.equal(validateReportFields({ ...BASE_REQUEST, type, dimensions: [...dimensions, ...required], metrics: [code] }).ok, true);
});


test('shared prerequisite emits one diagnostic with fields in input order', t => {
  for (const type of REPORT_TYPES) {
    const metrics = METRICS.filter(entry => entry.types.includes(type) && REQUIRED_DIMENSIONS[type][entry.code]?.length);
    for (const first of metrics) {
      const required = REQUIRED_DIMENSIONS[type][first.code][0];
      const second = metrics.find(entry => entry !== first && REQUIRED_DIMENSIONS[type][entry.code].includes(required));
      if (!second) continue;
      const dimensions = catalogFor(type).dimensions.map(entry => entry.code).filter(code => code !== required);
      assert.deepEqual(problems({ type, dimensions, metrics: [second.code, first.code] }), [
        `Add the dimension ${JSON.stringify(required)}: ${type} reports need it for ${JSON.stringify(second.code)}, ${JSON.stringify(first.code)}.`,
      ]);
      return;
    }
  }
  t.skip('No two verified metrics share a prerequisite yet.');
});

test('invalid fields do not produce prerequisite diagnostics', () => {
  assert.deepEqual(problems({ dimensions: ['METRIC_IMPRESSIONS'], metrics: ['FILTER_ADVERTISER'] }), [
    '"METRIC_IMPRESSIONS" is a metric, not a dimension.',
    '"FILTER_ADVERTISER" is a dimension, not a metric.',
  ]);
});

test('STANDARD permits advertiser-only filters without imposing partner scope', () => {
  assert.equal(validateReportFields({ ...BASE_REQUEST, filters: [{ type: 'FILTER_ADVERTISER', value: '123' }] }).ok, true);
});

test('STANDARD permits non-scope numeric filters without imposing partner scope', () => {
  assert.equal(validateReportFields({ ...BASE_REQUEST, filters: [{ type: 'FILTER_LINE_ITEM', value: '123' }] }).ok, true);
});

test('STANDARD still validates malformed filters when no scope is required', () => {
  assert.deepEqual(problems({ filters: [{ type: 'FILTER_PARTNER', value: 'invalid' }] }), [
    'Filter "FILTER_PARTNER" needs a numeric ID.',
  ]);
});

test('one-partner rules reject advertiser-only filters even with repeated valid IDs', () => {
  for (const type of REPORT_TYPES.filter(value => SCOPE_RULES[value] === 'one_partner')) {
    assert.ok(problems({ type, filters: [
      { type: 'FILTER_ADVERTISER', value: '123' }, { type: 'FILTER_ADVERTISER', value: '123' },
    ] }).includes(`${type} reports need exactly one FILTER_PARTNER filter.`));
  }
});

test('one-partner scope rejects two distinct valid partner IDs when alternatives are supported', t => {
  const type = MULTI_ID_FILTER_TYPES.find(value => SCOPE_RULES[value] === 'one_partner');
  if (!type) {
    t.skip('No one-partner report type has verified alternatives yet.');
    return;
  }
  assert.deepEqual(problems({ type, filters: [
    { type: 'FILTER_PARTNER', value: '123' }, { type: 'FILTER_PARTNER', value: '456' },
  ] }), [`${type} reports need exactly one FILTER_PARTNER filter.`]);
});


test('prerequisite diagnostics follow field problems and precede filter problems', () => {
  assert.deepEqual(problems({ dimensions: ['bad'], metrics: ['METRIC_REVENUE_ADVERTISER'], filters: [{ type: 'bad', value: 'bad' }] }), [
    'Unknown dimension "bad".',
    'Add the dimension "FILTER_ADVERTISER_CURRENCY": STANDARD reports need it for "METRIC_REVENUE_ADVERTISER".',
    'Unknown filter "bad".',
  ]);
});

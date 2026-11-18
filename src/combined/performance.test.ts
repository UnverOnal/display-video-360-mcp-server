import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPerformanceService, PERFORMANCE_BUDGET_MS, PREVIEW_ROWS, safeErrorMessage, type PerformanceDependencies, type PerformanceRequest } from './performance.js';
import { PRESETS, YOUTUBE_FILTER_LEVELS } from './presets.js';
import type { FindRequest, FindResult, DescribeRequest, DescribeResult } from '../integrations/dv360/metadata.js';
import type { AdHocReportRequest, CollectRequest, CollectResult, StartResult } from '../integrations/bidmanager/reporting.js';
import { safeErrorMessage as reportingError } from '../integrations/bidmanager/reporting.js';
import { BidManagerError } from '../integrations/bidmanager/errors.js';
import { Dv360Error } from '../integrations/dv360/errors.js';
import { ReportFileError, type ReportPage } from '../integrations/bidmanager/report-file.js';
import { GoogleCredentialsError } from '../integrations/google/auth.js';

const started = { ticket: { queryId: '100', reportId: '200' }, state: 'QUEUED' as const, title: 'synthetic', format: 'XLSX' as const, source: 'new' as const, warnings: [] };
const advertiser = { id: '1', name: 'Advertiser', status: 'active', partnerId: '9', currency: 'TRY' };
const findResult = (request: FindRequest): FindResult => ({ resource: request.resource, query: request.name, matches: [{ id: ({ advertiser: '1', campaign: '2', insertionOrder: '3', lineItem: '4', partner: '9' })[request.resource], name: request.name, status: 'active', kind: 'exact' }], totalMatches: 1, exactMatches: 1, searched: 1, complete: true, statusFilter: 'default', notes: [], warnings: [] });
function harness() {
  let clock = 0;
  const calls: { method: string; request: unknown }[] = [];
  const hooks = {
    find: async (request: FindRequest): Promise<FindResult> => findResult(request),
    describe: async (request: DescribeRequest): Promise<DescribeResult> => ({ advertiser, warnings: [], ...(request.target ? { target: { ...request.target, name: 'Target', status: 'active', summary: ['summary'], campaignId: '2', insertionOrderId: '3' } } : {}) }),
    start: async (_request: AdHocReportRequest): Promise<StartResult> => ({ ok: true, report: started }),
    collect: async (_request: CollectRequest): Promise<CollectResult> => ({ status: 'pending', ticket: started.ticket, state: 'RUNNING', waitedMs: 16_000 }),
  };
  const deps: PerformanceDependencies = {
    metadata: {
      async find(request) { calls.push({ method: 'find', request }); return hooks.find(request); },
      async describeTarget(request) { calls.push({ method: 'describe', request }); return hooks.describe(request); },
    },
    reporting: {
      async startAdHocReport(request) { calls.push({ method: 'start', request }); return hooks.start(request); },
      async collectReport(request) { calls.push({ method: 'collect', request }); return hooks.collect(request); },
    }, youtubeFilterLevels: YOUTUBE_FILTER_LEVELS, now: () => new Date(clock),
  };
  return { calls, hooks, deps, setTime: (ms: number) => { clock = ms; }, run: (request: PerformanceRequest = { advertiserId: '1' }, levels = YOUTUBE_FILTER_LEVELS) => createPerformanceService({ ...deps, youtubeFilterLevels: levels }).getPerformance(request) };
}
test('performance constants', () => { assert.equal(PERFORMANCE_BUDGET_MS, 90_000); assert.equal(PREVIEW_ROWS, 50); });
for (const level of ['advertiser', 'campaign', 'insertionOrder', 'lineItem'] as const) {
  test(`ID/name conflict ${level}`, async () => {
    const h = harness();
    assert.deepEqual(await h.run({ advertiserId: '1', [`${level}Id`]: '2', [`${level}Name`]: 'name' }), { kind: 'invalid', problems: [`Give either ${level}Id or ${level}Name, not both.`] });
    assert.deepEqual(h.calls, []);
  });
  test(`bad ${level} ID zero calls`, async () => {
    const h = harness(); const result = await h.run({ advertiserId: '1', [`${level}Id`]: 'bad' });
    assert.deepEqual(result, { kind: 'invalid', problems: ['IDs must be numeric.'] }); assert.deepEqual(h.calls, []);
  });
  for (const name of ['', '  ', 'x'.repeat(201)]) test(`bad ${level} name length ${name.length}`, async () => {
    const h = harness(); const result = await h.run({ ...(level === 'advertiser' ? {} : { advertiserId: '1' }), [`${level}Name`]: name });
    assert.deepEqual(result, { kind: 'invalid', problems: [name.trim() ? 'name must be at most 200 characters.' : 'name must not be empty.'] }); assert.deepEqual(h.calls, []);
  });
  test(`resolves ${level} by ID and by name`, async () => {
    for (const byName of [true, false]) {
      const h = harness(); const result = await h.run({ ...(level === 'advertiser' ? {} : { advertiserId: '1' }), [byName ? `${level}Name` : `${level}Id`]: byName ? 'Name' : level === 'advertiser' ? '1' : '4' });
      assert.equal(result.kind, 'report');
      assert.equal(h.calls.filter(c => c.method === 'find').length, byName ? 1 : 0);
      const find = h.calls.find(c => c.method === 'find')?.request as FindRequest | undefined;
      if (find) { assert.equal(find.deadline, 45_000); assert.equal(find.refresh, level === 'advertiser' ? 'no_exact' : undefined); }
    }
  });
}
test('missing advertiser and date errors collect locally', async () => {
  const h = harness(); assert.deepEqual(await h.run({ dateRange: {} }), { kind: 'invalid', problems: ['Give the advertiser: advertiserId, or advertiserName to search for it.', 'Give a date range: a preset, or both startDate and endDate.'] }); assert.deepEqual(h.calls, []);
});
for (const request of [{ advertiserId: '1', preset: 'youtube', breakdown: 'day' }, { advertiserId: '1', campaignId: '2', preset: 'youtube', breakdown: 'line_item' }, { advertiserId: '1', campaignId: '2', breakdown: 'campaign' }] as const) test(`local refusal ${JSON.stringify(request)}`, async () => {
  const h = harness(); assert.equal((await h.run(request, [])).kind, 'invalid'); assert.deepEqual(h.calls, []);
});
test('names resolve top down with narrowing and correlation', async () => {
  const h = harness(); const signal = new AbortController().signal;
  const result = await h.run({ advertiserName: ' Advertiser ', campaignName: 'Campaign', insertionOrderName: 'IO', lineItemName: 'Line', signal, callId: 'call' });
  assert.equal(result.kind, 'report');
  const requests = h.calls.filter(c => c.method === 'find').map(c => c.request as FindRequest);
  assert.deepEqual(requests.map(r => [r.resource, r.advertiserId, r.campaignId, r.insertionOrderId, r.refresh]), [['advertiser', undefined, undefined, undefined, 'no_exact'], ['campaign', '1', undefined, undefined, undefined], ['insertionOrder', '1', '2', undefined, undefined], ['lineItem', '1', '2', '3', undefined]]);
  assert.ok(requests.every(r => r.signal === signal && r.callId === 'call' && r.deadline === 45_000));
  const start = h.calls.find(c => c.method === 'start')!.request as AdHocReportRequest;
  assert.equal(start.deadline, 65_000); assert.equal(start.name, 'get_performance delivery total');
  assert.deepEqual(start.dateRange, { preset: 'LAST_7_DAYS' }); assert.equal(start.format, 'XLSX');
  assert.deepEqual(h.calls.map(c => c.method), ['find', 'find', 'find', 'find', 'describe', 'start', 'collect']);
});
for (const [complete, exactMatches, totalMatches, reason] of [[false, 1, 1, 'incomplete'], [true, 2, 2, 'ambiguous'], [true, 0, 2, 'ambiguous'], [true, 0, 0, 'none']] as const) test(`unresolved ${reason} exact=${exactMatches}`, async () => {
  const h = harness(); h.hooks.find = async request => ({ ...findResult(request), complete, exactMatches, totalMatches });
  const result = await h.run({ advertiserId: '1', campaignName: 'Campaign' });
  assert.equal(result.kind, 'unresolved');
  if (result.kind === 'unresolved') { assert.equal(result.reason, reason); assert.equal(result.parents.advertiserId, '1'); assert.equal(result.path[0].id, '1'); }
  assert.deepEqual(h.calls.map(c => c.method), ['find']);
});
test('unique partial is marked', async () => {
  const h = harness(); h.hooks.find = async request => ({ ...findResult(request), exactMatches: 0, matches: [{ ...findResult(request).matches[0], kind: 'prefix' }] });
  const result = await h.run({ advertiserName: 'Adv' }); assert.equal(result.kind, 'report'); if (result.kind === 'report') assert.equal(result.path[0].matched, 'prefix');
});
for (const preset of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) test(`describe before start ${preset} and scope`, async () => {
  const h = harness(); const result = await h.run({ advertiserId: '1', preset }); assert.equal(result.kind, 'report');
  assert.deepEqual(h.calls.map(c => c.method), ['describe', 'start', 'collect']);
  const request = h.calls[1].request as AdHocReportRequest;
  assert.equal(request.filters?.some(f => f.type === 'FILTER_PARTNER'), preset === 'youtube' || preset === 'reach');
});
for (const mismatch of ['campaign', 'insertionOrder'] as const) test(`parent consistency ${mismatch}`, async () => {
  const h = harness(); h.hooks.describe = async () => ({ advertiser, target: { resource: 'lineItem', id: '4', name: 'Line', status: 'active', summary: [], campaignId: '999', insertionOrderId: '999' }, warnings: [] });
  const result = await h.run({ advertiserId: '1', lineItemId: '4', ...(mismatch === 'campaign' ? { campaignId: '2' } : { insertionOrderId: '3' }) });
  assert.deepEqual(result, { kind: 'invalid', problems: [mismatch === 'campaign' ? 'The line item 4 is not in campaign 2.' : 'The line item 4 is not in insertion order 3.'] });
  assert.deepEqual(h.calls.map(c => c.method), ['describe']);
});
test('parent consistency is checked only when Google sent the parent field', async () => {
  const h = harness(); h.hooks.describe = async () => ({ advertiser, target: { resource: 'lineItem', id: '4', name: 'Line', status: 'active', summary: [] }, warnings: [] });
  const result = await h.run({ advertiserId: '1', lineItemId: '4', campaignId: '2', insertionOrderId: '3' });
  assert.equal(result.kind, 'report');
});
for (const preset of ['youtube', 'reach'] as const) for (const absent of [true, false]) test(`${preset} requires advertiser partner absent=${absent}`, async () => {
  const h = harness(); h.hooks.describe = async () => ({ ...(absent ? { advertiserProblem: 'unavailable' } : { advertiser: { ...advertiser, partnerId: undefined } }), warnings: [] });
  const result = await h.run({ advertiserId: '1', preset }); assert.equal(result.kind, 'invalid'); assert.deepEqual(h.calls.map(c => c.method), ['describe']);
});
test('standard tolerates absent advertiser and preserves warning', async () => {
  const h = harness(); h.hooks.describe = async () => ({ advertiserProblem: 'unavailable', warnings: [] });
  const result = await h.run(); assert.equal(result.kind, 'report'); if (result.kind === 'report') assert.deepEqual(result.warnings, ["The advertiser's details could not be read (unavailable); the report runs without them."]);
});
for (const time of [45_000, 74_000]) test(`completed lookup at ${time} does not describe`, async () => {
  const h = harness(); h.hooks.find = async request => { h.setTime(time); return findResult(request); };
  const result = await h.run({ advertiserName: 'Adv' }); assert.equal(result.kind, 'not_started'); assert.deepEqual(h.calls.map(c => c.method), ['find']);
});
test('second name lookup does not start at R', async () => {
  const h = harness(); h.hooks.find = async request => { h.setTime(45_000); return findResult(request); };
  assert.equal((await h.run({ advertiserName: 'Adv', campaignName: 'Camp' })).kind, 'not_started'); assert.equal(h.calls.length, 1);
});
for (const time of [50_000, 75_000]) test(`describe returning at ${time} does not start`, async () => {
  const h = harness(); h.hooks.describe = async () => { h.setTime(time); return { advertiser, warnings: [] }; };
  assert.equal((await h.run()).kind, 'not_started'); assert.deepEqual(h.calls.map(c => c.method), ['describe']);
});
for (const level of ['campaign', 'insertionOrder', 'lineItem'] as const) test(`youtube fallback and verified filter ${level}`, async () => {
  const h = harness();
  const request = { advertiserId: '1', [`${level}Id`]: '4', preset: 'youtube' as const };
  const result = await h.run(request, []); assert.equal(result.kind, 'report');
  if (result.kind === 'report') { assert.deepEqual(result.requestedRow, { level, id: '4' }); assert.equal(result.notes.length, 1); }
  const start = h.calls.find(c => c.method === 'start')!.request as AdHocReportRequest;
  assert.equal(start.filters?.length, 2);
  const current = await harness().run(request); assert.equal(current.kind, 'report'); if (current.kind === 'report') assert.equal(current.requestedRow, undefined);
});
for (const time of [0, 60_000, 70_000, 70_001, 90_000]) test(`remaining wait at ${time}`, async () => {
  const h = harness(); h.hooks.start = async () => { h.setTime(time); return { ok: true, report: started }; };
  const result = await h.run(); assert.equal(result.kind, 'report');
  const collect = h.calls.find(c => c.method === 'collect')?.request as CollectRequest | undefined;
  assert.equal(collect?.waitBudgetMs, time > 70_000 ? undefined : Math.min(20_000, 75_000 - time));
  if (collect) assert.equal(collect.limit, 50);
});
test('collect rejection preserves the ticket and safe warning', async () => {
  const h = harness(); h.hooks.collect = async () => { throw new Error('secret'); };
  const result = await h.run(); assert.equal(result.kind, 'report'); if (result.kind === 'report') { assert.deepEqual(result.started, started); assert.equal(result.collected, undefined); assert.equal(result.collectFailed, true); assert.equal(result.warnings[0], `The report started, but checking it failed (${reportingError(undefined)}). Call get_report with the ticket.`); }
});
test('start validation failure returned as invalid', async () => { const h = harness(); h.hooks.start = async () => ({ ok: false, problems: ['synthetic'] }); assert.deepEqual(await h.run(), { kind: 'invalid', problems: ['synthetic'] }); });
test('abort after resolution starts nothing else', async () => {
  const h = harness(); const controller = new AbortController(); const error = new Error('cancelled');
  h.hooks.find = async request => { controller.abort(error); return findResult(request); };
  await assert.rejects(h.run({ advertiserName: 'Adv', signal: controller.signal }), e => e === error);
  assert.deepEqual(h.calls.map(c => c.method), ['find']);
});
for (const rows of [undefined, 0, 1]) test(`YouTube line-item note rows=${rows}`, async () => {
  const h = harness(); const describe = h.hooks.describe; h.hooks.describe = async request => { const result = await describe(request); return { ...result, target: { ...result.target!, lineItemType: 'LINE_ITEM_TYPE_YOUTUBE_AND_PARTNERS_VIDEO' } }; };
  if (rows !== undefined) h.hooks.collect = async () => ({ status: 'done', ticket: started.ticket, format: 'XLSX', url: 'https://example.test', page: { totalRows: rows } as ReportPage });
  const result = await h.run({ advertiserId: '1', lineItemId: '4' }); assert.equal(result.kind, 'report'); if (result.kind === 'report') assert.deepEqual(result.notes, [rows === 0 ? 'This is a YouTube line item and this report has no rows for it; try the youtube preset.' : 'This is a YouTube line item; the youtube preset gives its views and view rate.']);
});
test('reach breakdown note', async () => { const result = await harness().run({ advertiserId: '1', preset: 'reach', breakdown: 'day' }); assert.equal(result.kind, 'report'); if (result.kind === 'report') assert.deepEqual(result.notes, ["Unique reach and frequency can't be added up across these rows; for the total, run breakdown total."]); });
for (const error of [new Dv360Error('server_error'), new BidManagerError('server_error'), new ReportFileError('malformed', 'Synthetic malformed file.'), new GoogleCredentialsError('unavailable'), new Error('secret')]) test(`safe combined error ${error.constructor.name}`, () => {
  assert.equal(safeErrorMessage(error), error.constructor === Error ? reportingError(undefined) : error.message);
});

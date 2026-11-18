import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReportingService, DATE_PRESETS, safeErrorMessage, toDataRange, type ReportingDependencies, type AdHocReportRequest } from './reporting.js';
import type { Query, Report } from './client.js';
import { BidManagerError } from './errors.js';
import { ReportFileError, type ReportPage } from './report-file.js';

const query: Query = { queryId: '123', metadata: { title: 'Synthetic', format: 'XLSX', dataRange: { range: 'PREVIOUS_DAY' } }, params: { groupBys: ['FILTER_ADVERTISER'], type: 'STANDARD', unknownOption: true } };
const report: Report = { key: { queryId: '123', reportId: '456' }, metadata: { status: { state: 'DONE', format: 'XLSX' }, googleCloudStoragePath: 'https://storage.googleapis.com/test-bucket/report.xlsx?Signature=TEST' }, params: query.params };
const page = { totalRows: 0 } as ReportPage;
const request: AdHocReportRequest = { type: 'STANDARD', dimensions: ['FILTER_ADVERTISER'], metrics: ['METRIC_IMPRESSIONS'], dateRange: { preset: 'PREVIOUS_DAY' } };
function harness() {
  let clock = Date.UTC(2026, 10, 11);
  const calls: [string, unknown?][] = [];
  const deps: { -readonly [K in keyof ReportingDependencies]: ReportingDependencies[K] } = {
    now: () => new Date(clock), random: () => 0,
    sleep: async ms => { calls.push(['sleep', ms]); clock += ms; },
    cleanup: { run: async () => { calls.push(['cleanup']); return { status: 'completed', deletedQueryIds: [], warnings: ['first', 'second'] }; } },
    client: {
      createQuery: async body => {
        calls.push(['create', body]);
        return { ...query, queryId: '789', metadata: body.metadata };
      },
      runQuery: async (id, body) => { calls.push(['run', { id, body }]); return report; },
      getQuery: async () => { calls.push(['query']); return query; },
      getReport: async () => { calls.push(['report']); return report; },
      listQueries: async options => { calls.push(['list', options]); return { queries: [query] }; },
      listReports: async () => assert.fail('listReports must not be called'),
    },
    readReportFile: async (req, options) => { calls.push(['read', { req, options }]); return page; },
  };
  return { deps, calls, advance: (ms: number) => { clock += ms; }, service: () => createReportingService(deps) };
}
for (const preset of DATE_PRESETS) test(`date preset ${preset}`, () => assert.deepEqual(toDataRange({ preset }), { ok: true, dataRange: { range: preset } }));
for (const [input, message] of [
  [{}, 'Give a date range: a preset, or both startDate and endDate.'],
  [{ preset: 'PREVIOUS_DAY', startDate: '2026-01-01' }, 'Use either a preset or startDate and endDate, not both.'],
  [{ startDate: '2026-01-01' }, 'Give both startDate and endDate.'],
  [{ endDate: '2026-01-01' }, 'Give both startDate and endDate.'],
  [{ startDate: '2027-02-29', endDate: '2027-03-01' }, 'startDate must be a real date written YYYY-MM-DD.'],
  [{ startDate: '1999-01-01', endDate: '2027-03-01' }, 'startDate must be a real date written YYYY-MM-DD.'],
  [{ startDate: '2026-01-01', endDate: '2026-13-01' }, 'endDate must be a real date written YYYY-MM-DD.'],
  [{ startDate: '2026-02-01', endDate: '2026-01-01' }, 'startDate must not be after endDate.'],
] as const) test(`date validation ${message} ${JSON.stringify(input)}`, () => assert.deepEqual(toDataRange(input), { ok: false, problem: message }));
test('leap date accepted', () => assert.deepEqual(toDataRange({ startDate: '2028-02-29', endDate: '2028-03-01' }), { ok: true, dataRange: { range: 'CUSTOM_DATES', customStartDate: { year: 2028, month: 2, day: 29 }, customEndDate: { year: 2028, month: 3, day: 1 } } }));
test('ad hoc exact body, run then cleanup', async () => {
  const h = harness();
  const result = await h.service().startAdHocReport(request);
  assert.deepEqual(h.calls, [
    ['create', {
      metadata: {
        title: '[MCP] STANDARD report 2026-11-11T00:00:00Z', format: 'XLSX',
        dataRange: { range: 'PREVIOUS_DAY' }, sendNotification: false,
      },
      params: {
        type: 'STANDARD', groupBys: ['FILTER_ADVERTISER'],
        metrics: ['METRIC_IMPRESSIONS'], filters: [],
      },
      schedule: { frequency: 'ONE_TIME' },
    }],
    ['run', { id: '789', body: undefined }], ['cleanup'],
  ]);
  assert.ok(result.ok); assert.deepEqual(result.report.warnings, ['first', 'second']); assert.equal(result.report.source, 'new');
});
test('date and field errors ordered with no client calls', async () => {
  const h = harness(); const result = await h.service().startAdHocReport({ ...request, dateRange: {}, metrics: ['bad'] });
  assert.ok(!result.ok); assert.equal(result.problems[0], 'Give a date range: a preset, or both startDate and endDate.'); assert.ok(result.problems.length > 1); assert.deepEqual(h.calls, []);
});
for (const stage of ['createQuery', 'runQuery'] as const) test(`${stage} failure propagates without cleanup`, async () => {
  const h = harness();
  const error = new BidManagerError('invalid_request', 'Synthetic rejection');
  h.deps.client[stage] = async () => { throw error; };
  await assert.rejects(h.service().startAdHocReport(request), error);
  assert.ok(!h.calls.some(([name]) => name === 'cleanup'));
  if (stage === 'createQuery') assert.ok(!h.calls.some(([name]) => name === 'run'));
});
for (const range of [undefined, { preset: 'LAST_7_DAYS' as const }]) test(`same-format saved run range=${!!range}`, async () => {
  const h = harness(); const result = await h.service().startSavedReport({ queryId: '123', dateRange: range });
  assert.ok(result.ok); assert.equal(result.report.source, 'saved'); assert.deepEqual(h.calls[1], ['run', { id: '123', body: range ? { dataRange: { range: 'LAST_7_DAYS' } } : undefined }]); assert.ok(!h.calls.some(([n]) => n === 'create'));
});
for (const format of ['CSV', undefined, 'FORMAT_UNSPECIFIED']) test(`saved format ${format} makes safe copy`, async () => {
  const h = harness();
  h.deps.client.getQuery = async () => ({
    ...query,
    metadata: {
      ...query.metadata, format,
      shareEmailAddress: ['synthetic@example.test'], sendNotification: true,
    },
    schedule: { frequency: 'DAILY' },
  });
  const result = await h.service().startSavedReport({ queryId: '123' });
  assert.ok(result.ok);
  assert.equal(result.report.source, 'saved_copy');
  assert.equal(result.report.copyReason, 'format');
  assert.equal(result.report.ticket.queryId, '789');
  assert.deepEqual(h.calls[0], ['create', {
    metadata: {
      title: '[MCP] Copy of Synthetic 2026-11-11T00:00:00Z',
      dataRange: query.metadata.dataRange, format: 'XLSX', sendNotification: false,
    },
    params: query.params, schedule: { frequency: 'ONE_TIME' },
  }]);
  assert.deepEqual(h.calls[1], ['run', { id: '789', body: undefined }]);
  assert.ok(!h.calls.some(([name, args]) => name === 'run' && (args as {id: string}).id === '123'));
});
for (const metadata of [
  { sendNotification: true },
  { sendNotification: false, shareEmailAddress: ['synthetic@example.test'] },
]) test(`same-format notifying saved query runs a silent copy ${JSON.stringify(metadata)}`, async () => {
  const h = harness();
  h.deps.client.getQuery = async () => ({
    ...query,
    metadata: { ...query.metadata, ...metadata },
    schedule: { frequency: 'DAILY' },
  });
  const result = await h.service().startSavedReport({ queryId: '123' });
  assert.ok(result.ok);
  assert.equal(result.report.source, 'saved_copy');
  assert.equal(result.report.copyReason, 'notifications');
  assert.equal(result.report.savedQueryId, '123');
  assert.equal(result.report.ticket.queryId, '789');
  assert.deepEqual(h.calls[0], ['create', {
    metadata: {
      title: '[MCP] Copy of Synthetic 2026-11-11T00:00:00Z',
      dataRange: query.metadata.dataRange,
      format: 'XLSX', sendNotification: false,
    },
    params: query.params,
    schedule: { frequency: 'ONE_TIME' },
  }]);
  assert.deepEqual(h.calls.filter(([name]) => name === 'run'), [
    ['run', { id: '789', body: undefined }],
  ]);
});
test('same-format saved query with disabled notifications and no recipients runs original', async () => {
  const h = harness();
  h.deps.client.getQuery = async () => ({
    ...query,
    metadata: { ...query.metadata, sendNotification: false, shareEmailAddress: [] },
  });
  const result = await h.service().startSavedReport({ queryId: '123' });
  assert.ok(result.ok);
  assert.equal(result.report.source, 'saved');
  assert.equal(result.report.copyReason, undefined);
  assert.equal(result.report.ticket.queryId, '123');
  assert.deepEqual(h.calls.filter(([name]) => name === 'run'), [
    ['run', { id: '123', body: undefined }],
  ]);
  assert.ok(!h.calls.some(([name]) => name === 'create'));
});
for (const missing of ['params', 'range']) test(`copy rejects missing ${missing}`, async () => {
  const h = harness(); h.deps.client.getQuery = async () => ({ ...query, params: missing === 'params' ? undefined : query.params, metadata: { ...query.metadata, format: 'CSV', dataRange: missing === 'range' ? undefined : query.metadata.dataRange } });
  await assert.rejects(h.service().startSavedReport({ queryId: '123' }), { kind: 'unexpected_response' });
});
test('done reads file with exact settings', async () => {
  const h = harness(); assert.equal((await h.service().collectReport({ queryId: '123', reportId: '456' })).status, 'done');
  assert.deepEqual(h.calls[1], ['read', { req: { url: report.metadata.googleCloudStoragePath, format: 'XLSX', dimensionCount: 1, offset: 0, limit: 200 }, options: { timeoutMs: 20000 } }]);
});
for (const state of ['RUNNING', 'QUEUED', 'STATE_UNSPECIFIED'] as const) test(`${state} polls at most four times`, async () => {
  const h = harness(); h.deps.client.getReport = async () => { h.calls.push(['report']); return { ...report, metadata: { status: { state } } }; };
  const result = await h.service().collectReport({ queryId: '123', reportId: '456' }); assert.equal(result.status, 'pending'); assert.equal(h.calls.filter(([n]) => n === 'report').length, 4); assert.deepEqual(h.calls.filter(([n]) => n === 'sleep').map(([,v]) => v), [5000, 10000, 20000]);
});
for (const fallback of [false, true]) test(`late DONE defers without further requests fallback=${fallback}`, async () => {
  const h = harness(); h.deps.client.getReport = async () => { h.advance(41000); return { ...report, params: fallback ? undefined : report.params }; };
  const result = await h.service().collectReport({ queryId: '123', reportId: '456' }); assert.ok(result.status === 'done_no_preview'); assert.equal(result.reason, 'deferred'); assert.deepEqual(h.calls, []);
});
test('fallback query crosses deadline then defers', async () => {
  const h = harness(); h.deps.client.getReport = async () => { h.advance(30000); return { ...report, params: undefined }; }; h.deps.client.getQuery = async () => { h.advance(20000); return query; };
  const result = await h.service().collectReport({ queryId: '123', reportId: '456' }); assert.ok(result.status === 'done_no_preview'); assert.equal(result.reason, 'deferred'); assert.deepEqual(h.calls, []);
});
for (const status of [400, 401, 403, 404, 410, 429, 500]) test(`file HTTP ${status} controls link visibility`, async () => {
  const h = harness(); h.deps.readReportFile = async () => { throw new ReportFileError('download_failed', 'synthetic', { httpStatus: status }); };
  const result = await h.service().collectReport({ queryId: '123', reportId: '456' }); assert.ok(result.status === 'done_no_preview'); assert.equal(!!result.url, ![400,401,403,404,410].includes(status));
});
for (const [field, value] of [['offset', -1], ['offset', 0.5], ['limit', 0], ['limit', 201]] as const) test(`invalid ${field}=${value} no calls`, async () => {
  const h = harness(); await assert.rejects(h.service().collectReport({ queryId: '123', reportId: '456', [field]: value }), { kind: 'invalid_request' }); assert.deepEqual(h.calls, []);
});
for (const [title, search] of [['INSERTION', 'insertion'], ['İstanbul', 'istanbul'], ['IŞIK', 'ışık']]) test(`folded title ${title}`, async () => {
  const h = harness(); h.deps.client.listQueries = async () => ({ queries: [{ ...query, metadata: { title } }] });
  assert.equal((await h.service().listSavedQueries({ titleContains: ` ${search} ` })).queries.length, 1);
});
test('whole page continuation loses no matches', async () => {
  const h = harness(); const pages = (prefix: string) => Array.from({ length: 60 }, (_, i) => ({ ...query, queryId: `${prefix}${i}` }));
  h.deps.client.listQueries = async options => ({ queries: pages(options?.pageToken ? '2' : '1'), ...(options?.pageToken ? {} : { nextPageToken: 'next' }) });
  const service = h.service(); const first = await service.listSavedQueries({}); assert.equal(first.queries.length, 60); assert.equal(first.nextPageToken, 'next');
  const next = await service.listSavedQueries({ pageToken: first.nextPageToken }); assert.equal(next.queries.length, 60); assert.equal(next.nextPageToken, undefined); assert.notEqual(first.queries[0].queryId, next.queries[0].queryId);
});
test('unknown errors are redacted and known errors retain message', () => {
  assert.ok(!safeErrorMessage(new Error('https://storage.googleapis.com/secret')).includes('secret'));
  assert.equal(safeErrorMessage(new BidManagerError('invalid_request', 'synthetic')), 'synthetic');
});
test('RUNNING becomes DONE after one jittered wait', async () => {
  const h = harness(); let checks = 0; h.deps.random = () => 0.5;
  h.deps.client.getReport = async () => ++checks === 1 ? { ...report, metadata: { status: { state: 'RUNNING' } } } : report;
  assert.equal((await h.service().collectReport({ queryId: '123', reportId: '456' })).status, 'done'); assert.deepEqual(h.calls[0], ['sleep', 5500]); assert.equal(checks, 2);
});
test('slow status calls stop the next sleep', async () => {
  const h = harness(); let checks = 0; h.deps.client.getReport = async () => { checks++; h.advance(25000); return { ...report, metadata: { status: { state: 'RUNNING' } } }; };
  const result = await h.service().collectReport({ queryId: '123', reportId: '456' }); assert.equal(result.status, 'pending'); assert.equal(checks, 2); assert.deepEqual(h.calls, [['sleep', 5000]]);
});
for (const during of [false, true]) test(`abort ${during ? 'during sleep' : 'before wait'} stops polling`, async () => {
  const h = harness(); const controller = new AbortController(); let checks = 0;
  h.deps.client.getReport = async () => { checks++; return { ...report, metadata: { status: { state: 'RUNNING' } } }; };
  h.deps.sleep = async () => { controller.abort(); }; if (!during) controller.abort();
  assert.equal((await h.service().collectReport({ queryId: '123', reportId: '456', signal: controller.signal })).status, 'pending'); assert.equal(checks, 1);
});
test('FAILED never reads file', async () => {
  const h = harness(); h.deps.client.getReport = async () => ({ ...report, metadata: { status: { state: 'FAILED' } } }); assert.equal((await h.service().collectReport({ queryId: '123', reportId: '456' })).status, 'failed'); assert.deepEqual(h.calls, []);
});
for (const missing of ['format', 'url', 'dimensions']) test(`malformed report missing ${missing}`, async () => {
  const h = harness(); h.deps.client.getReport = async () => ({ ...report, params: missing === 'dimensions' ? undefined : report.params, metadata: { status: { state: 'DONE', format: missing === 'format' ? 'PDF' : 'XLSX' }, googleCloudStoragePath: missing === 'url' ? undefined : report.metadata.googleCloudStoragePath } });
  if (missing === 'dimensions') h.deps.client.getQuery = async () => ({ ...query, params: undefined });
  await assert.rejects(h.service().collectReport({ queryId: '123', reportId: '456' }), { kind: 'unexpected_response' });
});
test('fallback supplies dimension count and report type', async () => {
  const h = harness(); h.deps.client.getReport = async () => ({ ...report, params: undefined });
  const result = await h.service().collectReport({ queryId: '123', reportId: '456' }); assert.equal(result.status, 'done'); assert.equal(result.reportType, 'STANDARD'); assert.equal(h.calls[0][0], 'query');
});
for (const kind of ['invalid_link', 'invalid_request', 'timeout', 'network', 'too_large', 'malformed'] as const) test(`reader ${kind} becomes no preview`, async () => {
  const h = harness(); h.deps.readReportFile = async () => { throw new ReportFileError(kind, 'synthetic'); };
  const result = await h.service().collectReport({ queryId: '123', reportId: '456' }); assert.ok(result.status === 'done_no_preview'); assert.equal(result.reason, kind); assert.equal(!!result.url, kind !== 'invalid_link');
});
test('unknown reader error propagates', async () => {
  const h = harness(); const error = new Error('synthetic'); h.deps.readReportFile = async () => { throw error; }; await assert.rejects(h.service().collectReport({ queryId: '123', reportId: '456' }), error);
});
for (const failure of [false, true]) test(`read counter released after ${failure ? 'failure' : 'success'}`, async () => {
  const h = harness(); const releases: (() => void)[] = [];
  h.deps.readReportFile = async () => { await new Promise<void>(resolve => releases.push(resolve)); if (failure) throw new ReportFileError('network', 'synthetic'); return page; };
  const service = h.service(); const args = { queryId: '123', reportId: '456' };
  const first = service.collectReport(args); const second = service.collectReport(args); await new Promise(resolve => setImmediate(resolve));
  const busy = await service.collectReport(args); assert.ok(busy.status === 'done_no_preview'); assert.equal(busy.reason, 'busy'); releases.splice(0).forEach(resolve => resolve()); await Promise.all([first, second]);
  const third = service.collectReport(args); await new Promise(resolve => setImmediate(resolve)); assert.equal(releases.length, 1); releases[0](); await third;
});
test('MCP queries excluded by default, included on request', async () => {
  const h = harness(); h.deps.client.listQueries = async () => ({ queries: [{ ...query, metadata: { title: '[MCP] synthetic' } }] }); const service = h.service(); assert.equal((await service.listSavedQueries({})).queries.length, 0); assert.equal((await service.listSavedQueries({ includeMcp: true })).queries.length, 1);
});
test('listing has three-page bound and preserves final token', async () => {
  const h = harness(); let calls = 0; h.deps.client.listQueries = async () => ({ queries: [], nextPageToken: `token-${++calls}` }); assert.deepEqual(await h.service().listSavedQueries({ titleContains: '  ' }), { queries: [], pagesRead: 3, nextPageToken: 'token-3' }); assert.equal(calls, 3);
});
test('listing cleans and cuts titles and drops non-string optional fields', async () => {
  const h = harness(); h.deps.client.listQueries = async () => ({ queries: [{ queryId: '123', metadata: { title: '\n' + 'x'.repeat(150), format: 3 as unknown as string }, params: { type: 42 as unknown as string } }] });
  const [result] = (await h.service().listSavedQueries({})).queries; assert.deepEqual(result, { queryId: '123', title: ' ' + 'x'.repeat(118) + '…' });
});
test('saved validation and 404 stop the start', async () => {
  const h = harness(); assert.equal((await h.service().startSavedReport({ queryId: '123', dateRange: {} })).ok, false); assert.deepEqual(h.calls, []);
  h.deps.client.getQuery = async () => { throw new BidManagerError('not_found'); }; await assert.rejects(h.service().startSavedReport({ queryId: '123' }), { kind: 'not_found' });
});
test('skipped cleanup adds no warnings', async () => {
  const h = harness(); h.deps.cleanup = { run: async () => ({ status: 'skipped', deletedQueryIds: [], warnings: [] }) };
  const result = await h.service().startAdHocReport(request); assert.ok(result.ok); assert.deepEqual(result.report.warnings, []);
});
test('done at 39 seconds still reads file', async () => {
  const h = harness(); h.deps.client.getReport = async () => { h.advance(39000); return report; }; assert.equal((await h.service().collectReport({ queryId: '123', reportId: '456' })).status, 'done'); assert.equal(h.calls[0][0], 'read');
});
test('saved copy uses explicit range instead of saved range', async () => {
  const h = harness(); h.deps.client.getQuery = async () => ({ ...query, metadata: { ...query.metadata, format: 'CSV' } });
  await h.service().startSavedReport({ queryId: '123', dateRange: { preset: 'LAST_30_DAYS' } });
  assert.equal((h.calls[0][1] as { metadata: { dataRange: { range: string } } }).metadata.dataRange.range, 'LAST_30_DAYS');
});

// --- Step 2: queries.run recovery, deadlines and call options ---

const RECOVERED_WARNING = 'Google did not confirm the start in time; this report was found by looking it up.';
const RECOVERED_SAVED_WARNING = 'Google did not confirm the start in time; this is the report now running for the saved query (it may be one someone else started).';
const NOT_STARTED_MESSAGE = 'Google did not confirm that the report started, and no report was found for it. Starting it again is safe.';
const MAY_HAVE_STARTED_MESSAGE = 'Google did not confirm that the report started, and this could not be checked. It may still be running: wait a few minutes before starting it again, to avoid running it twice.';
const START_MS = Date.UTC(2026, 10, 11);

function reportWith(reportId: string, state: Report['metadata']['status']['state'], queryId = '789'): Report {
  return { key: { queryId, reportId }, metadata: { status: { state } } };
}

function recovery(runError: unknown, lookup: () => Promise<{ reports: readonly Report[] }>) {
  const h = harness();
  const lookups: unknown[][] = [];
  h.deps.client.runQuery = async () => { throw runError; };
  h.deps.client.listReports = async (...args: unknown[]) => { lookups.push(args); return lookup(); };
  return { h, lookups };
}

function ambiguous(kind: 'timeout' | 'network' | 'server_error') {
  return new BidManagerError(kind, undefined, { httpStatus: kind === 'server_error' ? 503 : undefined, reasons: [], legacyReasons: [] });
}

function sameKindWith(original: BidManagerError, message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BidManagerError);
    assert.notEqual(error, original);
    assert.equal(error.kind, original.kind);
    assert.equal(error.message, message);
    assert.deepEqual(error.diagnostics, original.diagnostics);
    return true;
  };
}

for (const kind of ['timeout', 'network', 'server_error'] as const) {
  test(`recovery (fresh query, ${kind}): a found report is used with the recovered warning`, async () => {
    const found = reportWith('999', 'RUNNING');
    const { h, lookups } = recovery(ambiguous(kind), async () => ({ reports: [found, reportWith('998', 'DONE')] }));
    const signal = new AbortController().signal;
    const result = await h.service().startAdHocReport({ ...request, signal });
    assert.ok(result.ok);
    assert.deepEqual(result.report.ticket, { queryId: '789', reportId: '999' });
    assert.equal(result.report.state, 'RUNNING');
    assert.deepEqual(result.report.warnings, [RECOVERED_WARNING, 'first', 'second']);
    assert.deepEqual(lookups, [['789', { pageSize: 10 }, { signal, singleAttempt: true, timeoutMs: 10_000 }]]);
    assert.ok(h.calls.some(([name]) => name === 'cleanup'));
  });
}

test('recovery (fresh query): no report found means it did not start', async () => {
  const original = ambiguous('timeout');
  const { h } = recovery(original, async () => ({ reports: [] }));
  await assert.rejects(h.service().startAdHocReport(request), sameKindWith(original, NOT_STARTED_MESSAGE));
  assert.ok(!h.calls.some(([name]) => name === 'cleanup'));
});

test('recovery (fresh query): a failed lookup means it may have started', async () => {
  const original = ambiguous('server_error');
  const { h } = recovery(original, async () => { throw new BidManagerError('timeout'); });
  await assert.rejects(h.service().startAdHocReport(request), sameKindWith(original, MAY_HAVE_STARTED_MESSAGE));
});

test('recovery (fresh query): a saved copy uses the same lookup on the copy', async () => {
  const { h, lookups } = recovery(ambiguous('network'), async () => ({ reports: [reportWith('999', 'QUEUED')] }));
  h.deps.client.getQuery = async () => ({ ...query, metadata: { ...query.metadata, format: 'CSV' } });
  const result = await h.service().startSavedReport({ queryId: '123' });
  assert.ok(result.ok);
  assert.equal(result.report.source, 'saved_copy');
  assert.deepEqual(result.report.ticket, { queryId: '789', reportId: '999' });
  assert.deepEqual(result.report.warnings, [RECOVERED_WARNING, 'first', 'second']);
  assert.deepEqual(lookups[0].slice(0, 2), ['789', { pageSize: 10 }]);
});

for (const runError of [new BidManagerError('invalid_request'), new BidManagerError('rate_limited'), new BidManagerError('daily_limit'), new Error('x')]) {
  test(`recovery is skipped for a non-ambiguous run error (${runError instanceof BidManagerError ? runError.kind : 'plain Error'})`, async () => {
    const { h, lookups } = recovery(runError, async () => assert.fail('no lookup'));
    await assert.rejects(h.service().startAdHocReport(request), error => error === runError);
    await assert.rejects(h.service().startSavedReport({ queryId: '123' }), error => error === runError);
    assert.equal(lookups.length, 0);
  });
}

test('recovery (saved in place): exactly one unfinished report is used with the saved warning', async () => {
  const running = reportWith('900', 'RUNNING', '123');
  const { h, lookups } = recovery(ambiguous('timeout'),
    async () => ({ reports: [reportWith('901', 'DONE', '123'), running, reportWith('800', 'FAILED', '123')] }));
  const signal = new AbortController().signal;
  const result = await h.service().startSavedReport({ queryId: '123', signal });
  assert.ok(result.ok);
  assert.equal(result.report.source, 'saved');
  assert.deepEqual(result.report.ticket, { queryId: '123', reportId: '900' });
  assert.deepEqual(result.report.warnings, [RECOVERED_SAVED_WARNING, 'first', 'second']);
  assert.deepEqual(lookups, [['123', { pageSize: 10, orderBy: 'key.reportId desc' }, { signal, singleAttempt: true, timeoutMs: 10_000 }]]);
});

for (const [name, lookup] of [
  ['two unfinished reports', async () => ({ reports: [reportWith('901', 'QUEUED', '123'), reportWith('900', 'RUNNING', '123')] })],
  ['only finished reports', async () => ({ reports: [reportWith('901', 'DONE', '123'), reportWith('900', 'FAILED', '123')] })],
  ['no reports', async () => ({ reports: [] })],
  ['a 400 from the lookup', async () => { throw new BidManagerError('invalid_request', undefined, { httpStatus: 400, reasons: [], legacyReasons: [] }); }],
] as const) {
  test(`recovery (saved in place): ${name} means it may have started`, async () => {
    const original = ambiguous('server_error');
    const { h } = recovery(original, lookup);
    await assert.rejects(h.service().startSavedReport({ queryId: '123' }), sameKindWith(original, MAY_HAVE_STARTED_MESSAGE));
  });
}

function recordCalls(h: ReturnType<typeof harness>) {
  const options: [string, unknown][] = [];
  const { client } = h.deps;
  const createQuery = client.createQuery; const runQuery = client.runQuery; const getQuery = client.getQuery;
  const getReport = client.getReport; const listQueries = client.listQueries;
  h.deps.client = {
    ...client,
    createQuery: async (body, call) => { options.push(['create', call]); return createQuery(body); },
    runQuery: async (id, body, call) => { options.push(['run', call]); return runQuery(id, body); },
    getQuery: async (id, call) => { options.push(['query', call]); return getQuery(id); },
    getReport: async (queryId, reportId, call) => { options.push(['report', call]); return getReport(queryId, reportId); },
    listQueries: async (listOptions, call) => { options.push(['list', call]); return listQueries(listOptions); },
  };
  const run = h.deps.cleanup.run;
  h.deps.cleanup = { run: async call => { options.push(['cleanup', call]); return run(); } };
  return options;
}

test('start methods pass { signal, deadline: start + 45 s } to every client call and to cleanup', async () => {
  const signal = new AbortController().signal;
  const expected = { signal, deadline: START_MS + 45_000 };
  for (const start of [
    (h: ReturnType<typeof harness>) => h.service().startAdHocReport({ ...request, signal }),
    (h: ReturnType<typeof harness>) => h.service().startSavedReport({ queryId: '123', signal }),
    (h: ReturnType<typeof harness>) => h.service().startSavedReport({ queryId: '123', format: 'CSV', signal }),
  ]) {
    const h = harness();
    const options = recordCalls(h);
    assert.ok((await start(h)).ok);
    assert.ok(options.length >= 3);
    for (const [name, call] of options) assert.deepEqual(call, expected, name);
  }
});

test('listSavedQueries passes { signal, deadline: start + 45 s } to every page', async () => {
  const h = harness();
  const options = recordCalls(h);
  let pages = 0;
  const listQueries = h.deps.client.listQueries;
  h.deps.client.listQueries = async (listOptions, call) => { await listQueries(listOptions, call); return { queries: [], ...(++pages < 3 ? { nextPageToken: `t${pages}` } : {}) }; };
  const signal = new AbortController().signal;
  await h.service().listSavedQueries({ signal });
  assert.deepEqual(options, Array.from({ length: 3 }, () => ['list', { signal, deadline: START_MS + 45_000 }]));
});

test('collectReport bounds every poll and the getQuery fallback by their 40 s budgets', async () => {
  const h = harness();
  const options = recordCalls(h);
  let polls = 0;
  const getReport = h.deps.client.getReport;
  h.deps.client.getReport = async (queryId, reportId, call) => {
    await getReport(queryId, reportId, call);
    return ++polls < 2 ? { ...report, metadata: { status: { state: 'RUNNING' } } } : { ...report, params: { type: 'STANDARD' } };
  };
  const signal = new AbortController().signal;
  const result = await h.service().collectReport({ queryId: '123', reportId: '456', signal });
  assert.equal(result.status, 'done');
  assert.deepEqual(options, [
    ['report', { signal, deadline: START_MS + 40_000 }],
    ['report', { signal, deadline: START_MS + 40_000 }],
    ['query', { signal, deadline: START_MS + 40_000 }],
  ]);
});

// M5 step 3: correlation must survive every independently built options object.
test('callId reaches both starts, saved copies, and cleanup', async () => {
  const signal = new AbortController().signal;
  const callId = '0123456789abcdef';
  for (const start of [
    (h: ReturnType<typeof harness>) => h.service().startAdHocReport({ ...request, signal, callId }),
    (h: ReturnType<typeof harness>) => h.service().startSavedReport({ queryId: '123', signal, callId }),
    (h: ReturnType<typeof harness>) => h.service().startSavedReport({ queryId: '123', format: 'CSV', signal, callId }),
  ]) {
    const h = harness();
    const options = recordCalls(h);
    assert.ok((await start(h)).ok);
    assert.ok(options.length >= 3);
    for (const [name, call] of options) assert.deepEqual(call, { signal, deadline: START_MS + 45_000, callId }, name);
  }
});

test('callId reaches every poll, grouping fallback, and saved-list page', async () => {
  const h = harness();
  const options = recordCalls(h);
  const callId = '0123456789abcdef';
  let polls = 0;
  const getReport = h.deps.client.getReport;
  h.deps.client.getReport = async (queryId, reportId, call) => {
    await getReport(queryId, reportId, call);
    return ++polls === 1 ? { ...report, metadata: { status: { state: 'RUNNING' } } } : { ...report, params: undefined };
  };
  let pages = 0;
  const listQueries = h.deps.client.listQueries;
  h.deps.client.listQueries = async (args, call) => {
    await listQueries(args, call);
    return { queries: [], ...(++pages < 3 ? { nextPageToken: `t${pages}` } : {}) };
  };
  const service = h.service();
  assert.equal((await service.collectReport({ queryId: '123', reportId: '456', callId })).status, 'done');
  await service.listSavedQueries({ callId });
  assert.deepEqual(options, [
    ...['report', 'report', 'query'].map(name => [name, { signal: undefined, deadline: START_MS + 40_000, callId }]),
    ...Array.from({ length: 3 }, () => ['list', { signal: undefined, deadline: START_MS + 5_000 + 45_000, callId }]),
  ]);
});

for (const saved of [false, true]) test(`callId reaches ambiguous-run recovery saved=${saved}`, async () => {
  const h = harness();
  const callId = '0123456789abcdef';
  const lookups: unknown[][] = [];
  h.deps.client.runQuery = async () => { throw new BidManagerError('server_error'); };
  h.deps.client.listReports = async (...args) => { lookups.push(args); return { reports: [reportWith('456', 'RUNNING', '123')] }; };
  const service = h.service();
  const result = saved ? await service.startSavedReport({ queryId: '123', callId }) : await service.startAdHocReport({ ...request, callId });
  assert.ok(result.ok);
  assert.deepEqual(lookups, [[saved ? '123' : '789', saved ? { pageSize: 10, orderBy: 'key.reportId desc' } : { pageSize: 10 },
    { signal: undefined, singleAttempt: true, timeoutMs: 10_000, callId }]]);
});

for (const cap of [undefined, 10_000, 100_000]) test(`ad hoc deadline cap ${cap}`, async () => {
  const h = harness();
  const start = h.deps.now!().getTime();
  const seen: unknown[] = [];
  h.deps.client.createQuery = async (_body, call) => { seen.push(call?.deadline); return query; };
  h.deps.client.runQuery = async (_id, _body, call) => { seen.push(call?.deadline); throw new BidManagerError('timeout'); };
  h.deps.client.listReports = async (_id, _options, call) => { seen.push(call?.deadline); return { reports: [report] }; };
  h.deps.cleanup = { async run(call) { seen.push(call?.deadline); return { status: 'completed', deletedQueryIds: [], warnings: [] }; } };
  await h.service().startAdHocReport({ ...request, deadline: cap === undefined ? undefined : start + cap });
  const expected = start + Math.min(45_000, cap ?? Infinity);
  assert.deepEqual(seen, [expected, expected, undefined, expected]);
});
for (const waitBudgetMs of [-1, 40_001, 0.5, NaN, Infinity]) test(`invalid wait budget ${waitBudgetMs} has zero calls`, async () => {
  const h = harness();
  await assert.rejects(h.service().collectReport({ queryId: '123', reportId: '456', waitBudgetMs }), { message: 'waitBudgetMs must be a whole number from 0 to 40000.' });
  assert.deepEqual(h.calls, []);
});
for (const waitBudgetMs of [0, 20_000]) test(`bounded polling budget ${waitBudgetMs}`, async () => {
  const h = harness();
  h.deps.random = () => 0.5;
  let checks = 0;
  h.deps.client.getReport = async () => { checks++; return { ...report, metadata: { status: { state: 'RUNNING' } } }; };
  const result = await h.service().collectReport({ queryId: '123', reportId: '456', waitBudgetMs });
  assert.equal(result.status, 'pending');
  assert.equal(checks, waitBudgetMs === 0 ? 1 : 3);
  if (result.status === 'pending') assert.equal(result.waitedMs, waitBudgetMs === 0 ? 0 : 16_000);
});
for (const waitBudgetMs of [0, 20_000]) test(`read deferred after custom budget plus allowance ${waitBudgetMs}`, async () => {
  const h = harness();
  h.deps.client.getReport = async () => { h.advance(waitBudgetMs + 5_001); return report; };
  const result = await h.service().collectReport({ queryId: '123', reportId: '456', waitBudgetMs });
  assert.equal(result.status, 'done_no_preview');
  if (result.status === 'done_no_preview') assert.equal(result.reason, 'deferred');
  assert.ok(!h.calls.some(([name]) => name === 'read'));
});

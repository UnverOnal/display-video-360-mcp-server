import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { registerHealthTool } from './health.js';
import { registerReportTools, renderStarted, renderCollected, renderSavedList, renderFields, renderProblems } from './reports.js';
import type { ReportingService, StartedReport, CollectResult } from '../integrations/bidmanager/reporting.js';
import type { ReportPage } from '../integrations/bidmanager/report-file.js';
import { BidManagerError } from '../integrations/bidmanager/errors.js';
import { createToolRunner, type ToolCallEvent } from './call.js';

const ticket = { queryId: '123', reportId: '456' };
const started: StartedReport = { ticket, title: '[MCP] synthetic', state: 'QUEUED', format: 'XLSX', source: 'new', warnings: [] };
const page: ReportPage = {
  format: 'XLSX', header: ['ARRAY_HEADER'], rows: [['ARRAY_ROW']], text: 'H\npreview-value', totalRows: 3,
  offset: 0, returnedRows: 1, nextOffset: 1, truncated: true, cutBy: 'limit', cellsShortened: false,
  metadata: { groupBy: [], filters: [] }, warnings: [], notes: [], fileBytes: 10,
};
const done: Extract<CollectResult, { status: 'done' }> = { status: 'done', ticket, format: 'XLSX', url: 'https://storage.googleapis.com/test-bucket/report.xlsx?Signature=TEST', page };
function service(overrides: Partial<ReportingService> = {}): ReportingService {
  return {
    async startAdHocReport() { return { ok: true, report: started }; },
    async startSavedReport() { return { ok: true, report: started }; },
    async collectReport() { return done; },
    async listSavedQueries() { return { queries: [], pagesRead: 1 }; },
    ...overrides,
  };
}
async function connect(t: TestContext, reporting = service()): Promise<Client> {
  const server = new McpServer({ name: 'reports-test', version: '1' });
  registerHealthTool(server, '1');
  registerReportTools(server, reporting);
  const client = new Client({ name: 'test-client', version: '1' });
  t.after(() => client.close()); t.after(() => server.close());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  return client;
}
const adHoc = { type: 'STANDARD', dimensions: ['FILTER_ADVERTISER'], metrics: ['METRIC_IMPRESSIONS'], dateRange: { preset: 'PREVIOUS_DAY' } };
function resultText(result: { content?: unknown }): string {
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

const expectedDescriptions = {
  "list_report_fields": "Lists the dimensions, filters, and metrics a DV360 report type accepts, with Google's codes, names, and usage notes, plus the type's rules (required partner filter, required dimensions). Call it before run_report: run_report accepts only these codes. Makes no Google API call.",
  "run_report": "Starts a DV360 performance report (Bid Manager) and returns a ticket at once. Then call get_report with the ticket to collect it; reports take from seconds to hours.\nUse codes from list_report_fields for the chosen type. Filters take numeric IDs (e.g. {type: \"FILTER_PARTNER\", value: \"123\"}); find IDs by name with find_entities, or drill down with the list tools.\nChoose the coarsest grouping that answers the question: Google computes exact totals for whatever you group by, so run a grouped report for totals instead of adding up rows.\nDates are in each advertiser's time zone. The default file is XLSX; ask for CSV only when the user wants CSV.\nEach run uses shared Google quota. Do not start the same report twice; call get_report on the existing ticket instead.",
  "run_saved_report": "Runs one of the server's Google account's saved DV360 reports (find its ID with list_saved_reports) for a new date range, and returns a ticket at once; then call get_report. Without dateRange, the saved range is used. The saved report is never changed: if it was saved in a different format than requested, or is set to email people when it finishes, a temporary [MCP] copy is run instead.\nOnly reports created by the server's Google account are visible.",
  "get_report": "Checks a report started by run_report or run_saved_report and, when it is done, returns the link to the full file and a preview of its rows. While the report is running it waits about 20 seconds, then says to call again. Use offset to page through rows.\nRules for reading the numbers:\n- Always give the user the file link; the preview is often only part of the report.\n- Never add up money across currencies. Use the USD metrics, or group by Advertiser Currency.\n- Revenue is what the client is billed; media cost is what the media cost. They are different.\n- Rates (CTR, completion rate, view rate, eCPM, eCPC, eCPA, eCPV, % viewable) are never added or averaged; recompute them from their counts.\n- Unique reach and average frequency are never added across rows; run a report at the level you need.\n- Never compute totals from a preview that is cut off; run a grouped report instead.\n- Numbers for the previous month can still change for up to 7 days.",
  "list_saved_reports": "Lists the saved DV360 reports of the server's Google account (ID, title, type, format, date range), sorted by title. The server's own temporary [MCP] reports are left out unless includeMcp is true. Reports that other people created under their own accounts are not visible. Use titleContains to search, and pageToken to continue."
};

test('every report tool uses its registered name and forwards the runner callId to its service', async t => {
  const calls: { method: string; request: unknown }[] = [];
  const events: ToolCallEvent[] = [];
  let sequence = 0;
  const server = new McpServer({ name: 'report-call-id-test', version: '1' });
  registerReportTools(server, service({
    async startAdHocReport(request) { calls.push({ method: 'startAdHocReport', request }); return { ok: true, report: started }; },
    async startSavedReport(request) { calls.push({ method: 'startSavedReport', request }); return { ok: true, report: started }; },
    async collectReport(request) { calls.push({ method: 'collectReport', request }); return done; },
    async listSavedQueries(request) { calls.push({ method: 'listSavedQueries', request }); return { queries: [], pagesRead: 1 }; },
  }), createToolRunner({ log: event => events.push(event), now: () => 100, newCallId: () => `report-call-${++sequence}` }));
  const client = new Client({ name: 'test-client', version: '1' });
  t.after(() => client.close()); t.after(() => server.close());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const requests = [
    ['run_report', adHoc, 'startAdHocReport'],
    ['run_saved_report', { queryId: '123', format: 'CSV' }, 'startSavedReport'],
    ['get_report', { ...ticket, offset: 2, limit: 3 }, 'collectReport'],
    ['list_saved_reports', { titleContains: 'x', includeMcp: true, pageToken: 'test-token' }, 'listSavedQueries'],
  ] as const;
  for (const [index, [name, args, method]] of requests.entries()) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    assert.equal(calls.length, index + 1);
    assert.equal(calls[index].method, method);
    const { signal, ...forwarded } = calls[index].request as Record<string, unknown>;
    assert.ok(signal instanceof AbortSignal);
    const callId = `report-call-${index + 1}`;
    assert.deepEqual(forwarded, { ...args, callId });
    assert.deepEqual(events[index], { type: 'tool.call', tool: name, callId, outcome: 'ok', durationMs: 0 });
  }
  const fields = await client.callTool({ name: 'list_report_fields', arguments: { type: 'STANDARD' } });
  assert.notEqual(fields.isError, true);
  assert.equal(calls.length, 4);
  assert.equal(events.length, 5);
  assert.deepEqual(events[4], {
    type: 'tool.call', tool: 'list_report_fields', callId: 'report-call-5', outcome: 'ok', durationMs: 0,
  });
});

test('report tool metadata exposes exact descriptions, titles, annotations and no output schema', async t => {
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  const titles = ['List report fields', 'Start a report', 'Start a saved report', 'Get a report', 'List saved reports'];
  Object.entries(expectedDescriptions).forEach(([name, description], i) => {
    const tool = tools.find(tool => tool.name === name)!;
    assert.equal(tool.title, titles[i]); assert.equal(tool.description, description);
    assert.equal(tool.outputSchema, undefined);
    assert.deepEqual(tool.annotations, name.startsWith('run_')
      ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      : { readOnlyHint: true, openWorldHint: name !== 'list_report_fields' });
  });
});

for (const [name, args] of [
  ['run_report', { ...adHoc, typo: true }],
  ['run_saved_report', { queryId: 'abc' }],
  ['get_report', { ...ticket, reportId: '1/2' }],
  ['list_saved_reports', { typo: true }],
  ['list_report_fields', { type: 'STANDARD', typo: true }],
  ['run_report', { ...adHoc, dateRange: { preset: 'PREVIOUS_DAY', typo: true } }],
  ['run_report', { ...adHoc, filters: [{ type: 'FILTER_PARTNER', value: '1', typo: true }] }],
] as const) {
  test(`${name} rejects strict schema violations before the service`, async t => {
    const fail = async (): Promise<never> => { assert.fail('must not call service'); };
    const client = await connect(t, service({ startAdHocReport: fail, startSavedReport: fail, collectReport: fail, listSavedQueries: fail }));
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
  });
}

test('all handlers forward valid arguments and emit one text block without structured content', async t => {
  const calls: unknown[] = [];
  const client = await connect(t, service({
    async startAdHocReport(args) { calls.push(args); return { ok: true, report: started }; },
    async startSavedReport(args) { calls.push(args); return { ok: true, report: started }; },
    async collectReport(args) { calls.push(args); return done; },
    async listSavedQueries(args) { calls.push(args); return { queries: [], pagesRead: 1 }; },
  }));
  const requests = [
    ['run_report', adHoc], ['run_saved_report', { queryId: '123', format: 'CSV' }],
    ['get_report', { ...ticket, offset: 2, limit: 3 }],
    ['list_saved_reports', { titleContains: 'x', includeMcp: true, pageToken: 'test-token' }],
    ['list_report_fields', { type: 'STANDARD' }],
  ] as const;
  for (const [name, args] of requests) {
    const result = await client.callTool({ name, arguments: args });
    resultText(result); assert.equal(result.structuredContent, undefined); assert.notEqual(result.isError, true);
  }
  // Every Google-calling handler adds the MCP request's signal; compare the rest.
  const withoutSignal = (call: unknown) => {
    const { signal, callId, ...rest } = call as Record<string, unknown>; assert.ok(signal instanceof AbortSignal); return rest;
  };
  assert.deepEqual(withoutSignal(calls[0]), adHoc); assert.deepEqual(withoutSignal(calls[1]), requests[1][1]);
  const collect = calls[2] as Record<string, unknown>;
  assert.ok(collect.signal instanceof AbortSignal);
  const { signal: _, callId, ...args } = collect; assert.deepEqual(args, requests[2][1]);
  assert.deepEqual(withoutSignal(calls[3]), requests[3][1]); assert.equal(calls.length, 4);
});

for (const saved of [false, true]) {
  test(`validation problems from ${saved ? 'saved' : 'ad hoc'} are tool errors`, async t => {
    const invalid = async () => ({ ok: false as const, problems: ['date problem', 'field problem'] });
    const client = await connect(t, service({ startAdHocReport: invalid, startSavedReport: invalid }));
    const result = await client.callTool({ name: saved ? 'run_saved_report' : 'run_report', arguments: saved ? { queryId: '123' } : adHoc });
    assert.equal(result.isError, true); assert.equal(resultText(result), renderProblems(['date problem', 'field problem']));
  });
}
for (const error of [new BidManagerError('not_found'), new Error('https://storage.googleapis.com/secret')]) {
  test(`tool errors sanitize ${error.name}`, async t => {
    const client = await connect(t, service({ async startAdHocReport() { throw error; } }));
    const result = await client.callTool({ name: 'run_report', arguments: adHoc });
    assert.equal(result.isError, true);
    assert.equal(resultText(result), error instanceof BidManagerError ? error.message : "Unexpected server error. Try again; if it keeps happening, report it to the server's maintainer.");
    assert.ok(!resultText(result).includes('/secret'));
  });
}
for (const collect of [
  { status: 'failed', ticket },
  { status: 'done_no_preview', ticket, format: 'XLSX', reason: 'invalid_link', message: 'invalid' },
  { status: 'done_no_preview', ticket, format: 'XLSX', reason: 'busy', message: 'busy', url: done.url },
] as CollectResult[]) {
  test(`get_report error status ${collect.status} url=${'url' in collect && !!collect.url}`, async t => {
    const client = await connect(t, service({ async collectReport() { return collect; } }));
    const result = await client.callTool({ name: 'get_report', arguments: ticket });
    assert.equal(result.isError === true, collect.status === 'failed' || (collect.status === 'done_no_preview' && !collect.url));
    assert.equal(resultText(result), renderCollected(collect));
  });
}

test('started layouts cover all sources, missing saved format and warnings', () => {
  assert.equal(renderStarted(started), 'Report started: a new [MCP] query.\nTicket: queryId 123, reportId 456. State: QUEUED. Format: XLSX.\nQuery title: [MCP] synthetic\nNext: call get_report with this queryId and reportId.');
  assert.match(renderStarted({ ...started, source: 'saved', savedQueryId: '9' }), /saved report 9, run as it is/);
  assert.match(renderStarted({ ...started, source: 'saved_copy', savedQueryId: '9', savedFormat: 'CSV', warnings: ['first', 'second'] }), /saved as CSV; the saved report was not changed\.[\s\S]*Warning: first\nWarning: second/);
  assert.match(renderStarted({ ...started, source: 'saved_copy' }), /saved as an unspecified format/);
});
test('notification copy explains that the copy sends no emails', () => {
  const text = renderStarted({
    ...started, source: 'saved_copy', savedQueryId: '123', copyReason: 'notifications',
  });
  assert.ok(text.includes('because it is set to email people when it finishes, and the copy sends no emails; the saved report was not changed'));
  assert.ok(!text.includes('it is saved as'));
});
test('pending and failed layouts are exact and pending seconds round', () => {
  assert.equal(renderCollected({ status: 'pending', ticket, state: 'RUNNING', waitedMs: 1550 }), 'Report 456 (query 123) is still RUNNING after waiting 2 s in this call. Call get_report again with the same IDs. Do not start the report again.');
  assert.equal(renderCollected({ status: 'failed', ticket }), 'Google could not produce report 456 (query 123); its state is FAILED and Google gives no reason. Check the fields and date range, or try a shorter range, then start a new report.');
});
test('done includes preview once, metadata, totals, warning, partial and shortened cell guidance', () => {
  const text = renderCollected({ ...done, reportType: 'REACH', page: { ...page, cellsShortened: true, totals: ['ARRAY_TOTAL'], totalsText: 'totals-value', metadata: { dateRange: 'range', reportTime: 'time', groupBy: ['one', 'two'], filters: [{ label: 'Partner ID', value: '1' }] }, notes: ['Some footer lines were shortened.', 'other note'], warnings: ['missing rows'] } });
  assert.equal(text.split(page.text).length - 1, 1);
  assert.ok(!text.includes('ARRAY_')); assert.match(text, /totals-value$/);
  for (const part of ['Date range: range', 'Report time: time', 'Group by: one, two', 'Filters: Partner ID: 1 (shortened; the file has the full lists)', 'rows 1–1 (1 rows)', 'offset 1', 'Some long cells', 'Warning: missing rows', 'Note: other note', 'Rates (CTR, completion rate, view rate, % viewable) are fractions here (0.0057 means 0.57%).', 'REACH reports have no totals row: Google does not add up unique reach.']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes('Note: Some footer lines were shortened.'));
});
test('empty report omits preview and optional metadata, CSV uses percent format, no REACH line', () => {
  const text = renderCollected({ ...done, format: 'CSV', page: { ...page, totalRows: 0, returnedRows: 0, nextOffset: undefined, notes: ['Some footer lines were shortened.'] } });
  assert.match(text, /This page has no rows/); assert.match(text, /Rates \(CTR, completion rate, view rate, % viewable\) are percent strings here \(for example 0\.57%\)\./);
  for (const absent of ['Preview (CSV', 'More rows:', 'Unique reach', 'Date range:', 'Filters:', 'shortened', 'Totals row']) assert.ok(!text.includes(absent), absent);
});
test('end-offset page includes header for nonempty report and no continuation', () => {
  const text = renderCollected({ ...done, page: { ...page, offset: 3, returnedRows: 0, nextOffset: undefined, text: 'H' } });
  assert.match(text, /This page has no rows/); assert.match(text, /Preview \(CSV, first line is the header\):\nH$/); assert.ok(!text.includes('More rows:'));
});
for (const reason of ['too_large', 'busy', 'deferred'] as const) {
  test(`no-preview ${reason} prints link and only relevant advice`, () => {
    const text = renderCollected({ status: 'done_no_preview', ticket, format: 'XLSX', url: done.url, reason, message: 'message' });
    assert.ok(text.includes(done.url)); assert.equal(text.includes('For questions,'), reason === 'too_large');
    assert.equal(text.split('message').length - 1, 1);
  });
}
test('no-preview without link prints only the failure sentence', () => {
  assert.equal(renderCollected({ status: 'done_no_preview', ticket, format: 'XLSX', reason: 'invalid_link', message: 'bad link' }), 'Report 456 (query 123) is done, but the preview could not be read: bad link');
});
test('saved list renders defaults, frequency, matching title and continuation', () => {
  assert.equal(renderSavedList({ queries: [], pagesRead: 1 }), 'Saved reports of the server\'s Google account (0 shown):\nNo saved reports found in this part of the list.\nRun one with run_saved_report and its ID.');
  const text = renderSavedList({ pagesRead: 1, nextPageToken: 'next', queries: [{ queryId: '1', title: 'one' }, { queryId: '2', title: 'two', type: 'STANDARD', format: 'CSV', range: 'PREVIOUS_DAY', frequency: 'DAILY' }, { queryId: '3', title: 'three', frequency: 'ONE_TIME' }] }, { titleContains: 'test' });
  assert.match(text, /matching "test" \(3 shown\)/); assert.match(text, /1 · one · \? · \? · \?/); assert.match(text, /PREVIOUS_DAY · DAILY/); assert.ok(!text.includes('ONE_TIME')); assert.match(text, /pageToken "next" and the same titleContains/);
});
for (const type of ['STANDARD', 'YOUTUBE', 'REACH'] as const) {
  test(`field renderer ${type} covers scope, requirements and catalog`, () => {
    const text = renderFields(type);
    assert.ok(text.startsWith(`${type} report fields. Use the codes with run_report.\n`));
    assert.ok(text.includes(type === 'STANDARD' ? 'No partner filter is needed.' : 'Exactly one FILTER_PARTNER filter is required.'));
    assert.match(text, /several IDs for one filter act as alternatives \(OR\)/);
    assert.match(text, /METRIC_REVENUE_ADVERTISER · Revenue \(Adv Currency\) · needs FILTER_ADVERTISER_CURRENCY/);
    assert.equal(text.includes('YOUTUBE has no Date'), type === 'YOUTUBE');
    if (type === 'YOUTUBE') assert.match(text, /Filter-only codes \(not groupable in YOUTUBE\): FILTER_PARTNER · Partner ID/);
    assert.ok(text.includes('FILTER_ADVERTISER · Advertiser ID · filterable by ID'));
    assert.ok(!text.endsWith('\n'));
  });
}

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { registerPerformanceTools, renderPerformance } from './performance.js';
import type { PerformanceResult, PerformanceService, PerformanceRequest } from '../combined/performance.js';
import type { CollectResult } from '../integrations/bidmanager/reporting.js';
import { safeErrorMessage } from '../combined/performance.js';
import { Dv360Error } from '../integrations/dv360/errors.js';
import { createToolRunner, type ToolCallEvent } from './call.js';

const ticket = { queryId: '100', reportId: '200' };
const started = { ticket, state: 'QUEUED' as const, title: 'synthetic', format: 'XLSX' as const, source: 'new' as const, warnings: [] };
const pending: CollectResult = { status: 'pending', ticket, state: 'RUNNING', waitedMs: 16_000 };
const done: Extract<CollectResult, { status: 'done' }> = { status: 'done', ticket, format: 'XLSX', url: 'https://example.test/report', page: {
  format: 'XLSX', header: ['Line Item ID', 'Line Item'], rows: [['4', 'Synthetic']], text: 'Line item ID,Line item\n4,Synthetic',
  totalRows: 1, offset: 0, returnedRows: 1, truncated: false, cellsShortened: false, metadata: { groupBy: [], filters: [] }, warnings: [], notes: [], fileBytes: 10,
} };
function report(overrides: Partial<Extract<PerformanceResult, { kind: 'report' }>> = {}): Extract<PerformanceResult, { kind: 'report' }> {
  return { kind: 'report', path: [{ level: 'advertiser', id: '1', name: 'Adv', matched: 'id' }, { level: 'lineItem', id: '4', name: 'Line', matched: 'id' }],
    advertiser: { id: '1', name: 'Adv', status: 'active', partnerId: '9' }, target: { resource: 'lineItem', id: '4', name: 'Line', status: 'paused', summary: ['flight summary'] },
    preset: 'delivery', breakdown: 'total', reportType: 'STANDARD', dateRange: { text: 'LAST_7_DAYS', isDefault: true }, started, collected: pending, notes: [], warnings: [], ...overrides };
}
async function connect(t: TestContext, performance: PerformanceService, lines: ToolCallEvent[] = []) {
  const server = new McpServer({ name: 'test', version: '1' });
  registerPerformanceTools(server, performance, createToolRunner({ log: event => lines.push(event), newCallId: () => 'test-call' }));
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close()); t.after(() => server.close());
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct); return client;
}
const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { type: string; text: string }[])[0].text;
test('exact tool description, strict schema, annotations, and no output schema', async t => {
  const client = await connect(t, { async getPerformance() { return report(); } }); const { tools } = await client.listTools();
  assert.equal(tools.length, 1); const tool = tools[0]; assert.equal(tool.name, 'get_performance');
  assert.equal(tool.description, 'Answers "how is <advertiser / campaign / insertion order / line item> doing" in one call: finds the entity by name or ID, shows its status, flight, and budget, starts a DV360 report for it, and waits up to 20 seconds for the rows. If the report isn\'t ready by then, it returns a ticket: call get_report with it, and don\'t call get_performance again for the same question.\nGive the advertiser (advertiserId or advertiserName), and optionally one campaign, insertion order, or line item below it, by ID or by name; campaign, insertion order, and line item names are searched within that advertiser only. If a name matches several entities, nothing is started and the candidates are listed: ask the user which one, then call again with its ID.\npreset chooses the numbers: delivery (default: impressions, clicks, CTR, revenue, eCPM, eCPC), video, viewability, conversions, youtube (views, view rate, eCPV; use it for YouTube campaigns), reach (unique reach and frequency; without a day, week, or month breakdown Google allows at most 93 days). breakdown: total (default), day, week, month, or a level below the target. Default dates: the last 7 days.\nMoney is Revenue (Adv Currency): what the advertiser is billed, in the advertiser\'s currency. Call it revenue, not spend. The rules for reading numbers in get_report apply here too.\nFor custom dimensions or metrics, use run_report.');
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.equal(tool.outputSchema, undefined); assert.equal(tool.inputSchema.additionalProperties, false);
});
for (const args of [{ extra: true }, { advertiserId: 1 }, { campaignId: 'bad' }, { lineItemId: '1'.repeat(21) }, { advertiserName: 'x'.repeat(201) }, { dateRange: { extra: true } }]) test(`schema rejects ${JSON.stringify(args)}`, async t => {
  let calls = 0; const client = await connect(t, { async getPerformance() { calls++; return report(); } });
  try { const result = await client.callTool({ name: 'get_performance', arguments: args }); assert.equal(result.isError, true); } catch { /* SDK may reject at protocol level. */ }
  assert.equal(calls, 0);
});
test('schema passes request, signal and callId to the service and returns one text block', async t => {
  let seen: PerformanceRequest | undefined; const client = await connect(t, { async getPerformance(request) { seen = request; return report(); } });
  const result = await client.callTool({ name: 'get_performance', arguments: { advertiserName: 'Adv', preset: 'video', breakdown: 'day', dateRange: { preset: 'PREVIOUS_DAY' }, format: 'CSV' } });
  assert.ok(seen?.signal instanceof AbortSignal); assert.equal(seen.callId, 'test-call'); assert.equal(seen.preset, 'video'); assert.equal(seen.advertiserName, 'Adv'); assert.equal(seen.format, 'CSV'); assert.equal(result.content.length, 1); assert.equal(result.structuredContent, undefined);
});
test('invalid and budget refusal render exact message and error state', () => {
  assert.deepEqual(renderPerformance({ kind: 'invalid', problems: ['one', 'two'] }), { text: 'Nothing was started. Fix these and try again:\n- one\n- two', isError: true });
  assert.deepEqual(renderPerformance({ kind: 'not_started', path: [{ level: 'advertiser', id: '1', matched: 'id' }], message: 'budget' }), { text: 'Advertiser: 1\nbudget', isError: true });
});
for (const reason of ['none', 'ambiguous', 'incomplete'] as const) test(`unresolved rendering ${reason} preserves named parent scope`, () => {
  const rendered = renderPerformance({ kind: 'unresolved', level: 'campaign', reason, path: [{ level: 'advertiser', id: '1', name: 'Advertiser', matched: 'exact' }], parents: { resource: 'campaign', advertiserId: '1' },
    find: { resource: 'campaign', query: 'Campaign', matches: [], exactMatches: 0, totalMatches: reason === 'ambiguous' ? 2 : 0, searched: 3, complete: reason !== 'incomplete', statusFilter: 'default', notes: [], warnings: [] } });
  assert.ok(rendered.text.startsWith('Advertiser: Advertiser (1)\nNo report was started:'));
  assert.ok(rendered.text.includes('Campaigns of advertiser 1 matching "Campaign"'));
  assert.equal(rendered.isError, reason !== 'ambiguous');
  assert.ok(rendered.text.includes(reason === 'none' ? 'matched no campaign (searched: advertiser 1).' : reason === 'ambiguous' ? 'matched several campaigns.' : 'could not be searched completely, so no report was started.'));
});
test('report header includes known names, status, summary, dates, and partial markers', () => {
  const rendered = renderPerformance(report({ path: [{ level: 'advertiser', id: '1', matched: 'id' }, { level: 'lineItem', id: '4', name: 'Line', matched: 'prefix' }], notes: ['note'], warnings: ['warning'] }));
  assert.ok(rendered.text.startsWith('Performance of line item Line (4)\nAdvertiser: 1\nLine item: Line (4) · partial name match\nPartner: 9\nStatus: paused\nflight summary\nReport: delivery (STANDARD), breakdown total, dates LAST_7_DAYS (default)\nNote: note\nWarning: warning\n'));
  assert.equal(rendered.isError, false);
});
test('ID-only header and custom date range', () => {
  const rendered = renderPerformance(report({ path: [{ level: 'advertiser', id: '1', matched: 'id' }], target: undefined, dateRange: { text: '2026-01-01 to 2026-01-31', isDefault: false } }));
  assert.ok(rendered.text.startsWith('Performance of advertiser 1\nAdvertiser: 1\nPartner: 9\nStatus: active'));
  assert.ok(rendered.text.includes('dates 2026-01-01 to 2026-01-31')); assert.ok(!rendered.text.includes('(default)'));
});
for (const collected of [pending, done, { status: 'failed', ticket } as const,
  { status: 'done_no_preview', ticket, format: 'XLSX', reason: 'busy', message: 'busy', url: 'https://example.test' } as const,
  { status: 'done_no_preview', ticket, format: 'XLSX', reason: 'download_failed', message: 'expired' } as const,
  undefined]) test(`collected branch ${collected?.status}/${collected?.status === 'done_no_preview' ? collected.url : ''}`, () => {
  const rendered = renderPerformance(report({ collected }));
  assert.equal(rendered.isError, collected?.status === 'failed' || (collected?.status === 'done_no_preview' && !collected.url));
  if (collected === undefined) assert.ok(rendered.text.endsWith('There was no time left in this call to wait for it. Call get_report with this queryId and reportId.'));
});
test('a failed check does not claim the call ran out of time', () => {
  const rendered = renderPerformance(report({ collected: undefined, collectFailed: true }));
  assert.ok(rendered.text.endsWith('\nCall get_report with this queryId and reportId.'));
  assert.ok(!rendered.text.includes('no time left'));
});
for (const collected of [done, pending, undefined]) test(`start warning exactly once collected=${collected?.status}`, () => {
  const rendered = renderPerformance(report({ collected, started: { ...started, warnings: ['start-warning'] } }));
  assert.equal(rendered.text.split('Warning: start-warning').length - 1, 1);
});
for (const id of ['4', '999']) test(`requested row ${id} in page`, () => {
  const rendered = renderPerformance(report({ collected: done, requestedRow: { level: 'lineItem', id } }));
  assert.ok(rendered.text.includes(`Requested row: Line item ID ${id}` + (id === '4' ? ' (row 1 of this page)' : ' (not in this page; use get_report with offset to find it)')));
});
test('size guard removes preview and totals but preserves ticket, link and warning', () => {
  const rendered = renderPerformance(report({ requestedRow: { level: 'lineItem', id: '4' }, collected: { ...done, page: { ...done.page, text: 'x'.repeat(21_000), totalsText: 'totals' } } }));
  assert.ok(rendered.text.includes('Requested row: Line item ID 4 (row 1 of this page)'));
  assert.ok(rendered.text.length < 20_000); assert.ok(!rendered.text.includes('Preview (CSV')); assert.ok(!rendered.text.includes('Totals row'));
  assert.ok(rendered.text.includes(done.url)); assert.ok(rendered.text.includes('Report 200 (query 100)'));
  assert.ok(rendered.text.endsWith('The preview was too long for this reply. Call get_report with the same IDs (offset 0) to see it.'));
});
test('service errors are safe and recorded', async t => {
  const error = new Dv360Error('server_error'); const events: ToolCallEvent[] = [];
  const client = await connect(t, { async getPerformance() { throw error; } }, events);
  const result = await client.callTool({ name: 'get_performance', arguments: {} });
  assert.equal(result.isError, true); assert.equal(textOf(result), safeErrorMessage(error)); assert.equal(events[0].errorClass, 'Dv360Error');
});
test('done_no_preview reason is recorded', async t => {
  const events: ToolCallEvent[] = []; const client = await connect(t, { async getPerformance() { return report({ collected: { status: 'done_no_preview', ticket, format: 'XLSX', reason: 'busy', message: 'busy', url: 'https://example.test' } }); } }, events);
  await client.callTool({ name: 'get_performance', arguments: {} }); assert.equal(events[0].kind, 'busy');
});

for (const [level, header] of [['campaign', 'Campaign ID'], ['insertionOrder', 'Insertion Order ID'], ['lineItem', 'Line Item ID']] as const) test(`requested row uses actual Google header ${header}`, () => {
  const rendered = renderPerformance(report({ requestedRow: { level, id: '4' }, collected: { ...done, page: { ...done.page, header: [header], rows: [['4']] } } }));
  assert.ok(rendered.text.includes('(row 1 of this page)'));
});

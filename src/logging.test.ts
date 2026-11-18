import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOGGED_KINDS, type LoggedKind } from './tools/call.js';
import { GoogleCredentialsError, type GoogleCredentialsErrorKind } from './integrations/google/auth.js';
import type { GoogleApiErrorKind } from './integrations/google/errors.js';
import { ReportFileError, type ReportFileErrorKind } from './integrations/bidmanager/report-file.js';
import {
  advertiserId, checkRedaction, composition, deferred, fileUrl, googleError, json, kind, page, query, queryId, report, reportId, title, token,
} from './composition-harness.test.js';

type Missing = Exclude<GoogleApiErrorKind | GoogleCredentialsErrorKind | ReportFileErrorKind | 'busy' | 'deferred', LoggedKind>;
const complete: [Missing] extends [never] ? true : false = true;
test('logged tool kinds cover every integration error kind', () => {
  assert.equal(complete, true);
  assert.equal(new Set(LOGGED_KINDS).size, LOGGED_KINDS.length);
});

test('real MCP composition correlates and redacts upstream requests, results, retries and errors', async t => {
  const h = await composition(t);
  const queries = '/v2/queries';
  const reports = `${queries}/${queryId}/reports`;
  const lineItems = `/v4/advertisers/${advertiserId}/lineItems`;
  const advertiser = `/v4/advertisers/${advertiserId}`;
  for (let i = 0; i < 3; i++) h.steps.push({ path: queries, respond: () => json({ queries: [query], nextPageToken: `${token}${i}` }) });
  const first = await h.call('list_saved_reports', { titleContains: title });
  assert.ok(first.text.includes(`${token}2`));
  h.steps.push({ path: queries, check: url => assert.equal(url.searchParams.get('pageToken'), `${token}2`), respond: () => json({ queries: [query] }) });
  assert.ok((await h.call('list_saved_reports', { titleContains: title, pageToken: `${token}2` })).text.includes(title));

  h.steps.push(
    { path: queries, method: 'POST', check: (_url, body) => assert.ok(body?.includes(title)), respond: () => json(query) },
    { path: `${queries}/${queryId}:run`, method: 'POST', respond: () => googleError(503) },
    { path: reports, respond: () => json({ reports: [report] }) },
    { path: queries, respond: () => json({ queries: [{ ...query, metadata: { title: `[MCP] ${title} 2026-11-01T00:00:00Z` } }] }) },
    { path: `${queries}/${queryId}`, method: 'DELETE', respond: () => new Response(null, { status: 204 }) },
  );
  const started = await h.call('run_report', { name: title, type: 'STANDARD', dimensions: ['FILTER_ADVERTISER'], metrics: ['METRIC_IMPRESSIONS'], dateRange: { preset: 'PREVIOUS_DAY' } });
  assert.notEqual(started.result.isError, true);
  const failedRun = started.events.find(event => event.httpStatus === 503);
  assert.equal(failedRun?.outcome, 'server_error');
  assert.equal(failedRun?.status, 'OTHER');
  assert.deepEqual(failedRun?.reasons, ['other']);
  assert.ok(!started.events.some(event => event.type === 'google.retry'));
  assert.ok(started.events.some(event => event.operation === 'queries.reports.list' && event.callId === started.tool.callId));

  const pending = { ...report, metadata: { status: { state: 'RUNNING' } } };
  h.steps.push({ path: `${reports}/${reportId}`, respond: () => json(pending) }, { path: `${reports}/${reportId}`, respond: () => json(report) });
  h.readers.push(() => page);
  const collected = await h.call('get_report', { queryId, reportId });
  assert.notEqual(collected.result.isError, true);
  assert.ok(collected.text.includes(fileUrl));
  for (const [error, outcome] of [
    [new ReportFileError('too_large', title), 'ok'],
    [new ReportFileError('download_failed', title, { httpStatus: 403 }), 'error'],
  ] as const) {
    h.steps.push({ path: `${reports}/${reportId}`, respond: () => json(report) });
    h.readers.push(() => { throw error; });
    const collected = await h.call('get_report', { queryId, reportId });
    assert.equal(collected.tool.outcome, outcome);
    assert.equal(collected.tool.kind, error.kind);
    assert.equal(collected.text.includes(fileUrl), outcome === 'ok');
  }
  // Unknown kinds must be filtered even when they contain only identifier characters.
  h.steps.push({ path: `${reports}/${reportId}`, respond: () => json(report) });
  h.readers.push(() => { throw { kind, message: token }; });
  assert.equal((await h.call('get_report', { queryId, reportId })).tool.kind, 'other');

  h.steps.push({ path: lineItems, respond: () => json({ lineItems: [{ lineItemId: reportId, displayName: title }], nextPageToken: token }) },
    { path: advertiser, respond: () => json({ advertiserId, displayName: title, generalConfig: { currencyCode: 'USD', timeZone: 'UTC' } }) });
  const listed = await h.call('list_line_items', { advertiserId });
  const wrapped = /v1\.[0-9a-f]{16}\.[A-Za-z0-9_-]+/.exec(listed.text)?.[0];
  assert.ok(wrapped);
  h.steps.push({ path: lineItems, check: url => assert.equal(url.searchParams.get('pageToken'), token), respond: () => googleError(429) },
    { path: advertiser, respond: () => json({ advertiserId, displayName: title }) },
    { path: lineItems, respond: () => json({ lineItems: [] }) });
  const retried = await h.call('list_line_items', { advertiserId, pageToken: wrapped });
  assert.ok(retried.events.some(event => event.type === 'google.retry' && event.delayMs === 1000));

  h.steps.push({ path: `${lineItems}/${reportId}`, respond: () => googleError(400) },
    { path: advertiser, respond: () => json({ advertiserId, displayName: title }) });
  const bad = await h.call('get_metadata', { type: 'line_item', advertiserId, id: reportId });
  assert.equal(bad.result.isError, true);
  assert.ok(bad.text.includes(title), 'Google message remains in the tool result');

  h.steps.push({ path: '/v4/partners', respond: () => googleError(404, 'NOT_FOUND') });
  assert.ok((await h.call('list_partners')).events.some(event => event.status === 'NOT_FOUND'));
  for (const error of [new TypeError(token), new GoogleCredentialsError('unavailable')]) {
    for (let i = 0; i < 3; i++) h.steps.push({ path: '/v4/partners', respond: () => { throw error; } });
    const failed = await h.call('list_partners');
    assert.equal(failed.result.isError, true);
    assert.ok(failed.events.some(event => event.outcome === (error instanceof TypeError ? 'network' : 'credentials_unavailable')));
  }
  h.steps.push({ path: queries, respond: () => googleError(403, 'PERMISSION_DENIED', 'dailyLimitExceeded') });
  const latched = await h.call('list_saved_reports');
  assert.deepEqual(latched.events.map(event => event.type), ['google.request', 'google.latched', 'tool.call']);
  assert.deepEqual(latched.events[0].reasons, ['dailyLimitExceeded', 'other']);
  const blocked = await h.call('list_saved_reports');
  assert.deepEqual(blocked.events.map(event => event.type), ['google.latch_blocked', 'tool.call']);
  assert.equal(h.readers.length, 0);
  checkRedaction(h.lines);
});

test('overlapping MCP calls retain their own callIds when upstream responses finish in reverse order', { timeout: 5000 }, async t => {
  const h = await composition(t);
  const firstResponse = deferred<Response>();
  const secondResponse = deferred<Response>();
  const firstEntered = deferred<void>();
  const secondEntered = deferred<void>();
  h.steps.push(
    { path: '/v4/partners', respond: () => { firstEntered.resolve(); return firstResponse.promise; } },
    { path: '/v2/queries', respond: () => { secondEntered.resolve(); return secondResponse.promise; } },
  );
  const first = h.client.callTool({ name: 'list_partners', arguments: {} });
  await firstEntered.promise;
  const second = h.client.callTool({ name: 'list_saved_reports', arguments: {} });
  await secondEntered.promise;
  secondResponse.resolve(json({ queries: [query] }));
  assert.notEqual((await second).isError, true);
  firstResponse.resolve(json({ partners: [{ partnerId: queryId, displayName: title }] }));
  assert.notEqual((await first).isError, true);
  const events = h.lines.map(line => JSON.parse(line));
  const tools = events.filter(event => event.type === 'tool.call');
  assert.deepEqual(tools.map(event => event.tool), ['list_saved_reports', 'list_partners']);
  assert.match(tools[0].callId, /^[0-9a-f]{16}$/);
  assert.match(tools[1].callId, /^[0-9a-f]{16}$/);
  assert.notEqual(tools[0].callId, tools[1].callId);
  assert.equal(events.length, 4);
  for (const event of events.filter(event => event.type.startsWith('google.'))) {
    assert.equal(event.callId, tools.find(tool => tool.tool === (event.api === 'dv360' ? 'list_partners' : 'list_saved_reports'))?.callId);
  }
  assert.equal(h.steps.length, 0);
  checkRedaction(h.lines);
});

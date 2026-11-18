// M5 acceptance criteria, end to end: the real tool handlers, services, clients and request loop behind the
// real MCP server, against a scripted fake Google (composition-harness.test.ts). All time is fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleCredentialsError } from './integrations/google/auth.js';
import { nextPacificMidnight } from './integrations/google/retry.js';
import {
  START, advertiserId, checkRedaction, composition, googleError, json, query, queryId, report, reportId, title,
  type LogEventLine,
} from './composition-harness.test.js';

const partners = '/v4/partners';
const queries = '/v2/queries';
const queryPath = `${queries}/${queryId}`;
const runPath = `${queryPath}:run`;
const reportsPath = `${queryPath}/reports`;
const reportPath = `${reportsPath}/${reportId}`;

const DV = {
  server_error: 'Display & Video 360 had a temporary problem. Try again shortly.',
  timeout: 'Display & Video 360 did not respond in time. Try again shortly.',
  rate_limited: 'Too many Display & Video 360 requests in the last minute. Wait a minute, then try again.',
  unauthenticated: 'The Google login is no longer accepted. Run the Google login command again, then retry.',
  access_denied: 'Access denied. The partner or advertiser ID may be wrong, or the Google account this server uses has no access to it.',
  not_found: 'Not found, or not visible to the Google account this server uses.',
};
const BM = {
  server_error: 'Bid Manager had a temporary problem. Try again shortly.',
  timeout: 'Bid Manager did not respond in time. Try again shortly.',
  daily_limit: 'The daily Bid Manager request quota is used up. It resets at midnight Pacific time.',
};
const CREDENTIALS = {
  expired_or_revoked: 'The Google login has expired or was revoked. Run the Google login command again (see the README), then retry.',
  unavailable: 'Could not get Google credentials right now. Try again shortly.',
};
const RECOVERED = 'Warning: Google did not confirm the start in time; this report was found by looking it up.';
const RECOVERED_SAVED = 'Warning: Google did not confirm the start in time; this is the report now running for the saved query (it may be one someone else started).';
const NOT_STARTED = 'Google did not confirm that the report started, and no report was found for it. Starting it again is safe.';
const MAY_HAVE_STARTED = 'Google did not confirm that the report started, and this could not be checked. It may still be running: wait a few minutes before starting it again, to avoid running it twice.';
const CLEANUP_WARNING = 'Warning: Old [MCP] queries could not be cleaned up this time.';

const runArgs = { name: title, type: 'STANDARD', dimensions: ['FILTER_ADVERTISER'], metrics: ['METRIC_IMPRESSIONS'], dateRange: { preset: 'PREVIOUS_DAY' } };
const running = (id = reportId, state = 'RUNNING') => ({ ...report, key: { queryId, reportId: id }, metadata: { status: { state } } });
const partnerList = () => json({ partners: [{ partnerId: queryId, displayName: title }] });
const noQueries = () => json({ queries: [] });
const deleted = () => new Response(null, { status: 204 });
const created = { path: queries, method: 'POST', respond: () => json(query) };
const ran = { path: runPath, method: 'POST', respond: () => json(running(reportId, 'QUEUED')) };
const cleanupList = { path: queries, respond: noQueries };
const savedQuery = { path: queryPath, respond: () => json(query) };   // format XLSX, no notifications: run in place

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  assert.equal(content.length, 1);
  return content[0].text;
}
const types = (events: readonly LogEventLine[]) => events.map(event => event.type);
const ofType = (events: readonly LogEventLine[], type: string) => events.filter(event => event.type === type);
const pathCount = (requests: readonly { url: URL }[], path: string) => requests.filter(request => request.url.pathname === path).length;

test('A-1 a DV360 read retries three 503s with backoff, then returns the server_error message', async t => {
  const h = await composition(t, { random: () => 0.5 });
  for (let i = 0; i < 3; i++) h.steps.push({ path: partners, respond: () => googleError(503) });
  const { result, events, tool } = await h.call('list_partners');
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.sleeps, [500, 1000]);
  assert.equal(result.isError, true);
  assert.equal(textOf(result), DV.server_error);
  assert.ok(h.now() - START <= 45_000);
  assert.deepEqual(types(events), [
    'google.request', 'google.retry', 'google.request', 'google.retry', 'google.request', 'google.give_up', 'tool.call',
  ]);
  for (const request of ofType(events, 'google.request')) assert.deepEqual([request.outcome, request.httpStatus], ['server_error', 503]);
  assert.deepEqual(ofType(events, 'google.retry').map(event => event.delayMs), [500, 1000]);
  assert.deepEqual([ofType(events, 'google.give_up')[0].reason, ofType(events, 'google.give_up')[0].attempts], ['attempts', 3]);
  assert.deepEqual([tool.outcome, tool.kind], ['error', 'server_error']);
  checkRedaction(h.lines);
});

test('A-2 a DV360 read that keeps timing out gets a retry clipped to the 45 s budget', async t => {
  const h = await composition(t, { random: () => 0.5, mockTimeouts: true });
  h.steps.push({ path: partners, timesOut: true }, { path: partners, timesOut: true });
  const { result, events, tool } = await h.call('list_partners');
  // First attempt: the full 30 s. Retry after a 500 ms wait (0.5 × 1 000): deadline − now = 45 000 − 30 500.
  assert.deepEqual(h.timeouts, [30_000, 14_500]);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.sleeps, [500]);
  assert.equal(h.now() - START, 45_000);
  assert.equal(textOf(result), DV.timeout);
  const [giveUp] = ofType(events, 'google.give_up');
  assert.deepEqual([giveUp.reason, giveUp.kind, giveUp.attempts], ['budget', 'timeout', 2]);
  assert.deepEqual([tool.outcome, tool.kind], ['error', 'timeout']);
  checkRedaction(h.lines);
});

for (const [label, failure] of [
  ['a timeout', { timesOut: true }],
  ['a 503', { respond: () => googleError(503) }],
  ['a network error', { respond: () => { throw new TypeError('fetch failed'); } }],
] as const) {
  test(`A-3 run_report: queries.run ends in ${label}; the single lookup finds the report`, async t => {
    const h = await composition(t, { mockTimeouts: true });
    h.steps.push(created, { path: runPath, method: 'POST', ...failure }, {
      path: reportsPath, respond: () => json({ reports: [running()] }),
      check: url => { assert.equal(url.searchParams.get('pageSize'), '10'); assert.equal(url.searchParams.get('orderBy'), null); },
    }, cleanupList);
    const { result, events } = await h.call('run_report', runArgs);
    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.ok(text.includes(`Ticket: queryId ${queryId}, reportId ${reportId}.`));
    assert.ok(text.includes(RECOVERED));
    assert.equal(pathCount(h.requests, runPath), 1);
    assert.equal(pathCount(h.requests, reportsPath), 1);
    assert.equal(h.requests.find(request => request.url.pathname === reportsPath)?.timeoutMs, 10_000);
    assert.equal(ofType(events, 'google.retry').length, 0);
    checkRedaction(h.lines);
  });
}

test('A-4 run_report: no report found means safe to start again; a failed lookup is not retried', async t => {
  const h = await composition(t);
  h.steps.push(created, { path: runPath, method: 'POST', respond: () => googleError(503) }, { path: reportsPath, respond: () => json({}) });
  const none = await h.call('run_report', runArgs);
  assert.equal(none.result.isError, true);
  assert.equal(textOf(none.result), NOT_STARTED);

  h.steps.push(created, { path: runPath, method: 'POST', respond: () => googleError(503) }, { path: reportsPath, respond: () => googleError(503) });
  const before = h.requests.length;
  const unknown = await h.call('run_report', runArgs);
  assert.equal(unknown.result.isError, true);
  assert.equal(textOf(unknown.result), MAY_HAVE_STARTED);
  assert.equal(pathCount(h.requests.slice(before), reportsPath), 1);
  assert.equal(ofType(unknown.events, 'google.retry').length, 0);
  checkRedaction(h.lines);
});

test('A-5 run_saved_report in place: a timed-out run is recovered only from a single unfinished report', async t => {
  const lookups: [string, () => Response, string][] = [
    ['one running', () => json({ reports: [running(), running(advertiserId, 'DONE')] }), RECOVERED_SAVED],
    ['two unfinished', () => json({ reports: [running(), running(advertiserId, 'QUEUED')] }), MAY_HAVE_STARTED],
    ['only finished', () => json({ reports: [running(reportId, 'DONE')] }), MAY_HAVE_STARTED],
    ['a 400', () => googleError(400), MAY_HAVE_STARTED],
  ];
  for (const [label, respond, expected] of lookups) {
    const h = await composition(t, { mockTimeouts: true });
    h.steps.push(savedQuery, { path: runPath, method: 'POST', timesOut: true }, {
      path: reportsPath, respond,
      check: url => { assert.equal(url.searchParams.get('orderBy'), 'key.reportId desc'); assert.equal(url.searchParams.get('pageSize'), '10'); },
    });
    if (expected === RECOVERED_SAVED) h.steps.push(cleanupList);
    const { result } = await h.call('run_saved_report', { queryId });
    const text = textOf(result);
    if (expected === RECOVERED_SAVED) {
      assert.notEqual(result.isError, true, label);
      assert.ok(text.includes(`Report started: saved report ${queryId}, run as it is.`), label);
      assert.ok(text.includes(expected), label);
    } else {
      assert.equal(result.isError, true, label);
      assert.equal(text, expected, label);
    }
    assert.equal(pathCount(h.requests, runPath), 1, label);
    assert.equal(pathCount(h.requests, reportsPath), 1, label);
    checkRedaction(h.lines);
  }
});

test('A-5 queries.create is never retried on a 503; queries.run is retried on 403 userRateLimitExceeded', async t => {
  const h = await composition(t);
  h.steps.push({ path: queries, method: 'POST', respond: () => googleError(503) });
  const create = await h.call('run_report', runArgs);
  assert.equal(create.result.isError, true);
  assert.equal(textOf(create.result), BM.server_error);
  assert.equal(h.requests.length, 1);
  assert.equal(ofType(create.events, 'google.give_up').length, 0);

  h.steps.push(savedQuery, { path: runPath, method: 'POST', respond: () => googleError(403, 'PERMISSION_DENIED', 'userRateLimitExceeded') },
    ran, cleanupList);
  const before = h.requests.length;
  const run = await h.call('run_saved_report', { queryId });
  assert.notEqual(run.result.isError, true);
  assert.ok(!textOf(run.result).includes('Warning:'));
  assert.equal(pathCount(h.requests.slice(before), runPath), 2);
  assert.equal(pathCount(h.requests.slice(before), reportsPath), 0);
  assert.deepEqual(ofType(run.events, 'google.retry').map(event => event.kind), ['rate_limited']);
  checkRedaction(h.lines);
});

test('A-6 a Bid Manager daily limit latches Bid Manager until Pacific midnight, not DV360', async t => {
  const h = await composition(t);
  h.steps.push({ path: queries, respond: () => googleError(403, 'PERMISSION_DENIED', 'dailyLimitExceeded') });
  const first = await h.call('list_saved_reports');
  assert.equal(h.requests.length, 1);
  assert.equal(textOf(first.result), BM.daily_limit);
  assert.deepEqual(types(first.events), ['google.request', 'google.latched', 'tool.call']);
  const midnight = nextPacificMidnight(START);
  assert.equal(new Date(midnight).toISOString(), '2026-11-14T08:00:00.000Z');
  assert.equal(ofType(first.events, 'google.latched')[0].untilMs, midnight);

  for (const [name, args] of [['run_report', runArgs], ['get_report', { queryId, reportId }], ['list_saved_reports', {}]] as const) {
    const blocked = await h.call(name, args);
    assert.equal(h.requests.length, 1, name);
    assert.equal(blocked.result.isError, true, name);
    assert.equal(textOf(blocked.result), BM.daily_limit, name);
    assert.deepEqual(types(blocked.events), ['google.latch_blocked', 'tool.call'], name);
  }
  h.steps.push({ path: partners, respond: partnerList });
  assert.notEqual((await h.call('list_partners')).result.isError, true);

  h.advance(midnight + 1 - h.now());
  h.steps.push({ path: queries, respond: () => json({ queries: [query] }) });
  const reset = await h.call('list_saved_reports');
  assert.notEqual(reset.result.isError, true);
  assert.deepEqual(types(reset.events), ['google.request', 'tool.call']);
  checkRedaction(h.lines);
});

test('A-6 a daily limit during cleanup still returns the ticket, and latches', async t => {
  const h = await composition(t);
  h.steps.push(created, ran, { path: queries, respond: () => googleError(403, 'PERMISSION_DENIED', 'dailyLimitExceeded') });
  const started = await h.call('run_report', runArgs);
  assert.notEqual(started.result.isError, true);
  assert.ok(textOf(started.result).includes(`Ticket: queryId ${queryId}, reportId ${reportId}.`));
  assert.ok(textOf(started.result).includes(CLEANUP_WARNING));
  assert.equal(ofType(started.events, 'google.latched').length, 1);
  const blocked = await h.call('list_saved_reports');
  assert.equal(h.requests.length, 3);
  assert.deepEqual(types(blocked.events), ['google.latch_blocked', 'tool.call']);
  checkRedaction(h.lines);
});

test('A-7 DV360 429 waits for Retry-After; without it, or when it exceeds the budget, it is not retried', async t => {
  const cases: [string, Record<string, string>, number, string | undefined][] = [
    ['Retry-After: 2', { 'retry-after': '2' }, 2, undefined],
    ['no Retry-After', {}, 1, 'no_retry_after'],
    ['Retry-After: 120', { 'retry-after': '120' }, 1, 'budget'],
  ];
  for (const [label, headers, fetches, giveUpReason] of cases) {
    const h = await composition(t);
    h.steps.push({ path: partners, respond: () => googleError(429, 'RESOURCE_EXHAUSTED', 'other', headers) });
    if (fetches === 2) h.steps.push({ path: partners, respond: partnerList });
    const { result, events } = await h.call('list_partners');
    assert.equal(h.requests.length, fetches, label);
    if (giveUpReason === undefined) {
      assert.notEqual(result.isError, true, label);
      assert.deepEqual(h.sleeps, [2_000], label);
      assert.equal(h.requests[1].at - h.requests[0].at, 2_000, label);
    } else {
      assert.equal(textOf(result), DV.rate_limited, label);
      assert.deepEqual(h.sleeps, [], label);
      assert.equal(ofType(events, 'google.give_up')[0].reason, giveUpReason, label);
    }
    checkRedaction(h.lines);
  }
});

test('A-7 a Bid Manager 429 is never retried, even with Retry-After', async t => {
  const h = await composition(t);
  h.steps.push({ path: queries, respond: () => googleError(429) });
  const { result, events } = await h.call('list_saved_reports');
  assert.equal(h.requests.length, 1);
  assert.ok(textOf(result).startsWith('Bid Manager quota exceeded:'));
  assert.deepEqual(types(events), ['google.request', 'tool.call']);
  checkRedaction(h.lines);
});

test('A-8 a failed cleanup list is tried once and the ticket is still returned', async t => {
  const h = await composition(t);
  h.steps.push(created, ran, { path: queries, respond: () => googleError(503) });
  const { result, events } = await h.call('run_report', runArgs);
  assert.notEqual(result.isError, true);
  assert.ok(textOf(result).includes(`Ticket: queryId ${queryId}, reportId ${reportId}.`));
  assert.ok(textOf(result).includes(CLEANUP_WARNING));
  assert.equal(h.requests.filter(request => request.url.pathname === queries && request.method === 'GET').length, 1);
  assert.equal(ofType(events, 'google.retry').length, 0);
  checkRedaction(h.lines);
});

test('A-8 the pacer spaces concurrent Bid Manager calls, and a retry, by 250 ms', async t => {
  // Held sleeps: an instant sleep would move the shared clock before the other call's fetch runs.
  const h = await composition(t, { heldSleeps: true });
  h.steps.push({ path: queries, respond: noQueries }, { path: queries, respond: noQueries });
  const calls = [h.start('list_saved_reports'), h.start('list_saved_reports')];
  const gap = await h.nextSleep();
  assert.equal(gap.ms, 250);
  await Promise.race(calls.map(call => call.logged));
  assert.equal(h.requests.length, 1);
  gap.release();
  for (const call of calls) assert.notEqual((await call.result).isError, true);
  const logged = await Promise.all(calls.map(call => call.logged));
  assert.notEqual(logged[0].callId, logged[1].callId);
  for (const tool of logged) assert.deepEqual(types(h.eventsOf(tool.callId as string)), ['google.request', 'tool.call']);
  assert.equal(h.requests[1].at - h.requests[0].at, 250);

  const r = await composition(t);
  r.steps.push({ path: queries, respond: () => googleError(503) }, { path: queries, respond: noQueries });
  assert.notEqual((await r.call('list_saved_reports')).result.isError, true);
  assert.deepEqual(r.sleeps, [0, 250]);   // zero backoff (random 0), then the pacer gap
  assert.equal(r.requests[1].at - r.requests[0].at, 250);
  checkRedaction(h.lines);
  checkRedaction(r.lines);
});

// A-9 (a client cancel over stateless HTTP does not reach the running call) applies only to an HTTP transport.
// Over stdio one server serves the whole connection, so a cancel reaches the call: A-10 shows the abort.
test('A-10 an abort during a retry backoff stops the retries', async t => {
  const h = await composition(t, { heldSleeps: true, random: () => 0.5 });
  h.steps.push({ path: partners, respond: () => googleError(503) });
  const controller = new AbortController();
  const call = h.start('list_partners', {}, { signal: controller.signal });
  const sleep = await h.nextSleep();
  assert.equal(sleep.ms, 500);
  controller.abort();
  await assert.rejects(call.result);
  const tool = await call.logged;
  // The caller's signal aborted; nothing timed out (no timeout was due, and the clock did not move).
  assert.equal(sleep.signal?.aborted, true);
  assert.equal(h.now(), START);
  assert.equal(h.requests.length, 1);
  const events = h.eventsOf(tool.callId as string);
  assert.deepEqual(types(events), ['google.request', 'google.retry', 'google.give_up', 'tool.call']);
  assert.equal(ofType(events, 'google.give_up')[0].reason, 'cancelled');
  assert.deepEqual([tool.outcome, tool.kind], ['error', 'server_error']);
  checkRedaction(h.lines);
});

test('A-10 an abort during a pacer wait means the request is never sent', async t => {
  const h = await composition(t, { heldSleeps: true });
  h.steps.push({ path: queries, respond: noQueries });
  await h.call('list_saved_reports');
  const controller = new AbortController();
  const call = h.start('list_saved_reports', {}, { signal: controller.signal });
  const sleep = await h.nextSleep();
  assert.equal(sleep.ms, 250);
  controller.abort();
  await assert.rejects(call.result);
  const tool = await call.logged;
  assert.equal(sleep.signal?.aborted, true);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(types(h.eventsOf(tool.callId as string)), ['tool.call']);
  assert.equal(tool.outcome, 'error');
  checkRedaction(h.lines);
});

test('A-11 get_report: a persistent 503 on the status call is tried 3 times', async t => {
  const h = await composition(t);
  for (let i = 0; i < 3; i++) h.steps.push({ path: reportPath, respond: () => googleError(503) });
  const { result, events } = await h.call('get_report', { queryId, reportId });
  assert.equal(h.requests.length, 3);
  assert.equal(result.isError, true);
  assert.equal(textOf(result), BM.server_error);
  assert.equal(ofType(events, 'google.give_up')[0].reason, 'attempts');
  checkRedaction(h.lines);
});

test('A-11 get_report: a running report is polled at 0, 7 and 19 s and answers pending at 21 s', async t => {
  const h = await composition(t);
  for (let i = 0; i < 3; i++) h.steps.push({ path: reportPath, takes: 2_000, respond: () => json(running()) });
  const { result } = await h.call('get_report', { queryId, reportId });
  assert.deepEqual(h.requests.map(request => request.at - START), [0, 7_000, 19_000]);
  assert.deepEqual(h.sleeps, [5_000, 10_000]);   // the next 20 s wait is refused: 21 + 20 > 40
  assert.equal(h.now() - START, 21_000);
  assert.notEqual(result.isError, true);
  assert.ok(textOf(result).includes('is still RUNNING after waiting 21 s in this call.'));
  checkRedaction(h.lines);
});

test('A-11 get_report: slow failures have their retry timeouts clipped to the 40 s deadline', async t => {
  const timedOut = await composition(t, { mockTimeouts: true });
  timedOut.steps.push({ path: reportPath, timesOut: true }, { path: reportPath, timesOut: true });
  const first = await timedOut.call('get_report', { queryId, reportId });
  assert.deepEqual(timedOut.timeouts, [30_000, 10_000]);   // the retry gets 40 000 − 30 000
  assert.equal(timedOut.requests.length, 2);
  assert.equal(timedOut.now() - START, 40_000);
  assert.equal(textOf(first.result), BM.timeout);
  assert.equal(ofType(first.events, 'google.give_up')[0].reason, 'budget');

  const slow = await composition(t, { mockTimeouts: true });
  for (let i = 0; i < 3; i++) slow.steps.push({ path: reportPath, takes: 18_000, respond: () => googleError(503) });
  const second = await slow.call('get_report', { queryId, reportId });
  // 503 at 18 s; retry clipped to 22 s, 503 at 36 s; retry clipped to 4 s, which times out at 40 s.
  assert.deepEqual(slow.timeouts, [30_000, 22_000, 4_000]);
  assert.deepEqual(slow.requests.map(request => request.at - START), [0, 18_000, 36_000]);
  assert.equal(slow.now() - START, 40_000);
  assert.deepEqual(ofType(second.events, 'google.request').map(event => event.outcome), ['server_error', 'server_error', 'timeout']);
  assert.equal(textOf(second.result), BM.timeout);
  assert.equal(ofType(second.events, 'google.give_up')[0].reason, 'attempts');
  checkRedaction(timedOut.lines);
  checkRedaction(slow.lines);
});

test('A-12 the never-retried failures make exactly one request; unavailable credentials are retried', async t => {
  const h = await composition(t);
  const cases: [string, string, () => Response, string][] = [
    ['DV360 400', partners, () => googleError(400), `Google rejected the request: ${title}`],
    ['DV360 401', partners, () => googleError(401), DV.unauthenticated],
    ['DV360 403 without a known reason', partners, () => googleError(403), DV.access_denied],
    ['DV360 404', partners, () => googleError(404), DV.not_found],
    ['Bid Manager 400', queries, () => googleError(400), `Google rejected the request: ${title}`],
    ['expired credentials', partners, () => { throw new GoogleCredentialsError('expired_or_revoked'); }, CREDENTIALS.expired_or_revoked],
  ];
  for (const [label, path, respond, message] of cases) {
    const before = h.requests.length;
    h.steps.push({ path, respond });
    const { result, events } = await h.call(path === queries ? 'list_saved_reports' : 'list_partners');
    assert.equal(h.requests.length - before, 1, label);
    assert.equal(result.isError, true, label);
    assert.equal(textOf(result), message, label);
    assert.deepEqual(types(events), ['google.request', 'tool.call'], label);
  }
  const before = h.requests.length;
  for (let i = 0; i < 3; i++) h.steps.push({ path: partners, respond: () => { throw new GoogleCredentialsError('unavailable'); } });
  const unavailable = await h.call('list_partners');
  assert.equal(h.requests.length - before, 3);
  assert.equal(textOf(unavailable.result), CREDENTIALS.unavailable);
  assert.equal(ofType(unavailable.events, 'google.retry').length, 2);
  checkRedaction(h.lines);
});

// The cleanup deadline guard prevents old-query maintenance after a slow report start.
test('A-13 a slow report start skips cleanup after the deadline', async t => {
  const h = await composition(t);
  const slow = { takes: 29_000 };
  h.steps.push({ ...created, ...slow }, { ...ran, ...slow });
  const { result } = await h.call('run_report', runArgs);
  assert.notEqual(result.isError, true);
  assert.ok(textOf(result).includes(`Ticket: queryId ${queryId}, reportId ${reportId}.`));
  assert.equal(h.requests.length, 2);
  assert.equal(h.now() - START, 58_000);
  assert.ok(h.requests.every(request => request.method !== 'DELETE' && !(request.url.pathname === queries && request.method === 'GET')));
  checkRedaction(h.lines);
});

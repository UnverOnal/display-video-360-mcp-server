import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleCredentialsError, type AuthorizedFetch, type AuthorizedRequestInit } from './auth.js';
import { GoogleApiError, type GoogleApiErrorDiagnostics, type GoogleApiErrorKind } from './errors.js';
import type { LogEvent } from './log.js';
import { createGetJson, createSendJson, type RequestErrors, type RequestOptions, type RequestRuntime } from './request.js';
import { NO_RETRIES, createDailyLatch, createPacer, type RetryPolicy } from './retry.js';

class TestError extends GoogleApiError {
  readonly tag: string;
  constructor(tag: string, kind: GoogleApiErrorKind, diagnostics?: GoogleApiErrorDiagnostics) {
    super(kind, tag, diagnostics);
    this.tag = tag;
  }
}

function kindFor(status: number, text: string): GoogleApiErrorKind {
  if (status === 403) {
    if (text.includes('dailyLimitExceeded')) return 'daily_limit';
    if (text.includes('userRateLimitExceeded')) return 'rate_limited';
    return 'access_denied';
  }
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status === 404) return 'not_found';
  return 'invalid_request';
}

const classified: [number, string][] = [];
const created: TestError[] = [];
const errors: RequestErrors<TestError> = {
  classify: (status, text) => {
    classified.push([status, text]);
    const error = new TestError(`classified:${status}`, kindFor(status, text), { httpStatus: status, reasons: [], legacyReasons: [] });
    created.push(error);
    return error;
  },
  create: kind => new TestError(`created:${kind}`, kind),
};

type Call = { url: string; init?: AuthorizedRequestInit };
function setup(respond: (call: Call) => Promise<Response> | Response, extra: Partial<RequestOptions<TestError>> = {}) {
  const calls: Call[] = [];
  const fetch: AuthorizedFetch = async (url, init) => { calls.push({ url, init }); return respond({ url, init }); };
  const options: RequestOptions<TestError> = { api: 'bidmanager', fetch, timeoutMs: 1_000, errors, retry: NO_RETRIES, ...extra };
  return { calls, getJson: createGetJson(options), sendJson: createSendJson(options) };
}

const GET = { operation: 'test.get' } as const;
const SEND = { operation: 'test.send', idempotency: 'idempotent' } as const;

// --- Step 1 behaviour of a single attempt (retries off) ---

test('getJson sends only method and a fresh signal, and returns parsed JSON', async () => {
  const { calls, getJson } = setup(() => new Response('{"a":1}'));
  assert.deepEqual(await getJson('https://x/1', GET), { a: 1 });
  await getJson('https://x/2', GET);
  assert.deepEqual(Object.keys(calls[0].init ?? {}).sort(), ['method', 'signal']);
  assert.equal(calls[0].init?.method, 'GET');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.notEqual(calls[0].init?.signal, calls[1].init?.signal);
});

test('sendJson passes method, headers, and body through with the signal', async () => {
  const { calls, sendJson } = setup(() => new Response('{}'));
  await sendJson('https://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"b":2}' }, SEND);
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(calls[0].init?.headers, { 'content-type': 'application/json' });
  assert.equal(calls[0].init?.body, '{"b":2}');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

test('ignoreBody returns undefined without reading an OK body, but still classifies errors', async () => {
  let reads = 0;
  const ok = new Response('x');
  ok.text = async () => { reads += 1; throw new Error('must not read'); };
  const first = setup(() => ok);
  assert.equal(await first.sendJson('https://x', { method: 'DELETE' }, { ...SEND, ignoreBody: true }), undefined);
  assert.equal(reads, 0);

  classified.length = 0;
  const second = setup(() => new Response('nope', { status: 404 }));
  await assert.rejects(second.sendJson('https://x', { method: 'DELETE' }, { ...SEND, ignoreBody: true }),
    (error: TestError) => error.tag === 'classified:404');
  assert.deepEqual(classified, [[404, 'nope']]);
});

test('GoogleCredentialsError from fetch is rethrown as the same object', async () => {
  const credentialsError = new GoogleCredentialsError('unavailable');
  const { getJson } = setup(() => { throw credentialsError; });
  await assert.rejects(getJson('https://x', GET), error => error === credentialsError);
});

test('a TimeoutError becomes timeout; other failures from fetch or text() become network', async () => {
  const timeout = setup(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
  await assert.rejects(timeout.getJson('https://x', GET), (error: TestError) => error.tag === 'created:timeout');

  const failing = setup(() => { throw new Error('boom'); });
  await assert.rejects(failing.getJson('https://x', GET), (error: TestError) => error.tag === 'created:network');

  const response = new Response('x');
  response.text = async () => { throw new Error('read failed'); };
  const reading = setup(() => response);
  await assert.rejects(reading.getJson('https://x', GET), (error: TestError) => error.tag === 'created:network');
});

test('a non-OK response is classified once with the exact status and text', async () => {
  classified.length = 0;
  const { getJson } = setup(() => new Response('{"error":1}', { status: 503 }));
  await assert.rejects(getJson('https://x', GET), (error: TestError) => error.tag === 'classified:503');
  assert.deepEqual(classified, [[503, '{"error":1}']]);
});

test('invalid JSON on an OK response becomes unexpected_response', async () => {
  const { getJson } = setup(() => new Response('<html>'));
  await assert.rejects(getJson('https://x', GET), (error: TestError) => error.tag === 'created:unexpected_response');
});

// --- The retry loop ---

const START = Date.parse('2026-11-12T12:00:00Z');

/** Fake clock, instant sleep that advances it, fixed random 0.5, and a recording logger. */
function loopSetup(
  responses: readonly (Response | Error | (() => Response))[],
  extra: Partial<RequestOptions<TestError>> & { policy?: RetryPolicy; runtime?: Partial<RequestRuntime>; clock?: { t: number } } = {},
) {
  const clock = extra.clock ?? { t: START };
  const sleeps: number[] = [];
  const events: LogEvent[] = [];
  const fetchTimes: number[] = [];
  let index = 0;
  const runtime: RequestRuntime = {
    now: () => clock.t,
    sleep: async ms => { sleeps.push(ms); clock.t += ms; },
    random: () => 0.5,
    logger: event => events.push(event),
    ...extra.runtime,
  };
  const { policy, runtime: _runtime, clock: _clock, ...options } = extra;
  const result = setup(() => {
    fetchTimes.push(clock.t);
    const next = responses[Math.min(index++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next.clone();
  }, { retry: policy ?? { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 }, runtime, ...options });
  return { ...result, clock, sleeps, events, fetchTimes, runtime };
}

const status = (code: number, body = '{}', headers?: Record<string, string>) => new Response(body, { status: code, headers });
const ok = (body = '{"ok":true}') => new Response(body);
const timeoutError = () => Object.assign(new Error('t'), { name: 'TimeoutError' });
const requestEvent = (attempt: number, outcome: string, httpStatus?: number, operation = 'test.get') => ({
  type: 'google.request', api: 'bidmanager', operation, attempt, durationMs: 0, outcome,
  ...(httpStatus === undefined ? {} : { httpStatus }),
});

test('a GET retried after two 503s returns the value, logging both retries with their backoff', async () => {
  const h = loopSetup([status(503), status(503), ok()]);
  assert.deepEqual(await h.getJson('https://x', GET), { ok: true });
  assert.equal(h.calls.length, 3);
  // Full jitter with random 0.5: floor(0.5 × 1000), then floor(0.5 × 2000).
  assert.deepEqual(h.sleeps, [500, 1_000]);
  assert.deepEqual(h.events, [
    requestEvent(1, 'server_error', 503),
    { type: 'google.retry', api: 'bidmanager', operation: 'test.get', attempt: 1, kind: 'server_error', delayMs: 500 },
    requestEvent(2, 'server_error', 503),
    { type: 'google.retry', api: 'bidmanager', operation: 'test.get', attempt: 2, kind: 'server_error', delayMs: 1_000 },
    requestEvent(3, 'ok', 200),
  ]);
});

test('three 503s throw the third classified error itself and log one give_up(attempts)', async () => {
  const h = loopSetup([status(503)]);
  created.length = 0;
  await assert.rejects(h.getJson('https://x', GET), error => error === created[2]);
  assert.equal(created.length, 3);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.events.filter(event => event.type === 'google.give_up'), [
    { type: 'google.give_up', api: 'bidmanager', operation: 'test.get', attempts: 3, kind: 'server_error', reason: 'attempts' },
  ]);
});

test('rate_limit_only: a 503 and a timeout are not retried and log only their request', async () => {
  for (const failure of [status(503), timeoutError()]) {
    const h = loopSetup([failure, ok()]);
    await assert.rejects(h.sendJson('https://x', { method: 'POST' }, { operation: 'test.run', idempotency: 'rate_limit_only' }));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.events, [requestEvent(1, failure instanceof Response ? 'server_error' : 'timeout', failure instanceof Response ? 503 : undefined, 'test.run')]);
  }
});

test('rate_limit_only: 403 userRateLimitExceeded and unavailable credentials are retried', async () => {
  const limited = loopSetup([status(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}'), ok()]);
  assert.deepEqual(await limited.sendJson('https://x', { method: 'POST' }, { operation: 'test.run', idempotency: 'rate_limit_only' }), { ok: true });
  assert.equal(limited.calls.length, 2);
  assert.deepEqual(limited.events, [
    requestEvent(1, 'rate_limited', 403, 'test.run'),
    { type: 'google.retry', api: 'bidmanager', operation: 'test.run', attempt: 1, kind: 'rate_limited', delayMs: 500 },
    requestEvent(2, 'ok', 200, 'test.run'),
  ]);

  const credentials = loopSetup([new GoogleCredentialsError('unavailable'), ok()]);
  assert.deepEqual(await credentials.sendJson('https://x', { method: 'POST' }, { operation: 'test.run', idempotency: 'rate_limit_only' }), { ok: true });
  assert.equal(credentials.calls.length, 2);
  assert.deepEqual(credentials.events, [
    requestEvent(1, 'credentials_unavailable', undefined, 'test.run'),
    { type: 'google.retry', api: 'bidmanager', operation: 'test.run', attempt: 1, kind: 'credentials_unavailable', delayMs: 500 },
    requestEvent(2, 'ok', 200, 'test.run'),
  ]);
});

test('429 without Retry-After is tried once and logs give_up(no_retry_after)', async () => {
  const h = loopSetup([status(429), ok()]);
  await assert.rejects(h.getJson('https://x', GET), (error: TestError) => error.kind === 'rate_limited');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.events, [
    requestEvent(1, 'rate_limited', 429),
    { type: 'google.give_up', api: 'bidmanager', operation: 'test.get', attempts: 1, kind: 'rate_limited', reason: 'no_retry_after' },
  ]);
});

test('429 with Retry-After: 3 waits 3 000 ms and retries', async () => {
  const h = loopSetup([status(429, '{}', { 'retry-after': '3' }), ok()]);
  assert.deepEqual(await h.getJson('https://x', GET), { ok: true });
  assert.deepEqual(h.sleeps, [3_000]);
  assert.equal(h.calls.length, 2);
});

test('429 with Retry-After: 120 inside a 45 s deadline gives up for budget', async () => {
  const h = loopSetup([status(429, '{}', { 'retry-after': '120' }), ok()]);
  await assert.rejects(h.getJson('https://x', { ...GET, deadline: START + 45_000 }));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.events, [
    requestEvent(1, 'rate_limited', 429),
    { type: 'google.give_up', api: 'bidmanager', operation: 'test.get', attempts: 1, kind: 'rate_limited', reason: 'budget' },
  ]);
});

test('the first attempt runs even when the deadline has already passed', async () => {
  const h = loopSetup([ok()]);
  assert.deepEqual(await h.getJson('https://x', { ...GET, deadline: START - 1 }), { ok: true });
  assert.equal(h.calls.length, 1);
});

test('a retry needs its delay plus 1 000 ms of budget: allowed exactly at the edge, refused 1 ms past it', async () => {
  // Backoff with random 0.5 is 500 ms, so the edge is START + 1 500.
  const atEdge = loopSetup([status(503), ok()]);
  assert.deepEqual(await atEdge.getJson('https://x', { ...GET, deadline: START + 1_500 }), { ok: true });
  assert.equal(atEdge.calls.length, 2);

  const past = loopSetup([status(503), ok()]);
  await assert.rejects(past.getJson('https://x', { ...GET, deadline: START + 1_499 }));
  assert.equal(past.calls.length, 1);
  assert.deepEqual(past.events, [requestEvent(1, 'server_error', 503),
    { type: 'google.give_up', api: 'bidmanager', operation: 'test.get', attempts: 1, kind: 'server_error', reason: 'budget' }]);
});

test("a retry's attempt timeout is clipped to the remaining budget; the first attempt's is not", async t => {
  const delays: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (delay: number) => { delays.push(delay); return new AbortController().signal; });
  const h = loopSetup([status(503), ok()], { timeoutMs: 30_000 });
  await h.getJson('https://x', { ...GET, deadline: START + 5_000 });
  // First attempt: the full 30 s although only 5 s are budgeted. Retry after 500 ms: 4 500 ms left.
  assert.deepEqual(delays, [30_000, 4_500]);
});

test('call.timeoutMs overrides the first attempt timeout', async t => {
  const delays: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (delay: number) => { delays.push(delay); return new AbortController().signal; });
  const h = loopSetup([ok()], { timeoutMs: 30_000 });
  await h.getJson('https://x', { ...GET, timeoutMs: 10_000 });
  assert.deepEqual(delays, [10_000]);
});

test('an already aborted call signal throws a created timeout without fetching', async () => {
  const h = loopSetup([ok()]);
  await assert.rejects(h.getJson('https://x', { ...GET, signal: AbortSignal.abort() }), (error: TestError) => error.tag === 'created:timeout');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.events, []);
});

test('an abort during a backoff wait stops, throws the last error, and logs give_up(cancelled)', async () => {
  const controller = new AbortController();
  created.length = 0;
  const h = loopSetup([status(503), ok()], { runtime: { sleep: async () => controller.abort() } });
  await assert.rejects(h.getJson('https://x', { ...GET, signal: controller.signal }), error => error === created[0]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.events.at(-1), {
    type: 'google.give_up', api: 'bidmanager', operation: 'test.get', attempts: 1, kind: 'server_error', reason: 'cancelled',
  });
});

test('without a call signal the fetch signal is the timeout signal; with one, it aborts when either does', async t => {
  const timeouts: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', () => { const controller = new AbortController(); timeouts.push(controller); return controller.signal; });
  const h = loopSetup([ok()]);
  await h.getJson('https://x', GET);
  assert.equal(h.calls[0].init?.signal, timeouts[0].signal);

  const caller = new AbortController();
  await h.getJson('https://x', { ...GET, signal: caller.signal });
  const combined = h.calls[1].init?.signal;
  assert.ok(combined instanceof AbortSignal);
  assert.notEqual(combined, timeouts[1].signal);
  assert.notEqual(combined, caller.signal);
  caller.abort();
  assert.equal(combined.aborted, true);

  await h.getJson('https://x', { ...GET, signal: new AbortController().signal });
  const other = h.calls[2].init?.signal;
  assert.equal(other?.aborted, false);
  timeouts[2].abort(Object.assign(new Error('t'), { name: 'TimeoutError' }));
  assert.equal(other?.aborted, true);
});

test('403 dailyLimitExceeded trips the latch; later calls fail without fetching until Pacific midnight', async () => {
  const clock = { t: START };
  const latch = createDailyLatch(() => clock.t);
  const h = loopSetup([status(403, '{"error":{"errors":[{"reason":"dailyLimitExceeded"}]}}'), ok()], { latch, clock });
  await assert.rejects(h.getJson('https://x', GET), (error: TestError) => error.kind === 'daily_limit');
  const untilMs = Date.parse('2026-11-13T08:00:00Z');
  assert.deepEqual(h.events, [requestEvent(1, 'daily_limit', 403), { type: 'google.latched', api: 'bidmanager', operation: 'test.get', untilMs }]);

  await assert.rejects(h.getJson('https://x', GET), (error: TestError) => error.tag === 'created:daily_limit');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.events.at(-1), { type: 'google.latch_blocked', api: 'bidmanager', operation: 'test.get' });

  clock.t = untilMs;
  assert.deepEqual(await h.getJson('https://x', GET), { ok: true });
  assert.equal(h.calls.length, 2);
});

test('the pacer spaces two calls on one helper by at least 250 ms on the fake clock', async () => {
  const clock = { t: START };
  const sleep = async (ms: number) => { clock.t += ms; };
  const pacer = createPacer({ minGapMs: 250, now: () => clock.t, sleep });
  const h = loopSetup([ok()], { pacer, clock, runtime: { sleep } });
  // Back to back with no time passing: the second must wait for its slot.
  await h.getJson('https://x/1', GET);
  await h.getJson('https://x/2', GET);
  assert.equal(h.fetchTimes.length, 2);
  assert.ok(h.fetchTimes[1] - h.fetchTimes[0] >= 250, String(h.fetchTimes));
});

test("a retry's attempt timeout is clipped to the budget left after its pacer wait", async t => {
  const delays: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (delay: number) => { delays.push(delay); return new AbortController().signal; });
  const clock = { t: START };
  const sleep = async (ms: number) => { clock.t += ms; };
  const pacer = createPacer({ minGapMs: 1_000, now: () => clock.t, sleep });
  const h = loopSetup([status(503), ok()], { timeoutMs: 30_000, pacer, clock, runtime: { sleep } });
  await h.getJson('https://x', { ...GET, deadline: START + 5_000 });
  // Backoff ends at +500 ms, the pacer slot at +1 000 ms: 4 000 ms are left, not the 4 500 ms seen before the wait.
  assert.deepEqual(delays, [30_000, 4_000]);
  assert.deepEqual(h.fetchTimes, [START, START + 1_000]);
});

test("a retry's pacer wait respects the deadline", async () => {
  const clock = { t: START };
  const sleep = async (ms: number) => { clock.t += ms; };
  // A 5 s gap puts the retry's slot past the 2 s deadline, although the backoff itself fits.
  const pacer = createPacer({ minGapMs: 5_000, now: () => clock.t, sleep });
  created.length = 0;
  const h = loopSetup([status(503), ok()], { pacer, clock, runtime: { sleep } });
  await assert.rejects(h.getJson('https://x', { ...GET, deadline: START + 2_000 }), error => error === created[0]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.events.at(-1), {
    type: 'google.give_up', api: 'bidmanager', operation: 'test.get', attempts: 1, kind: 'server_error', reason: 'budget',
  });
});

test('ignoreBody on a retried DELETE does not read the OK attempt body', async () => {
  let reads = 0;
  const h = loopSetup([status(503), () => {
    const response = new Response('x');
    response.text = async () => { reads += 1; throw new Error('must not read'); };
    return response;
  }]);
  assert.equal(await h.sendJson('https://x', { method: 'DELETE' }, { ...SEND, ignoreBody: true }), undefined);
  assert.equal(h.calls.length, 2);
  assert.equal(reads, 0);
});

// M5 step 3: request event contract, independent of the older retry assertions.
test('request durations measure each attempt and exclude pacer and retry waits', async () => {
  const clock = { t: START };
  const pacer = createPacer({ minGapMs: 1000, now: () => clock.t, sleep: async ms => { clock.t += ms; } });
  const h = loopSetup([() => { clock.t += 12.6; return status(503); }, () => { clock.t += 7.2; return ok(); }], { clock, pacer });
  await h.getJson('https://x', GET);
  assert.deepEqual(h.events, [
    { ...requestEvent(1, 'server_error', 503), durationMs: 13 },
    { type: 'google.retry', api: 'bidmanager', operation: 'test.get', attempt: 1, kind: 'server_error', delayMs: 500 },
    { ...requestEvent(2, 'ok', 200), durationMs: 7 },
  ]);
});

test('request HTTP diagnostics use fixed allowlists and deduplicate unknown reasons', async () => {
  for (const googleStatus of ['NOT_FOUND', 'CUSTOMER_SECRET']) {
    const h = loopSetup([status(404)], { errors: {
      ...errors,
      classify: () => new TestError('diagnostic', 'not_found', {
        httpStatus: 404, status: googleStatus,
        reasons: [{ reason: 'dailyLimitExceeded' }, { reason: 'privateTokenABC123' }, { reason: 'anotherSecret' }],
        legacyReasons: ['userRateLimitExceeded', 'privateLegacyABC123', 'dailyLimitExceeded'],
      }),
    } });
    await assert.rejects(h.getJson('https://x', GET));
    assert.deepEqual(h.events, [{ ...requestEvent(1, 'not_found', 404), status: googleStatus === 'NOT_FOUND' ? 'NOT_FOUND' : 'OTHER',
      reasons: ['dailyLimitExceeded', 'other', 'userRateLimitExceeded'] }]);
  }
});

test('request events include ignoreBody HTTP status and omit HTTP status for transport and credential failures', async () => {
  const ignored = loopSetup([new Response(null, { status: 204 })]);
  await ignored.sendJson('https://x', { method: 'DELETE' }, { ...SEND, ignoreBody: true });
  assert.deepEqual(ignored.events, [requestEvent(1, 'ok', 204, 'test.send')]);
  for (const [error, outcome] of [
    [timeoutError(), 'timeout'], [new TypeError('privateTokenABC123'), 'network'],
    [new GoogleCredentialsError('unavailable'), 'credentials_unavailable'],
  ] as const) {
    const h = loopSetup([error]);
    await assert.rejects(h.getJson('https://x', { ...GET, singleAttempt: true }));
    assert.deepEqual(h.events, [requestEvent(1, outcome)]);
  }
});

test('callId is present on all five event types and no request is logged for latch-blocked calls', async () => {
  const callId = '0123456789abcdef';
  const retried = loopSetup([status(503)], { policy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 8000 } });
  await assert.rejects(retried.getJson('https://x', { ...GET, callId }));
  assert.deepEqual(retried.events, [
    { ...requestEvent(1, 'server_error', 503), callId },
    { type: 'google.retry', api: 'bidmanager', operation: 'test.get', attempt: 1, kind: 'server_error', delayMs: 500, callId },
    { ...requestEvent(2, 'server_error', 503), callId },
    { type: 'google.give_up', api: 'bidmanager', operation: 'test.get', attempts: 2, kind: 'server_error', reason: 'attempts', callId },
  ]);
  const clock = { t: START };
  const latch = createDailyLatch(() => clock.t);
  const latched = loopSetup([status(403, 'dailyLimitExceeded')], { latch, clock });
  await assert.rejects(latched.getJson('https://x', { ...GET, callId }));
  await assert.rejects(latched.getJson('https://x', { ...GET, callId }));
  assert.deepEqual(latched.events, [
    { ...requestEvent(1, 'daily_limit', 403), callId },
    { type: 'google.latched', api: 'bidmanager', operation: 'test.get', untilMs: Date.parse('2026-11-13T08:00:00Z'), callId },
    { type: 'google.latch_blocked', api: 'bidmanager', operation: 'test.get', callId },
  ]);
});

test('pacer refusal and pre-aborted calls emit no request event', async () => {
  const refused = loopSetup([ok()], { pacer: { wait: async () => false } });
  await assert.rejects(refused.getJson('https://x', GET));
  assert.deepEqual(refused.events, []);
  assert.deepEqual(refused.calls, []);
  const controller = new AbortController();
  controller.abort();
  const aborted = loopSetup([ok()]);
  await assert.rejects(aborted.getJson('https://x', { ...GET, signal: controller.signal }));
  assert.deepEqual(aborted.events, []);
  assert.deepEqual(aborted.calls, []);
});

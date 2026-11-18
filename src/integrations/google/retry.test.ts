import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleCredentialsError } from './auth.js';
import { BidManagerError } from '../bidmanager/errors.js';
import { Dv360Error } from '../dv360/errors.js';
import {
  BID_MANAGER_MIN_GAP_MS, DEFAULT_RETRY_POLICY, MIN_RETRY_ATTEMPT_MS, NO_RETRIES,
  createDailyLatch, createPacer, decideRetry, failureClass, nextPacificMidnight, parseRetryAfter,
  type FailureClass, type Idempotency,
} from './retry.js';

const diag = (httpStatus: number) => ({ httpStatus, reasons: [], legacyReasons: [] });

test('policy constants', () => {
  assert.deepEqual(DEFAULT_RETRY_POLICY, { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 });
  assert.deepEqual(NO_RETRIES, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
  assert.equal(MIN_RETRY_ATTEMPT_MS, 1_000);
  assert.equal(BID_MANAGER_MIN_GAP_MS, 250);
});

const CLASSES: [string, unknown, FailureClass, string][] = [
  ['credentials unavailable', new GoogleCredentialsError('unavailable'), 'always', 'credentials_unavailable'],
  ['credentials not_found', new GoogleCredentialsError('not_found'), 'never', 'credentials_not_found'],
  ['credentials expired_or_revoked', new GoogleCredentialsError('expired_or_revoked'), 'never', 'credentials_expired_or_revoked'],
  ['DV360 429 rate_limited', new Dv360Error('rate_limited', undefined, diag(429)), 'with_retry_after', 'rate_limited'],
  ['403 userRateLimitExceeded', new BidManagerError('rate_limited', undefined, diag(403)), 'always', 'rate_limited'],
  ['rate_limited without status', new Dv360Error('rate_limited'), 'always', 'rate_limited'],
  ['server_error', new BidManagerError('server_error', undefined, diag(503)), 'idempotent_only', 'server_error'],
  ['timeout', new Dv360Error('timeout'), 'idempotent_only', 'timeout'],
  ['network', new BidManagerError('network'), 'idempotent_only', 'network'],
  ['Bid Manager resource_exhausted', new BidManagerError('resource_exhausted', undefined, diag(429)), 'never', 'resource_exhausted'],
  ['daily_limit', new BidManagerError('daily_limit', undefined, diag(403)), 'never', 'daily_limit'],
  ['unexpected_response', new Dv360Error('unexpected_response'), 'never', 'unexpected_response'],
  ['invalid_request', new BidManagerError('invalid_request', undefined, diag(400)), 'never', 'invalid_request'],
  ['not_found', new Dv360Error('not_found', undefined, diag(404)), 'never', 'not_found'],
  ['plain Error', new Error('x'), 'never', 'unknown'],
  ['non-Error', 'x', 'never', 'unknown'],
];
for (const [name, error, cls, kind] of CLASSES) {
  test(`failureClass: ${name} → ${cls} (${kind})`, () => {
    assert.deepEqual(failureClass(error), { cls, kind });
  });
}

const BASE = {
  cls: 'idempotent_only' as FailureClass, idempotency: 'idempotent' as Idempotency, singleAttempt: false, attempt: 1,
  policy: DEFAULT_RETRY_POLICY, nowMs: 10_000, random: () => 0.5,
};

test('decideRetry rule 1: never, singleAttempt, and idempotent_only on rate_limit_only are not retryable', () => {
  assert.deepEqual(decideRetry({ ...BASE, cls: 'never' }), { retry: false, reason: 'not_retryable' });
  assert.deepEqual(decideRetry({ ...BASE, cls: 'always', singleAttempt: true }), { retry: false, reason: 'not_retryable' });
  assert.deepEqual(decideRetry({ ...BASE, idempotency: 'rate_limit_only' }), { retry: false, reason: 'not_retryable' });
  // Rule 1 wins over the attempt cap.
  assert.deepEqual(decideRetry({ ...BASE, cls: 'never', attempt: 3 }), { retry: false, reason: 'not_retryable' });
  // always and with_retry_after are allowed for rate_limit_only.
  assert.equal(decideRetry({ ...BASE, cls: 'always', idempotency: 'rate_limit_only' }).retry, true);
  assert.equal(decideRetry({ ...BASE, cls: 'with_retry_after', idempotency: 'rate_limit_only', retryAfterMs: 0 }).retry, true);
});

test('decideRetry rule 2: with_retry_after without a Retry-After is no_retry_after, before the attempt cap', () => {
  assert.deepEqual(decideRetry({ ...BASE, cls: 'with_retry_after' }), { retry: false, reason: 'no_retry_after' });
  assert.deepEqual(decideRetry({ ...BASE, cls: 'with_retry_after', attempt: 3 }), { retry: false, reason: 'no_retry_after' });
});

test('decideRetry rule 3: the attempt cap', () => {
  assert.equal(decideRetry({ ...BASE, attempt: 2 }).retry, true);
  assert.deepEqual(decideRetry({ ...BASE, attempt: 3 }), { retry: false, reason: 'attempts' });
  assert.deepEqual(decideRetry({ ...BASE, policy: NO_RETRIES }), { retry: false, reason: 'attempts' });
});

test('decideRetry rule 4: full jitter bounds, the cap, and Retry-After above the backoff wins', () => {
  assert.deepEqual(decideRetry({ ...BASE, random: () => 0 }), { retry: true, delayMs: 0 });
  assert.deepEqual(decideRetry({ ...BASE, random: () => 0.9999999 }), { retry: true, delayMs: 999 });
  assert.deepEqual(decideRetry({ ...BASE, attempt: 2, random: () => 0.9999999 }), { retry: true, delayMs: 1_999 });
  const wide = { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 8_000 };
  assert.deepEqual(decideRetry({ ...BASE, policy: wide, attempt: 6, random: () => 0.9999999 }), { retry: true, delayMs: 7_999 });
  assert.deepEqual(decideRetry({ ...BASE, cls: 'always', retryAfterMs: 3_000 }), { retry: true, delayMs: 3_000 });
  assert.deepEqual(decideRetry({ ...BASE, cls: 'always', retryAfterMs: 100 }), { retry: true, delayMs: 500 });
});

test('decideRetry rule 5: the budget edge is exactly at delay + MIN_RETRY_ATTEMPT_MS', () => {
  // delay 500 → needs nowMs + 1 500 ≤ deadline.
  assert.deepEqual(decideRetry({ ...BASE, deadlineMs: 11_500 }), { retry: true, delayMs: 500 });
  assert.deepEqual(decideRetry({ ...BASE, deadlineMs: 11_499 }), { retry: false, reason: 'budget' });
  assert.deepEqual(decideRetry({ ...BASE, cls: 'with_retry_after', retryAfterMs: 120_000, deadlineMs: 55_000 }), { retry: false, reason: 'budget' });
});

test('parseRetryAfter accepts whole seconds and HTTP dates', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(parseRetryAfter('7', now), 7_000);
  assert.equal(parseRetryAfter('0', now), 0);
  assert.equal(parseRetryAfter('3600', now), 3_600_000);
  assert.equal(parseRetryAfter('Thu, 12 Nov 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Thu, 12 Nov 2026 11:00:00 GMT', now), 0);
});

test('parseRetryAfter rejects every other form, and values above one hour', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  for (const value of [null, '', ' ', '-1', '1.5', '7s', ' 7', '+7', '0x10', '1e3', 'soon', '3601',
    'Thu, 12 Nov 2026 13:00:01 GMT', '2026-11-12T12:00:30Z', 'Thursday, 12-Nov-26 12:00:30 GMT']) {
    assert.equal(parseRetryAfter(value, now), undefined, String(value));
  }
});

const MIDNIGHTS: [string, string][] = [
  ['2026-11-12T12:00:00Z', '2026-11-13T08:00:00Z'],
  ['2026-07-01T12:00:00Z', '2026-07-02T07:00:00Z'],
  ['2026-03-08T07:30:00Z', '2026-03-08T08:00:00Z'],
  ['2026-03-08T12:00:00Z', '2026-03-09T07:00:00Z'],
  ['2026-11-01T06:30:00Z', '2026-11-01T07:00:00Z'],
  ['2026-11-01T12:00:00Z', '2026-11-02T08:00:00Z'],
  ['2026-11-13T08:00:00Z', '2026-11-14T08:00:00Z'],
];
for (const [now, next] of MIDNIGHTS) {
  test(`nextPacificMidnight(${now}) = ${next}`, () => {
    assert.equal(new Date(nextPacificMidnight(Date.parse(now))).toISOString(), new Date(next).toISOString());
  });
}

test('the daily latch trips to the next Pacific midnight, blocks until then, and forgets after', () => {
  let now = Date.parse('2026-11-12T12:00:00Z');
  const latch = createDailyLatch(() => now);
  assert.equal(latch.blockedUntil(), undefined);
  const until = latch.trip();
  assert.equal(until, Date.parse('2026-11-13T08:00:00Z'));
  assert.equal(latch.blockedUntil(), until);
  now = until - 1;
  assert.equal(latch.blockedUntil(), until);
  now = until;
  assert.equal(latch.blockedUntil(), undefined);
  now = until - 1;
  assert.equal(latch.blockedUntil(), undefined);
});

function pacerHarness() {
  const sleeps: number[] = [];
  const pacer = createPacer({
    minGapMs: 250, now: () => 0,
    sleep: async (ms, signal) => { sleeps.push(ms); if (signal) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
  });
  return { pacer, sleeps };
}

test('the pacer gives three concurrent callers slots 0, 250 and 500 ms', async () => {
  const { pacer, sleeps } = pacerHarness();
  assert.deepEqual(await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]), [true, true, true]);
  assert.deepEqual(sleeps, [250, 500]);
});

test('the pacer refuses a slot past the deadline without waiting', async () => {
  const { pacer, sleeps } = pacerHarness();
  assert.equal(await pacer.wait(undefined, 0), true);
  assert.equal(await pacer.wait(undefined, 249), false);
  assert.equal(await pacer.wait(AbortSignal.abort()), false);
  assert.deepEqual(sleeps, []);
});

test('the pacer returns false when the signal aborts during the wait', async () => {
  const { pacer } = pacerHarness();
  await pacer.wait();
  const controller = new AbortController();
  const waiting = pacer.wait(controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
});

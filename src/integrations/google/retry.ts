import { GoogleCredentialsError } from './auth.js';
import { GoogleApiError } from './errors.js';

// Pure: time and randomness come in as parameters (boundaries.test.ts enforces it).

export type RetryPolicy = { readonly maxAttempts: number; readonly baseDelayMs: number; readonly maxDelayMs: number };
export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 };
export const NO_RETRIES: RetryPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
export const MIN_RETRY_ATTEMPT_MS = 1_000;   // a retry needs at least this much budget left after its wait

export type Idempotency = 'idempotent' | 'rate_limit_only';

export type FailureClass = 'always' | 'idempotent_only' | 'with_retry_after' | 'never';

export function failureClass(error: unknown): { readonly cls: FailureClass; readonly kind: string } {
  if (error instanceof GoogleCredentialsError) {
    // Credentials are fetched before the request is sent, so 'unavailable' means nothing reached Google.
    return error.kind === 'unavailable'
      ? { cls: 'always', kind: 'credentials_unavailable' }
      : { cls: 'never', kind: `credentials_${error.kind}` };
  }
  if (error instanceof GoogleApiError) {
    const kind: string = error.kind;
    if (kind === 'rate_limited') {
      // 429 needs Google's Retry-After; 403 userRateLimitExceeded is rejected before any work is done.
      return { cls: error.diagnostics.httpStatus === 429 ? 'with_retry_after' : 'always', kind };
    }
    if (kind === 'server_error' || kind === 'timeout' || kind === 'network') return { cls: 'idempotent_only', kind };
    return { cls: 'never', kind };
  }
  return { cls: 'never', kind: 'unknown' };
}

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | { readonly retry: false; readonly reason: 'not_retryable' | 'attempts' | 'budget' | 'no_retry_after' };

export function decideRetry(input: {
  readonly cls: FailureClass;
  readonly idempotency: Idempotency;
  readonly singleAttempt: boolean;
  readonly attempt: number;            // attempts made so far, ≥ 1
  readonly policy: RetryPolicy;
  readonly nowMs: number;
  readonly deadlineMs?: number;
  readonly retryAfterMs?: number;      // from parseRetryAfter
  readonly random: () => number;       // [0, 1)
}): RetryDecision {
  const { cls, idempotency, singleAttempt, attempt, policy, nowMs, deadlineMs, retryAfterMs, random } = input;
  if (cls === 'never' || singleAttempt || (cls === 'idempotent_only' && idempotency === 'rate_limit_only')) {
    return { retry: false, reason: 'not_retryable' };
  }
  if (cls === 'with_retry_after' && retryAfterMs === undefined) return { retry: false, reason: 'no_retry_after' };
  if (attempt >= policy.maxAttempts) return { retry: false, reason: 'attempts' };
  const backoff = Math.floor(random() * Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)));
  const delayMs = Math.max(backoff, retryAfterMs ?? 0);
  if (deadlineMs !== undefined && nowMs + delayMs + MIN_RETRY_ATTEMPT_MS > deadlineMs) return { retry: false, reason: 'budget' };
  return { retry: true, delayMs };
}

const MAX_RETRY_AFTER_MS = 3_600_000;
// IMF-fixdate, the HTTP date form servers send (RFC 9110 §5.6.7).
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  let ms: number;
  if (/^[0-9]+$/.test(value)) {
    ms = Number(value) * 1_000;
  } else if (HTTP_DATE.test(value)) {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return undefined;
    ms = Math.max(0, at - nowMs);
  } else {
    return undefined;
  }
  return ms > MAX_RETRY_AFTER_MS ? undefined : ms;
}

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

function pacificParts(ms: number): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  const parts = Object.fromEntries(PACIFIC.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** Epoch ms of the next 00:00 in America/Los_Angeles (Bid Manager's daily quota reset). */
export function nextPacificMidnight(nowMs: number): number {
  const today = pacificParts(nowMs);
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const base = tomorrow.getTime();
  // Pacific is UTC−7 (PDT) or UTC−8 (PST); DST changes at 02:00, so midnight always exists exactly once.
  for (const offsetHours of [7, 8]) {
    const candidate = base + offsetHours * 3_600_000;
    const local = pacificParts(candidate);
    if (local.year === tomorrow.getUTCFullYear() && local.month === tomorrow.getUTCMonth() + 1
      && local.day === tomorrow.getUTCDate() && local.hour === 0 && local.minute === 0 && local.second === 0) {
      return candidate;
    }
  }
  throw new Error('Could not compute the next Pacific midnight.');
}

export type DailyLatch = { blockedUntil(): number | undefined; trip(): number };   // trip returns untilMs

export function createDailyLatch(now: () => number): DailyLatch {
  let untilMs: number | undefined;
  return {
    blockedUntil() {
      if (untilMs !== undefined && now() < untilMs) return untilMs;
      untilMs = undefined;
      return undefined;
    },
    trip() {
      untilMs = nextPacificMidnight(now());
      return untilMs;
    },
  };
}

export const BID_MANAGER_MIN_GAP_MS = 250;

export type Pacer = { wait(signal?: AbortSignal, deadlineMs?: number): Promise<boolean> };

export function createPacer(options: { readonly minGapMs: number; readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> }): Pacer {
  const { minGapMs, now, sleep } = options;
  let lastSlot = Number.NEGATIVE_INFINITY;
  return {
    async wait(signal, deadlineMs) {
      // Reserve synchronously so concurrent callers get distinct slots; a refused slot is not released.
      const current = now();
      const slot = Math.max(current, lastSlot + minGapMs);
      lastSlot = slot;
      if (signal?.aborted || (deadlineMs !== undefined && slot > deadlineMs)) return false;
      if (slot > current) await sleep(slot - current, signal);
      return !signal?.aborted;
    },
  };
}

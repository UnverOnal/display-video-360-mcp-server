import { GoogleCredentialsError, type AuthorizedFetch } from './auth.js';
import type { GoogleApiError } from './errors.js';
import { LOGGED_REASONS, LOGGED_STATUSES, noopLogger, type GoogleApi, type Logger } from './log.js';
import {
  DEFAULT_RETRY_POLICY, decideRetry, failureClass, parseRetryAfter,
  type DailyLatch, type Idempotency, type Pacer, type RetryPolicy,
} from './retry.js';

/** Per-call options every client method accepts as its optional last parameter. */
export type CallOptions = {
  readonly callId?: string;           // correlation only; never sent to Google
  readonly signal?: AbortSignal;      // caller cancellation (MCP request)
  readonly deadline?: number;         // epoch ms; bounds retries only
  readonly singleAttempt?: boolean;   // no retries for this call
  readonly timeoutMs?: number;        // per-attempt timeout override for this call
};

export type RequestRuntime = {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;   // resolves early, never throws, on abort
  readonly random: () => number;
  readonly logger: Logger;
};

export type RequestErrors<E extends GoogleApiError> = {
  /** Classifies a non-OK response. */
  readonly classify: (httpStatus: number, bodyText: string) => E;
  /** Builds the error for a transport failure, an unparseable body, or a latched daily quota. */
  readonly create: (kind: 'timeout' | 'network' | 'unexpected_response' | 'daily_limit') => E;
};

export type RequestOptions<E extends GoogleApiError> = {
  readonly api: GoogleApi;
  readonly fetch: AuthorizedFetch;
  readonly timeoutMs: number;
  readonly errors: RequestErrors<E>;
  readonly retry?: RetryPolicy;                    // default DEFAULT_RETRY_POLICY
  readonly runtime?: Partial<RequestRuntime>;
  readonly latch?: DailyLatch;
  readonly pacer?: Pacer;
};

export type SendInit = {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};

type LoopCall = CallOptions & {
  readonly operation: string;
  readonly idempotency: Idempotency;
  readonly ignoreBody?: boolean;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Fills in the production defaults for any runtime part not given. */
export function resolveRuntime(runtime: Partial<RequestRuntime> = {}): RequestRuntime {
  return {
    now: runtime.now ?? Date.now,
    sleep: runtime.sleep ?? defaultSleep,
    random: runtime.random ?? Math.random,
    logger: runtime.logger ?? noopLogger,
  };
}

function errorName(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? (value as { name?: unknown }).name : undefined;
}

type Outcome<E> =
  | { readonly ok: true; readonly value: unknown; readonly httpStatus: number }
  | { readonly ok: false; readonly error: E | GoogleCredentialsError; readonly retryAfter: string | null };

function createLoop<E extends GoogleApiError>(options: RequestOptions<E>) {
  const { api, fetch, timeoutMs, errors, latch, pacer } = options;
  const policy = options.retry ?? DEFAULT_RETRY_POLICY;
  const { now, sleep, random, logger } = resolveRuntime(options.runtime);

  async function attemptOnce(
    url: string, init: SendInit, ignoreBody: boolean, timeoutSignal: AbortSignal, fetchSignal: AbortSignal,
  ): Promise<Outcome<E>> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { ...init, signal: fetchSignal });
      if (response.ok && ignoreBody) return { ok: true, value: undefined, httpStatus: response.status };
      text = await response.text();
    } catch (error) {
      if (error instanceof GoogleCredentialsError) return { ok: false, error, retryAfter: null };
      // Only our own timeout counts as a timeout; a caller abort is classified as network (and never retried).
      const timedOut = errorName(error) === 'TimeoutError'
        || (timeoutSignal.aborted && errorName(timeoutSignal.reason) === 'TimeoutError');
      return { ok: false, error: errors.create(timedOut ? 'timeout' : 'network'), retryAfter: null };
    }
    if (!response.ok) {
      return { ok: false, error: errors.classify(response.status, text), retryAfter: response.headers.get('retry-after') };
    }
    try {
      return { ok: true, value: JSON.parse(text) as unknown, httpStatus: response.status };
    } catch {
      return { ok: false, error: errors.create('unexpected_response'), retryAfter: null };
    }
  }

  return async function loop(url: string, init: SendInit, call: LoopCall): Promise<unknown> {
    const { operation, idempotency, signal, deadline } = call;
    const correlation = call.callId === undefined ? {} : { callId: call.callId };
    const singleAttempt = call.singleAttempt === true;
    const perAttemptMs = call.timeoutMs ?? timeoutMs;
    let attempt = 0;
    let lastError: E | GoogleCredentialsError | undefined;
    let lastKind = '';

    const giveUp = (reason: 'attempts' | 'budget' | 'cancelled' | 'no_retry_after') =>
      logger({ type: 'google.give_up', api, operation, attempts: attempt, kind: lastKind, reason, ...correlation });

    for (;;) {
      if (signal?.aborted) {
        // lastError is only set once a retry was decided, so this failure was retryable.
        if (lastError !== undefined) giveUp('cancelled');
        throw lastError ?? errors.create('timeout');
      }
      if (latch?.blockedUntil() !== undefined) {
        logger({ type: 'google.latch_blocked', api, operation, ...correlation });
        throw errors.create('daily_limit');
      }
      if (pacer && !(await pacer.wait(signal, attempt > 0 ? deadline : undefined))) {
        if (lastError !== undefined) giveUp(signal?.aborted ? 'cancelled' : 'budget');
        throw lastError ?? errors.create('timeout');
      }
      // The deadline bounds retries only; the first attempt is never shortened.
      // Read after the pacer wait, so a retry never runs past the deadline.
      const remaining = attempt > 0 && deadline !== undefined ? deadline - now() : Number.POSITIVE_INFINITY;
      const attemptTimeout = attempt === 0 ? perAttemptMs : Math.max(0, Math.min(perAttemptMs, remaining));
      const timeoutSignal = AbortSignal.timeout(attemptTimeout);
      const fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
      attempt += 1;

      const startedAt = now();
      const outcome = await attemptOnce(url, init, call.ignoreBody === true, timeoutSignal, fetchSignal);
      const diagnostics = !outcome.ok && !(outcome.error instanceof GoogleCredentialsError)
        ? outcome.error.diagnostics : undefined;
      const reasons = diagnostics === undefined ? [] : [...new Set([
        ...diagnostics.reasons.map(entry => entry.reason), ...diagnostics.legacyReasons,
      ].map(reason => LOGGED_REASONS.includes(reason) ? reason : 'other'))].slice(0, 5);
      const httpStatus = outcome.ok ? outcome.httpStatus : diagnostics?.httpStatus;
      logger({
        type: 'google.request', api, operation, attempt,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        outcome: outcome.ok ? 'ok' : failureClass(outcome.error).kind,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(diagnostics?.status ? { status: LOGGED_STATUSES.includes(diagnostics.status) ? diagnostics.status : 'OTHER' } : {}),
        ...(reasons.length === 0 ? {} : { reasons }), ...correlation,
      });
      if (outcome.ok) return outcome.value;

      const { error } = outcome;
      lastError = error;
      if (latch && !(error instanceof GoogleCredentialsError) && error.kind === 'daily_limit') {
        logger({ type: 'google.latched', api, operation, untilMs: latch.trip(), ...correlation });
      }
      const { cls, kind } = failureClass(error);
      lastKind = kind;
      const nowMs = now();
      const decision = decideRetry({
        cls, idempotency, singleAttempt, attempt, policy, nowMs, deadlineMs: deadline,
        retryAfterMs: parseRetryAfter(outcome.retryAfter, nowMs), random,
      });
      if (signal?.aborted) {
        if (decision.retry || decision.reason !== 'not_retryable') giveUp('cancelled');
        throw error;
      }
      if (!decision.retry) {
        if (decision.reason !== 'not_retryable') giveUp(decision.reason);
        throw error;
      }
      logger({ type: 'google.retry', api, operation, attempt, kind, delayMs: decision.delayMs, ...correlation });
      await sleep(decision.delayMs, signal);
    }
  };
}

/** GET-only, always idempotent. The only request function the DV360 integration may use. */
export function createGetJson<E extends GoogleApiError>(options: RequestOptions<E>): (
  url: string, call: CallOptions & { readonly operation: string },
) => Promise<unknown> {
  const loop = createLoop(options);
  return (url, call) => loop(url, { method: 'GET' }, { ...call, idempotency: 'idempotent' });
}

/** Any method. Used only by the Bid Manager client. */
export function createSendJson<E extends GoogleApiError>(options: RequestOptions<E>): (
  url: string, init: SendInit,
  call: CallOptions & { readonly operation: string; readonly idempotency: Idempotency; readonly ignoreBody?: boolean },
) => Promise<unknown> {
  const loop = createLoop(options);
  return (url, init, call) => loop(url, init, call);
}

import { randomBytes } from 'node:crypto';

export type ToolCall = {
  readonly callId: string;
  /** Record a caught error before building the tool's error result. */
  failed(error: unknown): void;
  /** Record a safe result kind without changing its outcome. */
  note(kind: string): void;
};

export type ToolCallEvent = {
  readonly type: 'tool.call'; readonly tool: string; readonly callId: string;
  readonly outcome: 'ok' | 'error'; readonly durationMs: number;
  readonly errorClass?: string; readonly kind?: string;
};

export type ToolResultLike = { readonly content: readonly unknown[]; readonly isError?: boolean };
export type ToolRunner = <T extends ToolResultLike>(tool: string, body: (call: ToolCall) => Promise<T>) => Promise<T>;

export type LoggedKind =
  | 'invalid_request' | 'unauthenticated' | 'quota_project_denied' | 'api_disabled' | 'scope_insufficient'
  | 'daily_limit' | 'rate_limited' | 'access_denied' | 'not_found' | 'resource_exhausted'
  | 'server_error' | 'timeout' | 'network' | 'unexpected_response' | 'expired_or_revoked' | 'unavailable'
  | 'invalid_link' | 'download_failed' | 'too_large' | 'malformed' | 'busy' | 'deferred';

export const LOGGED_KINDS: readonly LoggedKind[] = [
  'invalid_request', 'unauthenticated', 'quota_project_denied', 'api_disabled', 'scope_insufficient',
  'daily_limit', 'rate_limited', 'access_denied', 'not_found', 'resource_exhausted',
  'server_error', 'timeout', 'network', 'unexpected_response', 'expired_or_revoked', 'unavailable',
  'invalid_link', 'download_failed', 'too_large', 'malformed', 'busy', 'deferred',
];

function safeKind(value: unknown): string | undefined {
  return typeof value === 'string' ? (LOGGED_KINDS.includes(value as LoggedKind) ? value : 'other') : undefined;
}

function describeError(error: unknown): { errorClass: string; kind?: string } {
  if (error === null || typeof error !== 'object') return { errorClass: typeof error };
  try {
    const name: unknown = error.constructor?.name;
    const errorClass = typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : 'Object';
    const kind = safeKind((error as { kind?: unknown }).kind);
    return { errorClass, ...(kind === undefined ? {} : { kind }) };
  } catch {
    return { errorClass: 'Object' };
  }
}

const newCallId = () => randomBytes(8).toString('hex');

export function createToolRunner(options: {
  readonly log: (event: ToolCallEvent) => void;
  readonly now?: () => number;
  readonly newCallId?: () => string;
}): ToolRunner {
  const now = options.now ?? Date.now;
  const makeId = options.newCallId ?? newCallId;
  return async (tool, body) => {
    const callId = makeId();
    const start = now();
    let hasFailed = false;
    let failedError: unknown;
    let hasNote = false;
    let notedKind: string | undefined;
    const call: ToolCall = {
      callId,
      failed(error) { if (!hasFailed) { hasFailed = true; failedError = error; } },
      note(kind) { if (!hasNote) { hasNote = true; notedKind = safeKind(kind); } },
    };
    const emit = (outcome: 'ok' | 'error', error = failedError, recorded = hasFailed) => {
      const details: { errorClass?: string; kind?: string } = recorded ? describeError(error) : {};
      const kind = details.kind ?? notedKind;
      options.log({
        type: 'tool.call', tool, callId, outcome, durationMs: Math.max(0, Math.round(now() - start)),
        ...details, ...(kind === undefined ? {} : { kind }),
      });
    };
    let result;
    try { result = await body(call); }
    catch (error) { emit('error', error, true); throw error; }
    emit(hasFailed || result.isError === true ? 'error' : 'ok');
    return result;
  };
}

export const runWithoutLogging: ToolRunner = async (_tool, body) =>
  body({ callId: newCallId(), failed() {}, note() {} });

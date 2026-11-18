export type GoogleApi = 'bidmanager' | 'dv360';

export type LogEvent =
  | { readonly type: 'google.retry'; readonly api: GoogleApi; readonly operation: string;
      readonly attempt: number;            // the attempt that just failed (1-based)
      readonly kind: string;               // error kind, or 'credentials_unavailable'
      readonly delayMs: number; readonly callId?: string }
  | { readonly type: 'google.give_up'; readonly api: GoogleApi; readonly operation: string;
      readonly attempts: number; readonly kind: string;
      readonly reason: 'attempts' | 'budget' | 'cancelled' | 'no_retry_after'; readonly callId?: string }
  | { readonly type: 'google.latched'; readonly api: GoogleApi; readonly operation: string; readonly untilMs: number; readonly callId?: string }
  | { readonly type: 'google.latch_blocked'; readonly api: GoogleApi; readonly operation: string; readonly callId?: string }
  | { readonly type: 'google.request'; readonly api: GoogleApi; readonly operation: string;
      readonly attempt: number; readonly durationMs: number; readonly outcome: string;
      readonly httpStatus?: number; readonly status?: string; readonly reasons?: readonly string[]; readonly callId?: string };

export type Logger = (event: LogEvent) => void;
export const noopLogger: Logger = () => {};

/** Only fixed upstream codes may enter operational logs. */
export const LOGGED_STATUSES: readonly string[] = [
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS',
];
export const LOGGED_REASONS: readonly string[] = [
  'USER_PROJECT_DENIED', 'SERVICE_DISABLED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'dailyLimitExceeded', 'userRateLimitExceeded',
];

export type LogLine = { readonly type: string } & Readonly<Record<string, unknown>>;

export function createJsonLogger(options: {
  readonly write: (line: string) => void;
  readonly now: () => number;
}): (event: LogLine) => void {
  return event => {
    try {
      options.write(JSON.stringify({ ts: new Date(options.now()).toISOString(), ...event }) + '\n');
    } catch { /* Logging must never break a call. */ }
  };
}

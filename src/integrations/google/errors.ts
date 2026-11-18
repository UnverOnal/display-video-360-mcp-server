export type GoogleApiErrorKind =
  | 'invalid_request' | 'unauthenticated'
  | 'quota_project_denied' | 'api_disabled' | 'scope_insufficient'
  | 'daily_limit' | 'rate_limited' | 'access_denied'
  | 'not_found' | 'resource_exhausted' | 'server_error'
  | 'timeout' | 'network' | 'unexpected_response';

/** Every kind except the Bid Manager-only reporting-quota kind. */
export type CommonGoogleApiErrorKind = Exclude<GoogleApiErrorKind, 'resource_exhausted'>;

export type GoogleApiErrorDiagnostics = {
  readonly httpStatus?: number;
  readonly code?: number;
  readonly status?: string;
  readonly reasons: readonly { readonly reason: string; readonly domain?: string }[];
  readonly legacyReasons: readonly string[];
};

export abstract class GoogleApiError<K extends GoogleApiErrorKind = GoogleApiErrorKind> extends Error {
  readonly kind: K;
  readonly retryable: boolean;
  readonly diagnostics: GoogleApiErrorDiagnostics;

  protected constructor(kind: K, message: string, diagnostics?: GoogleApiErrorDiagnostics) {
    super(message);
    this.kind = kind;
    this.retryable = kind === 'rate_limited' || kind === 'server_error' || kind === 'timeout' || kind === 'network';
    // Copy only allowed fields, including for diagnostics supplied by internal callers.
    this.diagnostics = {
      ...(diagnostics?.httpStatus !== undefined ? { httpStatus: diagnostics.httpStatus } : {}),
      ...(diagnostics?.code !== undefined ? { code: diagnostics.code } : {}),
      ...(diagnostics?.status !== undefined ? { status: diagnostics.status.slice(0, 100) } : {}),
      reasons: (diagnostics?.reasons ?? []).slice(0, 5).map(entry => ({
        reason: entry.reason.slice(0, 100),
        ...(entry.domain !== undefined ? { domain: entry.domain.slice(0, 100) } : {}),
      })),
      legacyReasons: (diagnostics?.legacyReasons ?? []).slice(0, 5).map(reason => reason.slice(0, 100)),
    };
  }
}

export type GoogleErrorClassifier<K extends GoogleApiErrorKind, E extends GoogleApiError<K>> = {
  /** Kind for HTTP 429. */
  readonly kindFor429: K;
  /** Kinds whose error shows Google's cleaned message, with the prefix to use. */
  readonly googleMessagePrefixes: Partial<Record<K, string>>;
  /** Builds the API's own subclass. `message` undefined means "use the default". */
  readonly create: (kind: K, message: string | undefined, diagnostics: GoogleApiErrorDiagnostics) => E;
};

const FORBIDDEN_REASONS: readonly (readonly [string, CommonGoogleApiErrorKind])[] = [
  ['USER_PROJECT_DENIED', 'quota_project_denied'],
  ['SERVICE_DISABLED', 'api_disabled'],
  ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'scope_insufficient'],
  ['dailyLimitExceeded', 'daily_limit'],
  ['userRateLimitExceeded', 'rate_limited'],
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseError(bodyText: string): Record<string, unknown> | undefined {
  try {
    const body: unknown = JSON.parse(bodyText);
    return isObject(body) && isObject(body.error) ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `K` must contain every common kind: the classifier produces them besides `kindFor429`.
 * The `CommonGoogleApiErrorKind extends K` condition enforces that at compile time.
 */
export function classifyGoogleHttpError<K extends GoogleApiErrorKind, E extends GoogleApiError<K>>(
  httpStatus: number,
  bodyText: string,
  classifier: CommonGoogleApiErrorKind extends K ? GoogleErrorClassifier<K, E> : never,
): E {
  const error = parseError(bodyText);
  const reasons: { reason: string; domain?: string }[] = [];
  const legacyReasons: string[] = [];
  if (Array.isArray(error?.details)) {
    for (const detail of error.details) {
      if (isObject(detail) && detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && typeof detail.reason === 'string') {
        reasons.push({ reason: detail.reason, ...(typeof detail.domain === 'string' ? { domain: detail.domain } : {}) });
      }
    }
  }
  if (Array.isArray(error?.errors)) {
    for (const entry of error.errors) {
      if (isObject(entry) && typeof entry.reason === 'string') legacyReasons.push(entry.reason);
    }
  }

  let found: CommonGoogleApiErrorKind | K;
  if (httpStatus === 403) {
    // Classify from all original reasons before the diagnostic caps are applied.
    found = FORBIDDEN_REASONS.find(([reason]) =>
      reasons.some(entry => entry.reason === reason) || legacyReasons.includes(reason),
    )?.[1] ?? 'access_denied';
  } else if (httpStatus === 400) found = 'invalid_request';
  else if (httpStatus === 401) found = 'unauthenticated';
  else if (httpStatus === 404) found = 'not_found';
  else if (httpStatus === 429) found = classifier.kindFor429;
  else if (httpStatus >= 500 && httpStatus <= 599) found = 'server_error';
  else found = 'unexpected_response';

  // The one widening cast: the parameter type guarantees K contains every common kind.
  const kind = found as K;

  let message: string | undefined;
  const prefix = classifier.googleMessagePrefixes[kind];
  if (prefix !== undefined && typeof error?.message === 'string') {
    const cleaned = error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned) message = `${prefix}: ${cleaned.slice(0, 500)}${cleaned.length > 500 ? '…' : ''}`;
  }
  return classifier.create(kind, message, {
    httpStatus,
    ...(typeof error?.code === 'number' ? { code: error.code } : {}),
    ...(typeof error?.status === 'string' ? { status: error.status } : {}),
    reasons,
    legacyReasons,
  });
}

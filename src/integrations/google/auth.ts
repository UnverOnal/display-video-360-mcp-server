import { GoogleAuth } from 'google-auth-library';

export type AuthorizedRequestInit = {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
};

export type AuthorizedFetch = (url: string, init?: AuthorizedRequestInit) => Promise<Response>;
export type GoogleCredentialsErrorKind = 'not_found' | 'expired_or_revoked' | 'unavailable';

const CREDENTIAL_MESSAGES: Record<GoogleCredentialsErrorKind, string> = {
  not_found: 'Google credentials not found. Run the one-time Google login for this server, then try again.',
  expired_or_revoked: 'The Google login has expired or was revoked. Run the Google login command again (see the README), then retry.',
  unavailable: 'Could not get Google credentials right now. Try again shortly.',
};

export class GoogleCredentialsError extends Error {
  readonly kind: GoogleCredentialsErrorKind;

  constructor(kind: GoogleCredentialsErrorKind) {
    super(CREDENTIAL_MESSAGES[kind]);
    this.name = 'GoogleCredentialsError';
    this.kind = kind;
  }
}

export type GoogleAuthOptions = {
  readonly quotaProject: string;
  readonly scopes: readonly string[];
};

export type GoogleAuthDependencies = {
  readonly loadClient?: () => Promise<{ getRequestHeaders(url?: string): Promise<Headers> }>;
  readonly fetch?: typeof fetch;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function classifyCredentialsError(error: unknown): GoogleCredentialsErrorKind {
  const record = asRecord(error);
  const message = typeof record?.message === 'string' ? record.message : '';
  const data = asRecord(asRecord(record?.response)?.data);
  if (data?.error === 'invalid_grant' || message.includes('invalid_grant')) {
    return 'expired_or_revoked';
  }
  if (message.startsWith('Could not load the default credentials')
    || message.startsWith('Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable:')) {
    return 'not_found';
  }
  return 'unavailable';
}

export function createAuthorizedFetch(
  options: GoogleAuthOptions,
  dependencies: GoogleAuthDependencies = {},
): AuthorizedFetch {
  const loadClient = dependencies.loadClient ?? (() => new GoogleAuth({
    scopes: [...options.scopes],
    projectId: options.quotaProject,
  }).getClient());
  const fetchRequest = dependencies.fetch ?? globalThis.fetch;
  let clientPromise: ReturnType<NonNullable<GoogleAuthDependencies['loadClient']>> | undefined;

  return async (url, init = {}) => {
    // Defer loading to a microtask so even a synchronous loader throw clears the cache.
    const pending = clientPromise ??= Promise.resolve().then(loadClient);
    let authHeaders: Headers;
    let loaded = false;
    try {
      const client = await pending;
      loaded = true;
      authHeaders = await client.getRequestHeaders(url);
    } catch (error) {
      const kind = classifyCredentialsError(error);
      // A late failure from an older client must not discard a newer login.
      if ((!loaded || kind === 'expired_or_revoked') && clientPromise === pending) {
        clientPromise = undefined;
      }
      throw new GoogleCredentialsError(kind);
    }

    const headers = new Headers(init.headers);
    headers.set('authorization', authHeaders.get('authorization') ?? '');
    headers.set('x-goog-user-project', options.quotaProject);
    return fetchRequest(url, { method: init.method, headers, body: init.body, signal: init.signal });
  };
}

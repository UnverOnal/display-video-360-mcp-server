import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAuthorizedFetch,
  GoogleCredentialsError,
  type GoogleAuthDependencies,
  type GoogleCredentialsErrorKind,
} from './auth.js';

const OPTIONS = { quotaProject: 'test-quota-project', scopes: ['test-scope'] };
const URL = 'https://example.test/resource';
const client = { getRequestHeaders: async () => new Headers({ authorization: 'Bearer fake-access-token' }) };
const responseFetch: typeof fetch = async () => new Response(null, { status: 200 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function credentialsError(kind: GoogleCredentialsErrorKind, message: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof GoogleCredentialsError);
    assert.equal(error.kind, kind);
    assert.equal(error.message, message);
    return true;
  };
}

test('authorized fetch preserves caller headers and overrides protected headers case-insensitively', async () => {
  const signal = new AbortController().signal;
  const callerHeaders = { 'Content-Type': 'application/json', Authorization: 'caller-token', 'X-Goog-User-Project': 'caller-project' };
  let calls = 0;
  const authorizedFetch = createAuthorizedFetch(OPTIONS, {
    loadClient: async () => ({ getRequestHeaders: async url => {
      assert.equal(url, URL);
      return new Headers({ Authorization: 'Bearer fake-access-token', 'x-goog-user-project': 'adc-project' });
    } }),
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, URL);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer fake-access-token');
      assert.equal(headers.get('x-goog-user-project'), OPTIONS.quotaProject);
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.body, '{"value":1}');
      assert.equal(init?.signal, signal);
      return new Response(null);
    },
  });
  await authorizedFetch(URL, { method: 'POST', body: '{"value":1}', headers: callerHeaders, signal });
  assert.equal(calls, 1);
  assert.equal(callerHeaders.Authorization, 'caller-token');
  assert.equal(callerHeaders['X-Goog-User-Project'], 'caller-project');
});

test('authorized fetch leaves method body and signal unset when init is omitted', async () => {
  const authorizedFetch = createAuthorizedFetch(OPTIONS, {
    loadClient: async () => client,
    fetch: async (_url, init) => {
      assert.equal(init?.method, undefined);
      assert.equal(init?.body, undefined);
      assert.equal(init?.signal, undefined);
      return new Response(null);
    },
  });
  await authorizedFetch(URL);
});

for (const status of [200, 400, 403, 429, 500, 503]) {
  test(`authorized fetch returns the original ${status} response without retry`, async () => {
    const response = new Response(null, { status });
    let calls = 0;
    const authorizedFetch = createAuthorizedFetch(OPTIONS, {
      loadClient: async () => client,
      fetch: async () => { calls++; return response; },
    });
    assert.equal(await authorizedFetch(URL), response);
    assert.equal(calls, 1);
  });
}

for (const failure of [new TypeError('fetch failed'), new DOMException('Aborted', 'AbortError')]) {
  test(`authorized fetch propagates ${failure.name} unchanged without retry`, async () => {
    let calls = 0;
    const authorizedFetch = createAuthorizedFetch(OPTIONS, {
      loadClient: async () => client,
      fetch: async () => { calls++; throw failure; },
    });
    await assert.rejects(authorizedFetch(URL), error => error === failure);
    assert.equal(calls, 1);
  });
}

test('credential loading is lazy', () => {
  let calls = 0;
  createAuthorizedFetch(OPTIONS, {
    loadClient: async () => { calls++; return client; },
    fetch: responseFetch,
  });
  assert.equal(calls, 0);
});

test('concurrent first requests share one pending credential load', async () => {
  const pending = deferred<typeof client>();
  let loads = 0;
  const authorizedFetch = createAuthorizedFetch(OPTIONS, {
    loadClient: async () => { loads++; return pending.promise; },
    fetch: responseFetch,
  });
  const requests = [authorizedFetch(URL), authorizedFetch(URL)];
  await Promise.resolve();
  assert.equal(loads, 1);
  pending.resolve(client);
  await Promise.all(requests);
  assert.equal(loads, 1);
});

test('sequential requests reuse the loaded client', async () => {
  let loads = 0;
  let headerCalls = 0;
  const authorizedFetch = createAuthorizedFetch(OPTIONS, {
    loadClient: async () => {
      loads++;
      return { getRequestHeaders: async () => { headerCalls++; return client.getRequestHeaders(); } };
    },
    fetch: responseFetch,
  });
  await authorizedFetch(URL);
  await authorizedFetch(URL);
  assert.equal(loads, 1);
  assert.equal(headerCalls, 2);
});

for (const synchronous of [false, true]) {
  test(`credential load is retried on the next call after a ${synchronous ? 'synchronous throw' : 'rejected promise'}`, async () => {
    let loads = 0;
    const loadClient: NonNullable<GoogleAuthDependencies['loadClient']> = () => {
      loads++;
      if (loads === 1) {
        if (synchronous) throw new Error('temporarily unavailable');
        return Promise.reject(new Error('temporarily unavailable'));
      }
      return Promise.resolve(client);
    };
    const authorizedFetch = createAuthorizedFetch(OPTIONS, { loadClient, fetch: responseFetch });
    await assert.rejects(authorizedFetch(URL), error => error instanceof GoogleCredentialsError && error.kind === 'unavailable');
    await authorizedFetch(URL);
    assert.equal(loads, 2);
  });
}

test('expired credentials are reloaded on the next call without restarting', async () => {
  let loads = 0;
  const authorizedFetch = createAuthorizedFetch(OPTIONS, {
    loadClient: async () => {
      loads++;
      return loads === 1
        ? { getRequestHeaders: async () => { throw { response: { data: { error: 'invalid_grant' } } }; } }
        : client;
    },
    fetch: responseFetch,
  });
  await assert.rejects(authorizedFetch(URL), error => error instanceof GoogleCredentialsError && error.kind === 'expired_or_revoked');
  await authorizedFetch(URL);
  assert.equal(loads, 2);
});

test('transient header failure retains the loaded client', async () => {
  let loads = 0;
  let headers = 0;
  const authorizedFetch = createAuthorizedFetch(OPTIONS, {
    loadClient: async () => {
      loads++;
      return { getRequestHeaders: async () => {
        if (++headers === 1) throw new TypeError('token endpoint unreachable');
        return client.getRequestHeaders();
      } };
    },
    fetch: responseFetch,
  });
  await assert.rejects(authorizedFetch(URL), error => error instanceof GoogleCredentialsError && error.kind === 'unavailable');
  await authorizedFetch(URL);
  assert.equal(loads, 1);
});

test('a late expired-credential failure cannot discard a newer cached client', async () => {
  const late = deferred<Headers>();
  const secondStarted = deferred<void>();
  let loads = 0;
  let headers = 0;
  const authorizedFetch = createAuthorizedFetch(OPTIONS, {
    loadClient: async () => {
      loads++;
      if (loads > 1) return client;
      return { getRequestHeaders: async () => {
        if (++headers === 1) return late.promise;
        secondStarted.resolve();
        throw { response: { data: { error: 'invalid_grant' } } };
      } };
    },
    fetch: responseFetch,
  });
  const first = authorizedFetch(URL);
  const firstRejected = assert.rejects(first, error => error instanceof GoogleCredentialsError && error.kind === 'expired_or_revoked');
  const secondRejected = assert.rejects(authorizedFetch(URL), GoogleCredentialsError);
  await secondStarted.promise;
  await secondRejected;
  await authorizedFetch(URL);
  late.reject({ response: { data: { error: 'invalid_grant' } } });
  await firstRejected;
  await authorizedFetch(URL);
  assert.equal(loads, 2);
});

test('factory instances keep independent credential caches', async () => {
  let loads = 0;
  const dependencies = { loadClient: async () => { loads++; return client; }, fetch: responseFetch };
  const first = createAuthorizedFetch(OPTIONS, dependencies);
  const second = createAuthorizedFetch(OPTIONS, dependencies);
  await first(URL);
  await first(URL);
  await second(URL);
  assert.equal(loads, 2);
});

const errorCases: ReadonlyArray<readonly [string, unknown, GoogleCredentialsErrorKind, string]> = [
  ['missing ADC', { message: 'Could not load the default credentials. More information.' }, 'not_found',
    'Google credentials not found. Run the one-time Google login for this server, then try again.'],
  ['unreadable explicit ADC file', { message: 'Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable: ENOENT' }, 'not_found',
    'Google credentials not found. Run the one-time Google login for this server, then try again.'],
  ['structured invalid_grant', { response: { data: { error: 'invalid_grant' } } }, 'expired_or_revoked',
    'The Google login has expired or was revoked. Run the Google login command again (see the README), then retry.'],
  ['ReAuth rewrite', { message: '{"error":"invalid_grant","error_description":"ReAuth required"}' }, 'expired_or_revoked',
    'The Google login has expired or was revoked. Run the Google login command again (see the README), then retry.'],
  ['network error', new TypeError('token endpoint unavailable'), 'unavailable',
    'Could not get Google credentials right now. Try again shortly.'],
  ['non-object rejection', null, 'unavailable',
    'Could not get Google credentials right now. Try again shortly.'],
];

for (const [name, failure, kind, message] of errorCases) {
  for (const phase of ['load', 'headers'] as const) {
    test(`credential ${phase} classifies ${name} with a safe exact message`, async () => {
      let fetchCalls = 0;
      const authorizedFetch = createAuthorizedFetch(OPTIONS, {
        loadClient: async () => {
          if (phase === 'load') throw failure;
          return { getRequestHeaders: async () => { throw failure; } };
        },
        fetch: async () => { fetchCalls++; return new Response(null); },
      });
      await assert.rejects(authorizedFetch(URL), credentialsError(kind, message));
      assert.equal(fetchCalls, 0);
    });
  }
}

test('credential errors discard original secrets and request configuration', async () => {
  const refreshToken = '1//fake-refresh-token';
  const clientSecret = 'fake-client-secret';
  const failure = Object.assign(new Error(`invalid_grant ${refreshToken} ${clientSecret}`), {
    response: { data: { error: 'invalid_grant', refreshToken, clientSecret } },
    config: { data: `refresh_token=${refreshToken}&client_secret=${clientSecret}` },
  });
  for (const phase of ['load', 'headers'] as const) {
    const authorizedFetch = createAuthorizedFetch(OPTIONS, {
      loadClient: async () => {
        if (phase === 'load') throw failure;
        return { getRequestHeaders: async () => { throw failure; } };
      },
      fetch: responseFetch,
    });
    await assert.rejects(authorizedFetch(URL), error => {
      assert.ok(error instanceof GoogleCredentialsError);
      assert.equal(error.kind, 'expired_or_revoked');
      assert.equal('cause' in error, false);
      assert.equal('config' in error, false);
      assert.equal('response' in error, false);
      for (const serialized of [error.message, String(error), JSON.stringify(error), error.stack ?? '']) {
        assert.equal(serialized.includes(refreshToken), false);
        assert.equal(serialized.includes(clientSecret), false);
      }
      return true;
    });
  }
});

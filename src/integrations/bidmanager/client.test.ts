import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleCredentialsError, type AuthorizedFetch, type AuthorizedRequestInit } from '../google/auth.js';
import {
  BID_MANAGER_SCOPE,
  createBidManagerClient,
  type BidManagerClient,
  type DataRange,
  type NewQuery,
} from './client.js';
import { BidManagerError, type BidManagerErrorKind } from './errors.js';
import { NO_RETRIES } from '../google/retry.js';

const BASE_URL = 'https://doubleclickbidmanager.googleapis.com/v2';
const NEW_QUERY: NewQuery = {
  metadata: { title: '[MCP] Monthly report 2026-11-06T09:30:00Z', format: 'CSV' },
  params: { type: 'STANDARD', metrics: ['METRIC_IMPRESSIONS'] },
  schedule: { frequency: 'ONE_TIME' },
};
const QUERY = { queryId: '123', ...NEW_QUERY };
const REPORT = { key: { queryId: '123', reportId: '456' }, metadata: { status: { state: 'QUEUED' } } };
const DATA_RANGE: DataRange = {
  range: 'CUSTOM_DATES',
  customStartDate: { year: 2026, month: 10, day: 1 },
  customEndDate: { year: 2026, month: 10, day: 31 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(respond: AuthorizedFetch) {
  const calls: { url: string; init: AuthorizedRequestInit | undefined }[] = [];
  const fetch: AuthorizedFetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

function hasKind(kind: BidManagerErrorKind, message?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BidManagerError);
    assert.equal(error.kind, kind);
    assert.equal('cause' in error, false);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  };
}

// Instant backoff and pacing, so retry tests don't wait.
const FAST = { now: () => 0, sleep: async () => {}, random: () => 0 };

const METHODS = [
  { name: 'createQuery', method: 'POST', path: '/queries', body: NEW_QUERY,
    response: QUERY, call: (client: BidManagerClient) => client.createQuery(NEW_QUERY) },
  { name: 'runQuery', method: 'POST', path: '/queries/123:run', body: {},
    response: REPORT, call: (client: BidManagerClient) => client.runQuery('123') },
  { name: 'getQuery', method: 'GET', path: '/queries/123', body: undefined,
    response: QUERY, call: (client: BidManagerClient) => client.getQuery('123') },
  { name: 'listQueries', method: 'GET', path: '/queries', body: undefined,
    response: { queries: [QUERY] }, call: (client: BidManagerClient) => client.listQueries() },
  { name: 'deleteQuery', method: 'DELETE', path: '/queries/123', body: undefined,
    response: {}, call: (client: BidManagerClient) => client.deleteQuery('123') },
  { name: 'getReport', method: 'GET', path: '/queries/123/reports/456', body: undefined,
    response: REPORT, call: (client: BidManagerClient) => client.getReport('123', '456') },
];

test('Bid Manager scope is the reporting scope', () => {
  assert.equal(BID_MANAGER_SCOPE, 'https://www.googleapis.com/auth/doubleclickbidmanager');
});

for (const method of METHODS) {
  test(`${method.name} sends the expected URL, method, body and signal exactly once`, async () => {
    const fake = fakeFetch(async () => jsonResponse(method.response));
    const result = await method.call(createBidManagerClient(fake.fetch));
    assert.deepEqual(result, method.name === 'deleteQuery' ? undefined : method.response);
    assert.equal(fake.calls.length, 1);
    const { url, init } = fake.calls[0];
    assert.equal(url, BASE_URL + method.path);
    assert.equal(init?.method, method.method);
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.body, method.body === undefined ? undefined : JSON.stringify(method.body));
    assert.equal(new Headers(init.headers).get('content-type'), method.method === 'POST' ? 'application/json' : null);
    assert.equal(new URL(url).searchParams.has('synchronous'), false);
  });

  for (const [status, kind] of [[429, 'resource_exhausted'], [500, 'server_error'], [503, 'server_error']] as const) {
    // 429 is the reporting quota (never retried); 5xx is retried only where repeating can't duplicate work.
    const attempts = status === 429 || method.name === 'createQuery' || method.name === 'runQuery' ? 1 : 3;
    test(`${method.name} ${attempts === 1 ? 'does not retry' : 'retries'} HTTP ${status}`, async () => {
      const fake = fakeFetch(async () => jsonResponse({ error: { code: status } }, status));
      await assert.rejects(method.call(createBidManagerClient(fake.fetch, { runtime: FAST })), hasKind(kind));
      assert.equal(fake.calls.length, attempts);
    });
  }
}

test('runQuery sends only dataRange and never synchronous', async () => {
  const fake = fakeFetch(async () => jsonResponse(REPORT));
  await createBidManagerClient(fake.fetch).runQuery('123', { dataRange: DATA_RANGE });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, `${BASE_URL}/queries/123:run`);
  assert.equal(fake.calls[0].init?.body, JSON.stringify({ dataRange: DATA_RANGE }));
  assert.equal(new Headers(fake.calls[0].init?.headers).get('content-type'), 'application/json');
});

test('runQuery with empty options sends an empty JSON object', async () => {
  const fake = fakeFetch(async () => jsonResponse(REPORT));
  await createBidManagerClient(fake.fetch).runQuery('123', {});
  assert.equal(fake.calls[0].init?.body, '{}');
});

test('listQueries encodes every option including opaque token punctuation', async () => {
  const fake = fakeFetch(async () => jsonResponse({ queries: [QUERY], nextPageToken: 'next+/=' }));
  const result = await createBidManagerClient(fake.fetch).listQueries({
    pageSize: 100, pageToken: 'opaque+/= token', orderBy: 'metadata.title desc',
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url,
    `${BASE_URL}/queries?pageSize=100&pageToken=opaque%2B%2F%3D+token&orderBy=metadata.title+desc`);
  assert.deepEqual(result, { queries: [QUERY], nextPageToken: 'next+/=' });
});

test('listQueries omits unset options without adding defaults', async () => {
  const fake = fakeFetch(async () => jsonResponse({}));
  const client = createBidManagerClient(fake.fetch);
  await client.listQueries({});
  await client.listQueries({ pageToken: 'only-token' });
  assert.deepEqual(fake.calls.map(call => call.url), [
    `${BASE_URL}/queries`, `${BASE_URL}/queries?pageToken=only-token`,
  ]);
});

const ID_METHODS = [
  { name: 'runQuery queryId', call: (client: BidManagerClient, id: string) => client.runQuery(id) },
  { name: 'getQuery queryId', call: (client: BidManagerClient, id: string) => client.getQuery(id) },
  { name: 'deleteQuery queryId', call: (client: BidManagerClient, id: string) => client.deleteQuery(id) },
  { name: 'getReport queryId', call: (client: BidManagerClient, id: string) => client.getReport(id, '456') },
  { name: 'getReport reportId', call: (client: BidManagerClient, id: string) => client.getReport('123', id) },
];

for (const method of ID_METHODS) {
  for (const id of ['', 'abc', '1/../2', '1?x=1', '1'.repeat(21)]) {
    test(`${method.name} rejects ${JSON.stringify(id)} without fetching`, async () => {
      const fake = fakeFetch(async () => jsonResponse({}));
      await assert.rejects(method.call(createBidManagerClient(fake.fetch), id),
        hasKind('invalid_request', 'Query and report IDs must be numeric.'));
      assert.equal(fake.calls.length, 0);
    });
  }
}

for (const id of ['0', '1', '000123', '18446744073709551615']) {
  test(`string ID ${id} is preserved without number conversion`, async () => {
    const fake = fakeFetch(async () => jsonResponse({ ...QUERY, queryId: id }));
    const result = await createBidManagerClient(fake.fetch).getQuery(id);
    assert.equal(fake.calls[0].url, `${BASE_URL}/queries/${id}`);
    assert.equal(result.queryId, id);
  });
}

for (const pageSize of [0, 101, 1.5, -1, NaN, Infinity]) {
  test(`listQueries rejects pageSize ${pageSize} without fetching`, async () => {
    const fake = fakeFetch(async () => jsonResponse({}));
    await assert.rejects(createBidManagerClient(fake.fetch).listQueries({ pageSize }),
      hasKind('invalid_request', 'pageSize must be an integer from 1 to 100.'));
    assert.equal(fake.calls.length, 0);
  });
}

for (const pageSize of [1, 100]) {
  test(`listQueries accepts pageSize boundary ${pageSize}`, async () => {
    const fake = fakeFetch(async () => jsonResponse({}));
    await createBidManagerClient(fake.fetch).listQueries({ pageSize });
    assert.equal(fake.calls[0].url, `${BASE_URL}/queries?pageSize=${pageSize}`);
  });
}

for (const title of ['Monthly report', '[mcp] x 2026-11-06T09:30:00Z', '[MCP] x 2026-02-30T00:00:00Z']) {
  test(`createQuery rejects an unparseable title ${JSON.stringify(title)} without fetching`, async () => {
    const fake = fakeFetch(async () => jsonResponse(QUERY));
    await assert.rejects(createBidManagerClient(fake.fetch).createQuery({ ...NEW_QUERY, metadata: { title } }),
      hasKind('invalid_request', 'Only [MCP] queries can be created.'));
    assert.equal(fake.calls.length, 0);
  });
}

test('query responses retain unknown nested and top-level fields for copying', async () => {
  const body = {
    ...QUERY,
    metadata: { ...QUERY.metadata, sendNotification: false, shareEmailAddress: ['team@example.test'], extra: { nested: [1, 2] } },
    params: { ...QUERY.params, options: { includeOnlyTargetedUserLists: true }, unknown: ['kept'] },
    schedule: { frequency: 'ONE_TIME', nextRunTimezoneCode: 'Europe/Istanbul' },
    unknown: { retained: true },
  };
  for (const call of [
    (client: BidManagerClient) => client.createQuery(NEW_QUERY),
    (client: BidManagerClient) => client.getQuery('123'),
    (client: BidManagerClient) => client.listQueries(),
  ]) {
    const fake = fakeFetch(async () => jsonResponse({ ...body, queries: [body] }));
    const result = await call(createBidManagerClient(fake.fetch));
    assert.deepEqual(result, 'queryId' in result ? { ...body, queries: [body] } : { queries: [body] });
  }
});

for (const state of ['STATE_UNSPECIFIED', 'QUEUED', 'RUNNING', 'DONE', 'FAILED']) {
  test(`reports preserve ${state} and unknown response fields`, async () => {
    const body = { ...REPORT, metadata: { status: { state, finishTime: '2026-11-06T09:30:00Z', format: 'CSV' },
      googleCloudStoragePath: 'https://example.test/report.csv', extra: { retained: true } },
      params: { options: { retained: true } }, extra: ['kept'] };
    const fake = fakeFetch(async () => jsonResponse(body));
    const client = createBidManagerClient(fake.fetch);
    assert.deepEqual(await client.runQuery('123'), body);
    assert.deepEqual(await client.getReport('123', '456'), body);
  });
}

for (const body of [{}, { nextPageToken: '' }, { queries: [], nextPageToken: '' }]) {
  test(`listQueries normalizes an empty page ${JSON.stringify(body)}`, async () => {
    const fake = fakeFetch(async () => jsonResponse(body));
    const result = await createBidManagerClient(fake.fetch).listQueries();
    assert.deepEqual(result, { queries: [] });
    assert.equal(Object.hasOwn(result, 'nextPageToken'), false);
  });
}

const INVALID_QUERIES = [null, [], {}, { metadata: QUERY.metadata }, { ...QUERY, queryId: 123 },
  { ...QUERY, queryId: 'abc' }, { queryId: '123' }, { ...QUERY, metadata: { title: 123 } }];
for (const [index, body] of INVALID_QUERIES.entries()) {
  for (const name of ['createQuery', 'getQuery', 'listQueries'] as const) {
    test(`${name} rejects malformed query response ${index}`, async () => {
      const fake = fakeFetch(async () => jsonResponse(name === 'listQueries' ? { queries: [body] } : body));
      const client = createBidManagerClient(fake.fetch);
      const pending = name === 'createQuery' ? client.createQuery(NEW_QUERY)
        : name === 'getQuery' ? client.getQuery('123') : client.listQueries();
      await assert.rejects(pending, hasKind('unexpected_response'));
    });
  }
}

const INVALID_REPORTS = [null, [], {}, { ...REPORT, key: { queryId: 123, reportId: '456' } },
  { ...REPORT, key: { queryId: '123' } }, { ...REPORT, key: { queryId: '123', reportId: 456 } },
  { ...REPORT, metadata: {} }, { ...REPORT, metadata: { status: { state: 'UNKNOWN' } } },
  { ...REPORT, metadata: { ...REPORT.metadata, googleCloudStoragePath: 123 } }];
for (const [index, body] of INVALID_REPORTS.entries()) {
  for (const name of ['runQuery', 'getReport'] as const) {
    test(`${name} rejects malformed report response ${index}`, async () => {
      const fake = fakeFetch(async () => jsonResponse(body));
      const client = createBidManagerClient(fake.fetch);
      await assert.rejects(name === 'runQuery' ? client.runQuery('123') : client.getReport('123', '456'),
        hasKind('unexpected_response'));
    });
  }
}

for (const body of [null, [], { queries: null }, { queries: {} }, { nextPageToken: 123 }]) {
  test(`listQueries rejects malformed page ${JSON.stringify(body)}`, async () => {
    const fake = fakeFetch(async () => jsonResponse(body));
    await assert.rejects(createBidManagerClient(fake.fetch).listQueries(), hasKind('unexpected_response'));
  });
}

for (const method of METHODS.filter(method => method.name !== 'deleteQuery')) {
  test(`${method.name} rejects invalid JSON`, async () => {
    const fake = fakeFetch(async () => new Response('{broken-json'));
    await assert.rejects(method.call(createBidManagerClient(fake.fetch)), hasKind('unexpected_response'));
  });
}

for (const kind of ['not_found', 'expired_or_revoked', 'unavailable'] as const) {
  test(`credential error ${kind} reaches the caller as the same instance`, async () => {
    const failure = new GoogleCredentialsError(kind);
    const fake = fakeFetch(async () => { throw failure; });
    await assert.rejects(createBidManagerClient(fake.fetch, { retry: NO_RETRIES }).getQuery('123'), error => error === failure);
    assert.equal(fake.calls.length, 1);
  });
}

for (const [failure, kind] of [
  [new TypeError('fetch failed'), 'network'],
  [Object.assign(new Error('deadline elapsed'), { name: 'TimeoutError' }), 'timeout'],
  [new DOMException('aborted', 'AbortError'), 'network'],
] as const) {
  test(`fetch rejection ${failure.name} maps to ${kind} without a cause or retry`, async () => {
    const fake = fakeFetch(async () => { throw failure; });
    await assert.rejects(createBidManagerClient(fake.fetch, { retry: NO_RETRIES }).getQuery('123'), hasKind(kind));
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].init?.signal?.aborted, false);
  });
}

for (const status of [200, 400]) {
  for (const [failure, kind] of [
    [Object.assign(new Error('body timeout'), { name: 'TimeoutError' }), 'timeout'],
    [new TypeError('body read failed'), 'network'],
    [new DOMException('aborted', 'AbortError'), 'network'],
  ] as const) {
    test(`HTTP ${status} text rejection ${failure.name} maps to ${kind}`, async () => {
      const response = jsonResponse({}, status);
      response.text = async () => { throw failure; };
      const fake = fakeFetch(async () => response);
      await assert.rejects(createBidManagerClient(fake.fetch, { retry: NO_RETRIES }).getQuery('123'), hasKind(kind));
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].init?.signal?.aborted, false);
    });
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

for (const stage of ['fetch', '200 body', '400 body'] as const) {
  test(`configured signal timeout during ${stage} maps AbortError to timeout`, async () => {
    // AbortSignal.timeout's timer is unref'ed. This referenced watchdog both keeps
    // the event loop alive and makes a missing abort fail instead of hanging.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('timeout signal did not abort within 2 seconds')), 2_000);
    });
    const fake = fakeFetch(async (_url, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      if (stage === 'fetch') return waitForAbort(init.signal);
      const response = jsonResponse({}, stage === '200 body' ? 200 : 400);
      response.text = () => waitForAbort(init.signal!);
      return response;
    });
    try {
      const pending = createBidManagerClient(fake.fetch, { timeoutMs: 20, retry: NO_RETRIES }).getQuery('123');
      await assert.rejects(Promise.race([pending, deadline]), hasKind('timeout'));
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].init?.signal?.aborted, true);
      assert.equal(fake.calls[0].init?.signal?.reason.name, 'TimeoutError');
    } finally {
      clearTimeout(watchdog);
    }
  });
}

// --- Step 2: listReports, idempotency per method, call options ---

test('listReports sends pageSize then orderBy and returns the reports', async () => {
  const fake = fakeFetch(async () => jsonResponse({ reports: [REPORT], nextPageToken: 'next' }));
  const result = await createBidManagerClient(fake.fetch).listReports('123', { orderBy: 'key.reportId desc', pageSize: 10 });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, `${BASE_URL}/queries/123/reports?pageSize=10&orderBy=key.reportId+desc`);
  assert.equal(fake.calls[0].init?.method, 'GET');
  assert.deepEqual(result, { reports: [REPORT], nextPageToken: 'next' });
});

test('listReports without options sends no parameters', async () => {
  const fake = fakeFetch(async () => jsonResponse({ reports: [REPORT] }));
  assert.deepEqual(await createBidManagerClient(fake.fetch).listReports('123'), { reports: [REPORT] });
  assert.equal(fake.calls[0].url, `${BASE_URL}/queries/123/reports`);
});

for (const body of [{}, { nextPageToken: '' }, { reports: [] }]) {
  test(`listReports normalizes an empty list ${JSON.stringify(body)}`, async () => {
    const fake = fakeFetch(async () => jsonResponse(body));
    const result = await createBidManagerClient(fake.fetch).listReports('123');
    assert.deepEqual(result, { reports: [] });
    assert.equal(Object.hasOwn(result, 'nextPageToken'), false);
  });
}

test('listReports guards the query ID and pageSize without fetching', async () => {
  const fake = fakeFetch(async () => jsonResponse({}));
  const client = createBidManagerClient(fake.fetch);
  for (const id of ['', 'abc', '1/../2']) {
    await assert.rejects(client.listReports(id), hasKind('invalid_request', 'Query and report IDs must be numeric.'));
  }
  for (const pageSize of [0, 101, 1.5, NaN]) {
    await assert.rejects(client.listReports('123', { pageSize }), hasKind('invalid_request', 'pageSize must be an integer from 1 to 100.'));
  }
  assert.equal(fake.calls.length, 0);
});

for (const body of [null, [], { reports: null }, { reports: {} }, { reports: [{}] }, { reports: [REPORT], nextPageToken: 1 }]) {
  test(`listReports rejects malformed response ${JSON.stringify(body)}`, async () => {
    const fake = fakeFetch(async () => jsonResponse(body));
    await assert.rejects(createBidManagerClient(fake.fetch).listReports('123'), hasKind('unexpected_response'));
  });
}

const USER_RATE_LIMIT = { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } };

for (const method of METHODS.filter(method => method.name === 'createQuery' || method.name === 'runQuery')) {
  test(`${method.name} is retried on 403 userRateLimitExceeded`, async () => {
    let calls = 0;
    const fake = fakeFetch(async () => (++calls === 1 ? jsonResponse(USER_RATE_LIMIT, 403) : jsonResponse(method.response)));
    assert.deepEqual(await method.call(createBidManagerClient(fake.fetch, { runtime: FAST })), method.response);
    assert.equal(fake.calls.length, 2);
  });
}

test('getQuery is retried on 503 and returns the later success', async () => {
  let calls = 0;
  const fake = fakeFetch(async () => (++calls === 1 ? jsonResponse({}, 503) : jsonResponse(QUERY)));
  assert.deepEqual(await createBidManagerClient(fake.fetch, { runtime: FAST }).getQuery('123'), QUERY);
  assert.equal(fake.calls.length, 2);
});

test('the call signal reaches fetch combined with the timeout', async () => {
  const fake = fakeFetch(async () => jsonResponse(QUERY));
  const controller = new AbortController();
  await createBidManagerClient(fake.fetch).getQuery('123', { signal: controller.signal });
  const signal = fake.calls[0].init?.signal;
  assert.ok(signal instanceof AbortSignal);
  controller.abort();
  assert.equal(signal.aborted, true);
});

test('a daily limit latches the client: the next call fails without fetching', async () => {
  const fake = fakeFetch(async () => jsonResponse({ error: { code: 403, errors: [{ reason: 'dailyLimitExceeded' }] } }, 403));
  const client = createBidManagerClient(fake.fetch, { runtime: FAST });
  await assert.rejects(client.getQuery('123'), hasKind('daily_limit'));
  await assert.rejects(client.listReports('123'), hasKind('daily_limit'));
  assert.equal(fake.calls.length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleCredentialsError, type AuthorizedFetch, type AuthorizedRequestInit } from '../google/auth.js';
import {
  DISPLAY_VIDEO_SCOPE, FILTERABLE_STATUSES, checkStatuses, createDv360Client,
  type Dv360Client, type EntityStatus, type LineItemListOptions, type ListOptions, type ResourceType,
} from './client.js';
import { Dv360Error, type Dv360ErrorKind } from './errors.js';
import { NO_RETRIES } from '../google/retry.js';

const BASE = 'https://displayvideo.googleapis.com/v4';
const ACTIVE = 'ENTITY_STATUS_ACTIVE';
const PAUSED = 'ENTITY_STATUS_PAUSED';
const STATUSES = {
  partner: [ACTIVE, PAUSED, 'ENTITY_STATUS_DRAFT', 'ENTITY_STATUS_ARCHIVED', 'ENTITY_STATUS_SCHEDULED_FOR_DELETION'],
  advertiser: [ACTIVE, PAUSED, 'ENTITY_STATUS_SCHEDULED_FOR_DELETION'],
  campaign: [ACTIVE, PAUSED, 'ENTITY_STATUS_ARCHIVED'],
  insertionOrder: [ACTIVE, PAUSED, 'ENTITY_STATUS_DRAFT', 'ENTITY_STATUS_ARCHIVED'],
  lineItem: [ACTIVE, PAUSED, 'ENTITY_STATUS_DRAFT', 'ENTITY_STATUS_ARCHIVED'],
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(respond: AuthorizedFetch = async () => json({})) {
  const calls: { url: string; init: AuthorizedRequestInit | undefined }[] = [];
  const fetch: AuthorizedFetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

function hasKind(kind: Dv360ErrorKind, message?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Dv360Error);
    assert.equal(error.kind, kind);
    assert.equal('cause' in error, false);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  };
}

const RESOURCES: readonly {
  resource: ResourceType; key: string; id: string; value: string; path: string; label: string;
  parents: readonly string[];
  list: (client: Dv360Client, options?: LineItemListOptions) => Promise<unknown>;
  get: (client: Dv360Client) => Promise<unknown>;
}[] = [
  { resource: 'partner', key: 'partners', id: 'partnerId', value: '1', path: '/partners', label: 'partners', parents: [],
    list: (c, o) => c.listPartners(o), get: c => c.getPartner('1') },
  { resource: 'advertiser', key: 'advertisers', id: 'advertiserId', value: '1', path: '/advertisers?partnerId=1', label: 'advertisers', parents: ['partnerId'],
    list: (c, o) => c.listAdvertisers('1', o), get: c => c.getAdvertiser('1') },
  { resource: 'campaign', key: 'campaigns', id: 'campaignId', value: '2', path: '/advertisers/1/campaigns', label: 'campaigns', parents: ['advertiserId'],
    list: (c, o) => c.listCampaigns('1', o), get: c => c.getCampaign('1', '2') },
  { resource: 'insertionOrder', key: 'insertionOrders', id: 'insertionOrderId', value: '3', path: '/advertisers/1/insertionOrders', label: 'insertion orders', parents: ['advertiserId', 'campaignId'],
    list: (c, o) => c.listInsertionOrders('1', o), get: c => c.getInsertionOrder('1', '3') },
  { resource: 'lineItem', key: 'lineItems', id: 'lineItemId', value: '4', path: '/advertisers/1/lineItems', label: 'line items', parents: ['advertiserId', 'campaignId', 'insertionOrderId'],
    list: (c, o) => c.listLineItems('1', o), get: c => c.getLineItem('1', '4') },
];

test('DV360 exports its scope and exact frozen filterable status table', () => {
  assert.equal(DISPLAY_VIDEO_SCOPE, 'https://www.googleapis.com/auth/display-video');
  assert.deepEqual(FILTERABLE_STATUSES, STATUSES);
  assert.ok(Object.isFrozen(FILTERABLE_STATUSES));
  for (const values of Object.values(FILTERABLE_STATUSES)) assert.ok(Object.isFrozen(values));
});

for (const resource of RESOURCES) {
  const entity = { [resource.id]: resource.value, displayName: 'Entity A' };
  for (const operation of ['list', 'get'] as const) {
    const body = operation === 'list' ? { [resource.key]: [entity] } : entity;
    const path = operation === 'list' ? resource.path
      : resource.resource === 'advertiser' ? '/advertisers/1' : `${resource.path}/${resource.value}`;
    test(`${operation} ${resource.resource} sends GET, exact URL, fresh signal and no body or headers`, async () => {
      const fake = fakeFetch(async () => json(body));
      const client = createDv360Client(fake.fetch);
      const result = await resource[operation](client);
      assert.deepEqual(result, operation === 'list' ? { items: [entity] } : entity);
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].url, BASE + path);
      const init = fake.calls[0].init;
      assert.equal(init?.method, 'GET');
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      assert.equal('body' in init, false);
      assert.equal('headers' in init, false);
      await resource[operation](client);
      assert.notEqual(fake.calls[0].init?.signal, fake.calls[1].init?.signal);
    });
    for (const [status, kind] of [[429, 'rate_limited'], [500, 'server_error'], [503, 'server_error']] as const) {
      // Every DV360 call is a GET: 5xx is retried; 429 only with a Retry-After header, which this response lacks.
      const attempts = status === 429 ? 1 : 3;
      test(`${operation} ${resource.resource} ${status === 429 ? 'does not retry HTTP 429 without Retry-After' : `retries HTTP ${status}`}`, async () => {
        const fake = fakeFetch(async () => json({ error: { code: status } }, status));
        const runtime = { sleep: async () => {}, random: () => 0 };
        await assert.rejects(resource[operation](createDv360Client(fake.fetch, { runtime })), hasKind(kind));
        assert.equal(fake.calls.length, attempts);
      });
    }
    test(`${operation} ${resource.resource} preserves unknown nested fields and absent or future status`, async () => {
      for (const status of [undefined, 'ENTITY_STATUS_SOMETHING_NEW']) {
        const extended = { ...entity, ...(status === undefined ? {} : { entityStatus: status }),
          budget: { segments: [{ budgetAmountMicros: '12345678901234567890' }] },
          flight: { dateRange: { startDate: { year: 2026 } } }, bidStrategy: { fixedBid: {} }, generalConfig: { currencyCode: 'USD' } };
        const fake = fakeFetch(async () => json(operation === 'list' ? { [resource.key]: [extended] } : extended));
        assert.deepEqual(await resource[operation](createDv360Client(fake.fetch)), operation === 'list' ? { items: [extended] } : extended);
      }
    });
    const invalidEntities: readonly unknown[] = [null, [], 'bad', {}, { displayName: 'A' }, { ...entity, [resource.id]: 1 },
      { ...entity, [resource.id]: '' }, { ...entity, [resource.id]: '1/2' }, { ...entity, [resource.id]: '1'.repeat(21) },
      { [resource.id]: resource.value }, { ...entity, displayName: null }, { ...entity, entityStatus: 42 }, { ...entity, entityStatus: null }];
    test(`${operation} ${resource.resource} rejects malformed entities`, async () => {
      for (const invalid of invalidEntities) {
        const fake = fakeFetch(async () => json(operation === 'list' ? { [resource.key]: [invalid] } : invalid));
        await assert.rejects(resource[operation](createDv360Client(fake.fetch)), hasKind('unexpected_response'));
      }
    });
    for (const parent of resource.parents) {
      test(`${operation} ${resource.resource} validates optional ${parent}`, async () => {
        for (const value of [null, 1, '', 'bad', '1'.repeat(21)]) {
          const invalid = { ...entity, [parent]: value };
          const fake = fakeFetch(async () => json(operation === 'list' ? { [resource.key]: [invalid] } : invalid));
          await assert.rejects(resource[operation](createDv360Client(fake.fetch)), hasKind('unexpected_response'));
        }
      });
    }
  }
  test(`get ${resource.resource} rejects a returned ID different from the requested ID`, async () => {
    const fake = fakeFetch(async () => json({ ...entity, [resource.id]: '999' }));
    await assert.rejects(resource.get(createDv360Client(fake.fetch)), hasKind('unexpected_response'));
  });
  if (resource.parents.includes('advertiserId')) {
    test(`get ${resource.resource} checks advertiser scope when present and accepts its omission`, async () => {
      for (const advertiserId of ['1', '999', undefined]) {
        const fake = fakeFetch(async () => json({ ...entity, ...(advertiserId === undefined ? {} : { advertiserId }) }));
        const result = resource.get(createDv360Client(fake.fetch));
        if (advertiserId === '999') await assert.rejects(result, hasKind('unexpected_response'));
        else await result;
      }
    });
  }
  test(`list ${resource.resource} maps empty envelopes and tokens`, async () => {
    for (const body of [{}, { [resource.key]: [] }, { nextPageToken: '' }, { [resource.key]: [], nextPageToken: 'next+/=' }]) {
      const fake = fakeFetch(async () => json(body));
      assert.deepEqual(await resource.list(createDv360Client(fake.fetch)), {
        items: [], ...('nextPageToken' in body && body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
      });
    }
  });
  test(`list ${resource.resource} rejects malformed envelopes and non-string tokens`, async () => {
    for (const body of [null, [], true, 42, 'bad', { [resource.key]: null }, { [resource.key]: {} },
      { [resource.key]: 'bad' }, { nextPageToken: 42 }, { nextPageToken: null }, { [resource.key]: [entity, {}] }]) {
      const fake = fakeFetch(async () => json(body));
      await assert.rejects(resource.list(createDv360Client(fake.fetch)), hasKind('unexpected_response'));
    }
  });
  test(`list ${resource.resource} accepts each supported status and builds canonical filters`, async () => {
    const fake = fakeFetch();
    const client = createDv360Client(fake.fetch);
    for (const status of STATUSES[resource.resource]) {
      await resource.list(client, { statuses: [status] });
      assert.equal(new URL(fake.calls.at(-1)!.url).searchParams.get('filter'), `entityStatus="${status}"`);
    }
    await resource.list(client, { statuses: [PAUSED, ACTIVE, PAUSED] });
    assert.equal(new URL(fake.calls.at(-1)!.url).searchParams.get('filter'), `(entityStatus="${ACTIVE}" OR entityStatus="${PAUSED}")`);
    await resource.list(client);
    assert.equal(new URL(fake.calls.at(-1)!.url).searchParams.has('filter'), false);
  });
  test(`list ${resource.resource} rejects empty, unknown and incompatible statuses without fetch`, async () => {
    const fake = fakeFetch();
    const client = createDv360Client(fake.fetch);
    await assert.rejects(resource.list(client, { statuses: [] }), hasKind('invalid_request', 'statuses must not be empty.'));
    for (const value of ['ENTITY_STATUS_UNSPECIFIED', 'active', 'x"; DROP', 42, null]) {
      await assert.rejects(resource.list(client, { statuses: [value] as readonly EntityStatus[] }),
        hasKind('invalid_request', `That value is not a valid status for ${resource.label}.`));
    }
    for (const status of STATUSES.partner) {
      if (!(STATUSES[resource.resource] as readonly string[]).includes(status)) {
        await assert.rejects(resource.list(client, { statuses: [status] }),
          hasKind('invalid_request', `${status} is not a valid status for ${resource.label}.`));
      }
    }
    assert.equal(fake.calls.length, 0);
  });
  test(`list ${resource.resource} rejects malformed status containers before fetch`, async () => {
    const fake = fakeFetch();
    const client = createDv360Client(fake.fetch);
    for (const statuses of [null, 1, {}, true, ACTIVE]) {
      await assert.rejects(resource.list(client, { statuses } as unknown as ListOptions),
        hasKind('invalid_request', `That value is not a valid status for ${resource.label}.`));
    }
    assert.equal(fake.calls.length, 0);
  });
  test(`list ${resource.resource} validates page sizes and tokens before fetch`, async () => {
    const fake = fakeFetch();
    const client = createDv360Client(fake.fetch);
    const cap = resource.resource === 'insertionOrder' ? 100 : 200;
    for (const pageSize of [0, -1, cap + 1, 1.5, NaN, Infinity]) {
      await assert.rejects(resource.list(client, { pageSize }), hasKind('invalid_request', `pageSize must be an integer from 1 to ${cap}.`));
    }
    for (const pageToken of ['', 'x'.repeat(1001), 42, null]) {
      await assert.rejects(resource.list(client, { pageToken } as ListOptions), hasKind('invalid_request', 'pageToken is not valid.'));
    }
    assert.equal(fake.calls.length, 0);
    for (const pageSize of [1, cap]) await resource.list(client, { pageSize, pageToken: 'x'.repeat(1000) });
    assert.equal(fake.calls.length, 2);
  });
  test(`list ${resource.resource} encodes parameters in their specified order`, async () => {
    const fake = fakeFetch();
    await resource.list(createDv360Client(fake.fetch), { pageSize: 1, pageToken: 'token+/=', statuses: [ACTIVE] });
    const params = new URLSearchParams();
    if (resource.resource === 'advertiser') params.set('partnerId', '1');
    params.set('pageSize', '1');
    params.set('pageToken', 'token+/=');
    params.set('filter', `entityStatus="${ACTIVE}"`);
    assert.equal(fake.calls[0].url, BASE + resource.path.split('?')[0] + '?' + params.toString());
  });
}

const ID_POSITIONS: readonly [string, (c: Dv360Client, id: string) => Promise<unknown>][] = [
  ['listAdvertisers partner', (c, id) => c.listAdvertisers(id)],
  ['listCampaigns advertiser', (c, id) => c.listCampaigns(id)],
  ['listInsertionOrders advertiser', (c, id) => c.listInsertionOrders(id)],
  ['listLineItems advertiser', (c, id) => c.listLineItems(id)],
  ['getPartner partner', (c, id) => c.getPartner(id)],
  ['getAdvertiser advertiser', (c, id) => c.getAdvertiser(id)],
  ['getCampaign advertiser', (c, id) => c.getCampaign(id, '2')],
  ['getCampaign campaign', (c, id) => c.getCampaign('1', id)],
  ['getInsertionOrder advertiser', (c, id) => c.getInsertionOrder(id, '3')],
  ['getInsertionOrder insertionOrder', (c, id) => c.getInsertionOrder('1', id)],
  ['getLineItem advertiser', (c, id) => c.getLineItem(id, '4')],
  ['getLineItem lineItem', (c, id) => c.getLineItem('1', id)],
  ['listInsertionOrders campaign option', (c, id) => c.listInsertionOrders('1', { campaignId: id })],
  ['listLineItems campaign option', (c, id) => c.listLineItems('1', { campaignId: id })],
  ['listLineItems insertionOrder option', (c, id) => c.listLineItems('1', { insertionOrderId: id })],
];
for (const [name, call] of ID_POSITIONS) {
  test(`${name} rejects every malformed ID before fetch`, async () => {
    const fake = fakeFetch();
    for (const id of ['', 'abc', '1/../2', '1?x=1', '-1', '1'.repeat(21), 1, null]) {
      await assert.rejects(call(createDv360Client(fake.fetch), id as string), hasKind('invalid_request', 'IDs must be numeric.'));
    }
    assert.equal(fake.calls.length, 0);
  });
}

test('parent filters compose in status, campaign, insertion-order order and stay canonical', async () => {
  const fake = fakeFetch();
  const client = createDv360Client(fake.fetch);
  await client.listInsertionOrders('1', { campaignId: '123' });
  assert.equal(new URL(fake.calls[0].url).searchParams.get('filter'), 'campaignId="123"');
  await client.listLineItems('1', { statuses: [PAUSED, ACTIVE, PAUSED], campaignId: '123', insertionOrderId: '456' });
  const expected = `(entityStatus="${ACTIVE}" OR entityStatus="${PAUSED}") AND campaignId="123" AND insertionOrderId="456"`;
  assert.equal(new URL(fake.calls[1].url).searchParams.get('filter'), expected);
  await client.listLineItems('1', { insertionOrderId: '456', campaignId: '123', statuses: [ACTIVE, PAUSED] });
  assert.equal(fake.calls[1].url, fake.calls[2].url);
  await client.listLineItems('1', { insertionOrderId: '000456' });
  assert.equal(new URL(fake.calls[3].url).searchParams.get('filter'), 'insertionOrderId="000456"');
});

test('all partner statuses make the longest supported status filter, below 500 characters', async () => {
  const fake = fakeFetch();
  await createDv360Client(fake.fetch).listPartners({ statuses: [...STATUSES.partner].reverse() });
  const filter = new URL(fake.calls[0].url).searchParams.get('filter');
  assert.equal(filter, '(' + STATUSES.partner.map(status => `entityStatus="${status}"`).join(' OR ') + ')');
  assert.ok(filter.length < 500);
});

test('numeric IDs preserve zeroes and the 20-digit boundary in paths and entities', async () => {
  for (const id of ['0', '0001', '12345678901234567890']) {
    const entity = { partnerId: id, displayName: '' };
    const fake = fakeFetch(async () => json(entity));
    assert.deepEqual(await createDv360Client(fake.fetch).getPartner(id), entity);
    assert.equal(fake.calls[0].url, `${BASE}/partners/${id}`);
  }
});

test('invalid JSON on successful responses is unexpected_response', async () => {
  for (const body of ['', '{', '<html>error</html>']) {
    const fake = fakeFetch(async () => new Response(body));
    await assert.rejects(createDv360Client(fake.fetch).listPartners(), hasKind('unexpected_response'));
  }
});

test('request timeout defaults to 30 seconds and accepts an override', async t => {
  const delays: number[] = [];
  const signal = new AbortController().signal;
  t.mock.method(AbortSignal, 'timeout', (delay: number) => {
    delays.push(delay);
    return signal;
  });
  const fake = fakeFetch();
  await createDv360Client(fake.fetch).listPartners();
  await createDv360Client(fake.fetch, { timeoutMs: 17 }).listPartners();
  assert.deepEqual(delays, [30_000, 17]);
  for (const call of fake.calls) assert.equal(call.init?.signal, signal);
});

for (const kind of ['not_found', 'expired_or_revoked', 'unavailable'] as const) {
  test(`credential error ${kind} passes through unchanged`, async () => {
    const original = new GoogleCredentialsError(kind);
    const fake = fakeFetch(async () => { throw original; });
    await assert.rejects(createDv360Client(fake.fetch, { retry: NO_RETRIES }).listPartners(), error => error === original);
  });
}

for (const [failure, kind] of [[new TypeError('secret-fetch'), 'network'], [new DOMException('secret-abort', 'AbortError'), 'network'],
  [new DOMException('secret-timeout', 'TimeoutError'), 'timeout'], ['secret-string', 'network']] as const) {
  test(`fetch ${failure instanceof Error ? failure.name : 'non-Error'} maps to ${kind} without exposing the failure`, async () => {
    const fake = fakeFetch(async () => { throw failure; });
    await assert.rejects(createDv360Client(fake.fetch, { retry: NO_RETRIES }).listPartners(), error => {
      hasKind(kind)(error);
      assert.equal(JSON.stringify(error).includes('secret-'), false);
      return true;
    });
  });
}

for (const status of [200, 400]) {
  for (const [name, kind] of [['TimeoutError', 'timeout'], ['TypeError', 'network'], ['AbortError', 'network']] as const) {
    test(`HTTP ${status} body read ${name} maps to ${kind}`, async () => {
      const fake = fakeFetch(async () => {
        const response = new Response('', { status });
        response.text = async () => { throw Object.assign(new Error('secret-body'), { name }); };
        return response;
      });
      await assert.rejects(createDv360Client(fake.fetch, { retry: NO_RETRIES }).listPartners(), hasKind(kind));
    });
  }
}

for (const stage of ['fetch', 'body'] as const) {
  test(`own timeout covers ${stage} even when abort rejects with TypeError`, async () => {
    // AbortSignal.timeout is unref'ed; keep the test alive until the signal fires.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      const fake = fakeFetch(async (_url, init) => {
        const pending = () => new Promise<never>((_resolve, reject) => {
          assert.ok(init?.signal);
          init.signal.addEventListener('abort', () => reject(new TypeError('secret-timeout')), { once: true });
        });
        if (stage === 'fetch') return pending();
        const response = new Response('{}');
        response.text = pending;
        return response;
      });
      await assert.rejects(createDv360Client(fake.fetch, { timeoutMs: 20, retry: NO_RETRIES }).listPartners(), hasKind('timeout'));
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].init?.signal?.aborted, true);
    } finally {
      clearTimeout(keepAlive);
    }
  });
}

// --- Step 2: retries and call options ---

test('a list method is retried on 503 and returns the later success', async () => {
  let calls = 0;
  const fake = fakeFetch(async () => (++calls === 1 ? json({}, 503) : json({ partners: [] })));
  const runtime = { sleep: async () => {}, random: () => 0 };
  assert.deepEqual(await createDv360Client(fake.fetch, { runtime }).listPartners(), { items: [] });
  assert.equal(fake.calls.length, 2);
});

test('a 429 without Retry-After is not retried', async () => {
  const fake = fakeFetch(async () => json({ error: { code: 429 } }, 429));
  await assert.rejects(createDv360Client(fake.fetch).listPartners(), hasKind('rate_limited'));
  assert.equal(fake.calls.length, 1);
});

test('the call signal reaches fetch combined with the timeout', async () => {
  const fake = fakeFetch(async () => json({ partners: [] }));
  const controller = new AbortController();
  await createDv360Client(fake.fetch).listPartners(undefined, { signal: controller.signal });
  const signal = fake.calls[0].init?.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal(signal.aborted, true);
});

test('checkStatuses returns statuses de-duplicated in canonical order for each resource', () => {
  for (const resource of Object.keys(STATUSES) as ResourceType[]) {
    const all = STATUSES[resource] as readonly EntityStatus[];
    assert.deepEqual(checkStatuses(resource, [...all].reverse()), FILTERABLE_STATUSES[resource]);
    assert.deepEqual(checkStatuses(resource, [PAUSED, ACTIVE, PAUSED]), [ACTIVE, PAUSED]);
  }
});

test('checkStatuses throws the list messages for empty, unknown, incompatible, and malformed statuses', () => {
  const label = (resource: ResourceType) =>
    ({ partner: 'partners', advertiser: 'advertisers', campaign: 'campaigns', insertionOrder: 'insertion orders', lineItem: 'line items' })[resource];
  for (const resource of Object.keys(STATUSES) as ResourceType[]) {
    assert.throws(() => checkStatuses(resource, []), hasKind('invalid_request', 'statuses must not be empty.'));
    for (const value of ['ENTITY_STATUS_UNSPECIFIED', 'active', 42, null]) {
      assert.throws(() => checkStatuses(resource, [value] as readonly EntityStatus[]),
        hasKind('invalid_request', `That value is not a valid status for ${label(resource)}.`));
    }
    for (const status of STATUSES.partner) {
      if (!(STATUSES[resource] as readonly string[]).includes(status)) {
        assert.throws(() => checkStatuses(resource, [status]), hasKind('invalid_request', `${status} is not a valid status for ${label(resource)}.`));
      }
    }
    assert.throws(() => checkStatuses(resource, ACTIVE as unknown as readonly EntityStatus[]),
      hasKind('invalid_request', `That value is not a valid status for ${label(resource)}.`));
  }
});

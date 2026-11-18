import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleCredentialsError } from '../google/auth.js';
import { FILTERABLE_STATUSES, type Dv360Client, type Page } from './client.js';
import { Dv360Error } from './errors.js';
import { MAX_ROW_CHARS } from './format.js';
import type { CallOptions } from '../google/request.js';
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, RESOURCE_STATUSES, STATUS_NAMES, createMetadataService, safeErrorMessage,
  type ListRequest, type MetadataService,
} from './metadata.js';
import {
  DIRECTORY_REFRESH_AFTER_MS, DIRECTORY_TTL_MS, MAX_CACHED_DIRECTORIES, MAX_DIRECTORY_PAGES, MAX_FIND_PAGES, MAX_MATCHES,
  MAX_PARTNERS, MAX_PARTNER_SCANS, SCAN_BUDGET_MS, type FindRequest, type StatusName,
} from './metadata.js';

type Entity = Record<string, unknown>;
type Call = { readonly method: string; readonly args: readonly unknown[] };

const GENERIC = "Unexpected server error. Try again; if it keeps happening, report it to the server's maintainer.";
const day = (year: number, month: number, dayOfMonth: number) => ({ year, month, day: dayOfMonth });
const segment = (a: [number, number, number], b: [number, number, number], amount = '15800000') =>
  ({ budgetAmountMicros: amount, dateRange: { startDate: day(...a), endDate: day(...b) } });
const advertiser = (overrides: Entity = {}): Entity => ({
  advertiserId: '10', partnerId: '1', displayName: 'Advertiser A', entityStatus: 'ENTITY_STATUS_ACTIVE',
  generalConfig: { currencyCode: 'TRY', timeZone: 'Europe/Istanbul' }, ...overrides,
});
const partner: Entity = { partnerId: '1', displayName: 'Partner A', entityStatus: 'ENTITY_STATUS_ACTIVE', generalConfig: { currencyCode: 'USD' } };
const campaign = (id = '20'): Entity => ({
  campaignId: id, advertiserId: '10', displayName: `Campaign ${id}`, entityStatus: 'ENTITY_STATUS_ACTIVE',
  campaignGoal: { campaignGoalType: 'CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS' },
  campaignFlight: { plannedDates: { startDate: day(2026, 3, 1), endDate: day(2026, 3, 31) }, plannedSpendAmountMicros: '2500000000' },
});
const insertionOrder = (segments: unknown[] = [segment([2026, 11, 1], [2026, 11, 30])], extra: Entity = {}): Entity => ({
  insertionOrderId: '30', advertiserId: '10', campaignId: '20', displayName: 'IO 30', entityStatus: 'ENTITY_STATUS_ACTIVE',
  budget: { budgetUnit: 'BUDGET_UNIT_CURRENCY', automationType: 'INSERTION_ORDER_AUTOMATION_TYPE_NONE', budgetSegments: segments },
  pacing: { pacingPeriod: 'PACING_PERIOD_FLIGHT', pacingType: 'PACING_TYPE_AHEAD' }, ...extra,
});
const lineItem = (id = '40'): Entity => ({
  lineItemId: id, advertiserId: '10', campaignId: '20', insertionOrderId: '30', displayName: `Line item ${id}`,
  entityStatus: 'ENTITY_STATUS_ACTIVE', lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT',
  flight: { flightDateType: 'LINE_ITEM_FLIGHT_DATE_TYPE_INHERITED', dateRange: { startDate: day(2026, 1, 1), endDate: day(2026, 12, 31) } },
  budget: { budgetAllocationType: 'LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED', budgetUnit: 'BUDGET_UNIT_CURRENCY', maxAmount: '15800000' },
  bidStrategy: { fixedBid: { bidAmountMicros: '2500000' } },
});

const NOW = new Date('2026-11-12T10:00:00Z');

type FakeOptions = {
  pages?: Partial<Record<string, Page<Entity>>>;
  lookup?: () => Promise<Entity>;
  fail?: Partial<Record<string, () => Promise<never>>>;
  items?: Partial<Record<string, readonly Entity[]>>;
  tokens?: boolean;
};

function fakeClient(options: FakeOptions = {}): { client: Dv360Client; calls: Call[] } {
  const calls: Call[] = [];
  // Every client call now ends with the call options ({ signal, deadline }); record and read the arguments without them.
  const withoutCall = (args: unknown[]) => {
    const last = args.at(-1);
    return last !== null && typeof last === 'object' && 'deadline' in last ? args.slice(0, -1) : args;
  };
  const record = (method: string, args: unknown[]) => { calls.push({ method, args }); return options.fail?.[method]?.(); };
  const listing = (method: string) => async (...allArgs: unknown[]) => {
    const args = withoutCall(allArgs);
    const failing = record(method, args);
    if (failing) await failing;
    const items = options.items?.[method] ?? [];
    const listOptions = (args.at(-1) ?? {}) as { pageSize?: number; pageToken?: string };
    if (options.tokens) {
      const start = listOptions.pageToken === undefined ? 0 : Number.parseInt(listOptions.pageToken.slice(1), 10);
      const size = listOptions.pageSize ?? 100;
      const end = start + size;
      return { items: items.slice(start, end), ...(end < items.length ? { nextPageToken: `g${end}+/=` } : {}) };
    }
    return options.pages?.[method] ?? { items };
  };
  const getting = (method: string, entity: Entity) => async (...args: unknown[]) => {
    const failing = record(method, withoutCall(args));
    if (failing) await failing;
    return entity;
  };
  const client = {
    listPartners: listing('listPartners'), listAdvertisers: listing('listAdvertisers'), listCampaigns: listing('listCampaigns'),
    listInsertionOrders: listing('listInsertionOrders'), listLineItems: listing('listLineItems'),
    getPartner: getting('getPartner', partner), getCampaign: getting('getCampaign', campaign()),
    getInsertionOrder: getting('getInsertionOrder', insertionOrder()), getLineItem: getting('getLineItem', lineItem()),
    async getAdvertiser(...args: unknown[]) {
      const failing = record('getAdvertiser', withoutCall(args));
      if (failing) await failing;
      return options.lookup ? options.lookup() : advertiser();
    },
  } as unknown as Dv360Client;
  return { client, calls };
}

function service(options: FakeOptions = {}, now = NOW): { metadata: MetadataService; calls: Call[] } {
  const { client, calls } = fakeClient(options);
  return { metadata: createMetadataService({ client, now: () => now }), calls };
}

async function rejection(promise: Promise<unknown>): Promise<Dv360Error> {
  try { await promise; } catch (error) { assert.ok(error instanceof Dv360Error, String(error)); return error; }
  assert.fail('expected a rejection');
}

test('exports and status tables', () => {
  assert.deepEqual(STATUS_NAMES, ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'SCHEDULED_FOR_DELETION']);
  assert.deepEqual([DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE], [40, 40]);
  for (const resource of ['partner', 'advertiser', 'campaign', 'insertionOrder', 'lineItem'] as const) {
    assert.deepEqual(RESOURCE_STATUSES[resource].map(name => `ENTITY_STATUS_${name}`), FILTERABLE_STATUSES[resource]);
  }
  assert.ok(Object.isFrozen(RESOURCE_STATUSES));
  assert.ok(Object.isFrozen(RESOURCE_STATUSES.campaign));
});

test('partner lists exclude archived by default; the other four send no status filter', async () => {
  const { metadata, calls } = service();
  const partners = await metadata.list({ resource: 'partner' });
  assert.deepEqual(calls[0].args[0], {
    statuses: ['ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT', 'ENTITY_STATUS_SCHEDULED_FOR_DELETION'], pageSize: 40,
  });
  assert.equal(partners.statusFilter, 'default');
  await metadata.list({ resource: 'advertiser', partnerId: '1' });
  await metadata.list({ resource: 'campaign', advertiserId: '10' });
  await metadata.list({ resource: 'insertionOrder', advertiserId: '10' });
  await metadata.list({ resource: 'lineItem', advertiserId: '10' });
  for (const call of calls.filter(call => call.method.startsWith('list') && call.method !== 'listPartners')) {
    assert.deepEqual(call.args.at(-1), { pageSize: 40 }, call.method);
  }
});

test('explicit statuses map to ENTITY_STATUS_* and are reported in canonical order', async () => {
  const { metadata, calls } = service();
  const result = await metadata.list({ resource: 'lineItem', advertiserId: '10', statuses: ['ARCHIVED', 'ACTIVE', 'ARCHIVED'] });
  assert.deepEqual(calls[0].args.at(-1), { statuses: ['ENTITY_STATUS_ARCHIVED', 'ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_ARCHIVED'], pageSize: 40 });
  assert.deepEqual(result.statusFilter, ['ACTIVE', 'ARCHIVED']);
});

test('parent IDs and filters reach the client for each resource', async () => {
  const { metadata, calls } = service();
  await metadata.list({ resource: 'advertiser', partnerId: '1' });
  await metadata.list({ resource: 'insertionOrder', advertiserId: '10', campaignId: '20' });
  await metadata.list({ resource: 'lineItem', advertiserId: '10', campaignId: '20', insertionOrderId: '30', pageSize: 5 });
  const byMethod = (name: string) => calls.find(call => call.method === name)!;
  assert.deepEqual(byMethod('listAdvertisers').args, ['1', { pageSize: 40 }]);
  assert.deepEqual(byMethod('listInsertionOrders').args, ['10', { pageSize: 40, campaignId: '20' }]);
  assert.deepEqual(byMethod('listLineItems').args, ['10', { pageSize: 5, campaignId: '20', insertionOrderId: '30' }]);
});

test('pageSize accepts 1 to 40 and rejects everything else without a client call', async () => {
  const { metadata, calls } = service();
  for (const pageSize of [1, 40]) await metadata.list({ resource: 'partner', pageSize });
  const before = calls.length;
  for (const pageSize of [0, 41, 1.5, -1, Number.NaN, 100]) {
    const error = await rejection(metadata.list({ resource: 'partner', pageSize }));
    assert.equal(error.kind, 'invalid_request');
    assert.equal(error.message, 'pageSize must be an integer from 1 to 40.');
  }
  assert.equal(calls.length, before);
});

test('required and inapplicable parents are rejected with exact messages and no client call', async () => {
  const { metadata, calls } = service();
  const cases: [ListRequest, string][] = [
    [{ resource: 'advertiser' }, 'partnerId is required.'],
    [{ resource: 'campaign' }, 'advertiserId is required.'],
    [{ resource: 'insertionOrder' }, 'advertiserId is required.'],
    [{ resource: 'lineItem' }, 'advertiserId is required.'],
    [{ resource: 'campaign', advertiserId: '10', campaignId: '20' }, 'campaignId is only valid for insertion orders and line items.'],
    [{ resource: 'partner', campaignId: '20' }, 'campaignId is only valid for insertion orders and line items.'],
    [{ resource: 'insertionOrder', advertiserId: '10', insertionOrderId: '30' }, 'insertionOrderId is only valid for line items.'],
    [{ resource: 'partner', partnerId: '1' }, 'partnerId is only valid for advertisers.'],
    [{ resource: 'campaign', advertiserId: '10', partnerId: '1' }, 'partnerId is only valid for advertisers.'],
    [{ resource: 'advertiser', partnerId: '1', advertiserId: '10' }, 'advertiserId is only valid for campaigns, insertion orders, and line items.'],
  ];
  for (const [request, message] of cases) {
    const error = await rejection(metadata.list(request));
    assert.equal(error.kind, 'invalid_request');
    assert.equal(error.message, message);
  }
  assert.equal(calls.length, 0);
});

test('statuses the client rejects surface as its invalid_request error', async () => {
  const { client } = fakeClient();
  const strict: Dv360Client = { ...client, async listCampaigns() { throw new Dv360Error('invalid_request', 'ENTITY_STATUS_DRAFT is not a valid status for campaigns.'); } };
  const metadata = createMetadataService({ client: strict, now: () => NOW });
  const error = await rejection(metadata.list({ resource: 'campaign', advertiserId: '10', statuses: ['DRAFT'] }));
  assert.equal(error.message, 'ENTITY_STATUS_DRAFT is not a valid status for campaigns.');
});

const TOKEN_FORM = /^v1\.[0-9a-f]{16}\.[A-Za-z0-9_-]+$/;
const listing = (items: Entity[]) => ({ items, nextPageToken: 'g+/=token' });

test('outgoing page tokens are wrapped, and Google tokens round-trip unchanged', async () => {
  const { metadata, calls } = service({ pages: { listPartners: listing([partner]) } });
  const first = await metadata.list({ resource: 'partner' });
  assert.match(first.nextPageToken!, TOKEN_FORM);
  assert.ok(!first.nextPageToken!.includes('g+/='), 'Google token must not appear in plain text');
  await metadata.list({ resource: 'partner', pageToken: first.nextPageToken });
  assert.equal((calls[1].args[0] as { pageToken: string }).pageToken, 'g+/=token');
});

test('a token is bound to its exact request: any other argument is a mismatch, with no client call', async () => {
  const base: ListRequest = { resource: 'lineItem', advertiserId: '10', campaignId: '20', statuses: ['ACTIVE'], pageSize: 10 };
  const { metadata, calls } = service({ pages: { listLineItems: listing([lineItem()]) } });
  const token = (await metadata.list(base)).nextPageToken!;
  const before = calls.length;
  const different: ListRequest[] = [
    { ...base, statuses: ['ACTIVE', 'PAUSED'] }, { ...base, statuses: undefined }, { ...base, advertiserId: '11' },
    { ...base, campaignId: '21' }, { ...base, campaignId: undefined }, { ...base, insertionOrderId: '30' },
    { ...base, pageSize: 11 }, { ...base, pageSize: undefined },
  ];
  for (const request of different) {
    const error = await rejection(metadata.list({ ...request, pageToken: token }));
    assert.equal(error.kind, 'invalid_request');
    assert.equal(error.message, 'This pageToken belongs to a different request. Repeat exactly the arguments of the call that returned it, or start again without pageToken.');
  }
  assert.equal(calls.length, before);
});

test('statuses in another order, or duplicated, produce the same fingerprint', async () => {
  const { metadata } = service({ pages: { listLineItems: listing([lineItem()]) } });
  const first = await metadata.list({ resource: 'lineItem', advertiserId: '10', statuses: ['PAUSED', 'ACTIVE'] });
  const again = await metadata.list({ resource: 'lineItem', advertiserId: '10', statuses: ['ACTIVE', 'PAUSED', 'ACTIVE'] });
  assert.equal(first.nextPageToken, again.nextPageToken);
  await metadata.list({ resource: 'lineItem', advertiserId: '10', statuses: ['ACTIVE', 'PAUSED'], pageToken: first.nextPageToken });
});

test('malformed or oversized tokens are rejected as not valid', async () => {
  const { metadata, calls } = service({ pages: { listPartners: listing([partner]) } });
  const good = (await metadata.list({ resource: 'partner' })).nextPageToken!;
  const [version, print] = good.split('.');
  const notValid = 'pageToken is not valid. Start again without pageToken.';
  const bad = ['', 'garbage', 'g+/=token', `v2.${print}.abc`, `${version}.${print}`, `${version}.${print}.`, `${version}.XYZ.abc`,
    `${version}.${print}.${'A'.repeat(1401)}`, `${version}.${print}.ab cd`, `${version}.${print}.a=`];
  const before = calls.length;
  for (const pageToken of bad) {
    const error = await rejection(metadata.list({ resource: 'partner', pageToken }));
    assert.equal(error.message, notValid, JSON.stringify(pageToken));
  }
  // A well-formed token whose decoded Google token would exceed 1,000 characters.
  const huge = `${version}.${print}.${Buffer.from('x'.repeat(1001)).toString('base64url')}`;
  assert.equal((await rejection(metadata.list({ resource: 'partner', pageToken: huge }))).message, notValid);
  // Base64url that does not decode to valid UTF-8 round-trips differently, so it is refused too.
  const binary = `${version}.${print}.${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')}`;
  assert.equal((await rejection(metadata.list({ resource: 'partner', pageToken: binary }))).message, notValid);
  assert.equal(calls.length, before);
});

test('a Google token longer than the client allows is an unexpected response, never silently dropped', async () => {
  const { metadata } = service({ pages: { listPartners: { items: [partner], nextPageToken: 'x'.repeat(1001) } } });
  assert.equal((await rejection(metadata.list({ resource: 'partner' }))).kind, 'unexpected_response');
});

test('a non-ASCII Google token that would encode past our own limit is refused, not handed out unusable', async () => {
  const wide = service({ pages: { listPartners: { items: [partner], nextPageToken: 'é'.repeat(600) } } }).metadata;
  assert.equal((await rejection(wide.list({ resource: 'partner' }))).kind, 'unexpected_response');
  // The longest ASCII token Google may return still round-trips.
  const ascii = 'x'.repeat(1000);
  const { metadata, calls } = service({ pages: { listPartners: { items: [partner], nextPageToken: ascii } } });
  const token = (await metadata.list({ resource: 'partner' })).nextPageToken!;
  assert.ok(token.length <= 1420);
  await metadata.list({ resource: 'partner', pageToken: token });
  assert.equal((calls[1].args[0] as { pageToken: string }).pageToken, ascii);
});

test("Google's 400 on a call with a token becomes the 'no longer accepted' message; other errors are unchanged", async () => {
  const google400 = () => Promise.reject(new Dv360Error('invalid_request', 'Google rejected the request: x', { httpStatus: 400, reasons: [], legacyReasons: [] }));
  const { metadata } = service({ pages: { listPartners: listing([partner]) } });
  const token = (await metadata.list({ resource: 'partner' })).nextPageToken!;
  const failing = service({ fail: { listPartners: google400 } }).metadata;
  const stale = await rejection(failing.list({ resource: 'partner', pageToken: token }));
  assert.equal(stale.message, 'The pageToken is no longer accepted by Google. Start again without pageToken.');
  const withoutToken = await rejection(failing.list({ resource: 'partner' }));
  assert.equal(withoutToken.message, 'Google rejected the request: x');
  const local = service({ fail: { listPartners: () => Promise.reject(new Dv360Error('invalid_request', 'statuses must not be empty.')) } }).metadata;
  assert.equal((await rejection(local.list({ resource: 'partner', pageToken: token }))).message, 'statuses must not be empty.');
  const server = service({ fail: { listPartners: () => Promise.reject(new Dv360Error('server_error')) } }).metadata;
  assert.equal((await rejection(server.list({ resource: 'partner', pageToken: token }))).kind, 'server_error');
});

test('walking all pages with the service tokens returns every line item exactly once', async () => {
  const items = Array.from({ length: 120 }, (_, index) => lineItem(String(1000 + index)));
  const { metadata } = service({ items: { listLineItems: items }, tokens: true });
  const seen: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await metadata.list({ resource: 'lineItem', advertiserId: '10', pageSize: 40, ...(pageToken ? { pageToken } : {}) });
    seen.push(...page.rows.map(row => row.id));
    pageToken = page.nextPageToken;
    pages += 1;
    assert.ok(pages <= 3);
  } while (pageToken);
  assert.equal(pages, 3);
  assert.deepEqual(seen, items.map(item => item.lineItemId));
  assert.equal(new Set(seen).size, 120);
});

test('child lists look up the advertiser in parallel with the main call', async () => {
  const events: string[] = [];
  const release: (() => void)[] = [];
  const gate = (name: string) => new Promise<void>(resolve => { events.push(`${name} started`); release.push(resolve); });
  const { client } = fakeClient();
  const slow: Dv360Client = {
    ...client,
    async listCampaigns() { await gate('main'); events.push('main done'); return { items: [campaign()] } as never; },
    async getAdvertiser() { await gate('lookup'); events.push('lookup done'); return advertiser() as never; },
  };
  const metadata = createMetadataService({ client: slow, now: () => NOW });
  const pending = metadata.list({ resource: 'campaign', advertiserId: '10' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['main started', 'lookup started']);
  release.forEach(resolve => resolve());
  const result = await pending;
  assert.equal(result.currency, 'TRY');
  assert.deepEqual(result.warnings, []);
});

test('partners and advertisers make no advertiser lookup', async () => {
  const { metadata, calls } = service({ items: { listPartners: [partner], listAdvertisers: [advertiser()] } });
  await metadata.list({ resource: 'partner' });
  await metadata.list({ resource: 'advertiser', partnerId: '1' });
  await metadata.get({ resource: 'partner', id: '1' });
  assert.equal(calls.filter(call => call.method === 'getAdvertiser').length, 0);
});

test('currency comes from the advertiser, even when the partner uses another currency', async () => {
  const { metadata } = service({
    items: { listCampaigns: [campaign()] }, lookup: async () => advertiser({ generalConfig: { currencyCode: 'EUR', timeZone: 'Europe/Istanbul' } }),
  });
  const result = await metadata.list({ resource: 'campaign', advertiserId: '10' });
  assert.equal(result.currency, 'EUR');
  assert.ok(result.rows[0].line.includes('planned spend 2,500.00 EUR'), result.rows[0].line);
});

test('a failed lookup keeps the rows and labels amounts, with the exact warning', async () => {
  const lookupFailed = (error: unknown) => async () => { throw error; };
  const cases: [unknown, string][] = [
    [new Dv360Error('timeout'), 'Display & Video 360 did not respond in time. Try again shortly.'],
    [new GoogleCredentialsError('expired_or_revoked'), new GoogleCredentialsError('expired_or_revoked').message],
    [new Error('https://secret.example/path'), GENERIC],
  ];
  for (const [error, message] of cases) {
    const { metadata } = service({ items: { listCampaigns: [campaign()] }, lookup: lookupFailed(error) });
    const result = await metadata.list({ resource: 'campaign', advertiserId: '10' });
    assert.equal(result.currency, undefined);
    assert.deepEqual(result.warnings, [`The advertiser's currency could not be read (${message}); amounts are shown as "(advertiser currency)".`]);
    assert.ok(result.rows[0].line.includes('2,500.00 (advertiser currency)'), result.rows[0].line);
    assert.ok(!result.warnings.join('').includes('secret.example'));
  }
});

test('an advertiser without a valid currency code gives the no-currency warning', async () => {
  for (const generalConfig of [{ timeZone: 'UTC' }, { currencyCode: 'try', timeZone: 'UTC' }, undefined]) {
    const { metadata } = service({ items: { listLineItems: [lineItem()] }, lookup: async () => advertiser({ generalConfig }) });
    const result = await metadata.list({ resource: 'lineItem', advertiserId: '10' });
    assert.equal(result.currency, undefined);
    assert.deepEqual(result.warnings, ['The advertiser\'s currency could not be read (no currency on the advertiser); amounts are shown as "(advertiser currency)".']);
  }
});

test('when the main call fails its error is thrown, even if the lookup succeeded', async () => {
  const { metadata } = service({ fail: { listCampaigns: () => Promise.reject(new Dv360Error('not_found')) } });
  assert.equal((await rejection(metadata.list({ resource: 'campaign', advertiserId: '10' }))).kind, 'not_found');
  const get = service({ fail: { getCampaign: () => Promise.reject(new Dv360Error('access_denied')) } }).metadata;
  assert.equal((await rejection(get.get({ resource: 'campaign', id: '20', advertiserId: '10' }))).kind, 'access_denied');
});

test('rows are finished lines built by the formatter', async () => {
  const { metadata } = service({
    items: { listPartners: [partner], listAdvertisers: [advertiser()], listCampaigns: [campaign()], listInsertionOrders: [insertionOrder()], listLineItems: [lineItem()] },
  });
  const rows = {
    partner: (await metadata.list({ resource: 'partner' })).rows[0],
    advertiser: (await metadata.list({ resource: 'advertiser', partnerId: '1' })).rows[0],
    campaign: (await metadata.list({ resource: 'campaign', advertiserId: '10' })).rows[0],
    insertionOrder: (await metadata.list({ resource: 'insertionOrder', advertiserId: '10' })).rows[0],
    lineItem: (await metadata.list({ resource: 'lineItem', advertiserId: '10' })).rows[0],
  };
  assert.deepEqual(rows.partner, { id: '1', line: '- 1 · Partner A · ACTIVE · currency USD' });
  assert.deepEqual(rows.advertiser, { id: '10', line: '- 10 · Advertiser A · ACTIVE · currency TRY · time zone Europe/Istanbul' });
  assert.equal(rows.campaign.line, '- 20 · Campaign 20 · ACTIVE · goal BRAND_AWARENESS · planned 2026-03-01–2026-03-31 · planned spend 2,500.00 TRY (does not cap spend) · budget unlimited');
  assert.equal(rows.insertionOrder.line, '- 30 · IO 30 · ACTIVE · campaign 20 · budget in currency, manual · segment current 2026-11-01–2026-11-30 15.80 TRY · pacing flight ahead');
  assert.equal(rows.lineItem.line, '- 40 · Line item 40 · ACTIVE · IO 30 · DISPLAY_DEFAULT · flight inherited 2026-01-01–2026-12-31 · budget fixed 15.80 TRY · bid fixed 2.50 TRY');
});

test('a row longer than the bound is an unexpected_response, never a partial or cut page', async () => {
  const oversized = { ...lineItem(), lineItemId: '7'.repeat(MAX_ROW_CHARS) };
  const { metadata } = service({ items: { listLineItems: [lineItem('1'), oversized] } });
  const error = await rejection(metadata.list({ resource: 'lineItem', advertiserId: '10' }));
  assert.equal(error.kind, 'unexpected_response');
  assert.equal(error.message, "A metadata row was longer than expected. Report this to the server's maintainer.");
});

const twoSegments = [segment([2026, 11, 12], [2026, 11, 12], '111000000'), segment([2026, 11, 13], [2026, 11, 30], '222000000')];

test('the current budget segment uses the advertiser-local date (positive offset)', async () => {
  const late = new Date('2026-11-12T22:00:00Z');   // already 2026-11-13 in Istanbul (UTC+3)
  const { metadata } = service({ items: { listInsertionOrders: [insertionOrder(twoSegments)] } }, late);
  const result = await metadata.list({ resource: 'insertionOrder', advertiserId: '10' });
  assert.ok(result.rows[0].line.includes('segments 2, segment current 2026-11-13–2026-11-30 222.00 TRY'), result.rows[0].line);
  assert.deepEqual(result.warnings, []);
});

test('the current budget segment uses the advertiser-local date (negative offset)', async () => {
  const early = new Date('2026-11-13T03:00:00Z');   // still 2026-11-12 in Los Angeles (UTC−8)
  const { metadata } = service({
    items: { listInsertionOrders: [insertionOrder(twoSegments)] },
    lookup: async () => advertiser({ generalConfig: { currencyCode: 'USD', timeZone: 'America/Los_Angeles' } }),
  }, early);
  const result = await metadata.list({ resource: 'insertionOrder', advertiserId: '10' });
  assert.ok(result.rows[0].line.includes('segments 2, segment current 2026-11-12–2026-11-12 111.00 USD'), result.rows[0].line);
});

test('a missing or invalid time zone, or a failed lookup, falls back to UTC with a warning on insertion orders only', async () => {
  const utcWarning = "The advertiser's time zone could not be read; current and next budget segments are chosen by the UTC date.";
  const late = new Date('2026-11-12T22:00:00Z');
  for (const generalConfig of [{ currencyCode: 'TRY' }, { currencyCode: 'TRY', timeZone: 'Mars/Base' }, { currencyCode: 'TRY', timeZone: '' }]) {
    const { metadata } = service({ items: { listInsertionOrders: [insertionOrder(twoSegments)], listCampaigns: [campaign()] }, lookup: async () => advertiser({ generalConfig }) }, late);
    const io = await metadata.list({ resource: 'insertionOrder', advertiserId: '10' });
    assert.ok(io.rows[0].line.includes('segment current 2026-11-12–2026-11-12'), io.rows[0].line);
    assert.deepEqual(io.warnings, [utcWarning]);
    assert.deepEqual((await metadata.list({ resource: 'campaign', advertiserId: '10' })).warnings, []);
  }
  const failed = service({ items: { listInsertionOrders: [insertionOrder(twoSegments)] }, lookup: async () => { throw new Dv360Error('network'); } }, late).metadata;
  const result = await failed.list({ resource: 'insertionOrder', advertiserId: '10' });
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings[0].startsWith("The advertiser's currency could not be read ("));
  assert.equal(result.warnings[1], utcWarning);
});

test('get passes IDs through, adds the advertiser lookup for children only, and requires advertiserId for them', async () => {
  const { metadata, calls } = service();
  await metadata.get({ resource: 'partner', id: '1' });
  await metadata.get({ resource: 'advertiser', id: '10' });
  assert.deepEqual(calls.map(call => call.method), ['getPartner', 'getAdvertiser']);
  calls.length = 0;
  await metadata.get({ resource: 'lineItem', id: '40', advertiserId: '10' });
  await metadata.get({ resource: 'campaign', id: '20', advertiserId: '10' });
  await metadata.get({ resource: 'insertionOrder', id: '30', advertiserId: '10' });
  assert.deepEqual(calls.filter(call => call.method !== 'getAdvertiser').map(call => [call.method, call.args]),
    [['getLineItem', ['10', '40']], ['getCampaign', ['10', '20']], ['getInsertionOrder', ['10', '30']]]);
  assert.equal(calls.filter(call => call.method === 'getAdvertiser').length, 3);
  assert.equal((await rejection(metadata.get({ resource: 'campaign', id: '20' }))).message, 'advertiserId is required.');
  assert.equal((await rejection(metadata.get({ resource: 'partner', id: '1', advertiserId: '10' }))).message,
    'advertiserId is only valid for campaigns, insertion orders, and line items.');
});

test('get returns the summary, the full record without its resource path, and no segments for non-insertion orders', async () => {
  const { metadata } = service();
  const result = await metadata.get({ resource: 'lineItem', id: '40', advertiserId: '10' });
  assert.equal(result.id, '40');
  assert.equal(result.name, 'Line item 40');
  assert.equal(result.status, 'ACTIVE');
  assert.deepEqual(result.summary, ['IO 30', 'DISPLAY_DEFAULT', 'flight inherited 2026-01-01–2026-12-31', 'budget fixed 15.80 TRY', 'bid fixed 2.50 TRY']);
  assert.equal(result.segments, undefined);
  assert.equal(result.detailsOmitted, undefined);
  const details = JSON.parse(result.details) as Entity;
  assert.equal(details.lineItemId, '40');
  assert.equal('name' in details, false);
  const withPath = createMetadataService({
    client: { ...fakeClient().client, async getPartner() { return { ...partner, name: 'partners/1' } as never; } }, now: () => NOW });
  assert.equal('name' in JSON.parse((await withPath.get({ resource: 'partner', id: '1' })).details), false);
});

test('get lists every insertion order segment in date order and marks the chosen one', async () => {
  const shuffled = [segment([2026, 12, 1], [2026, 12, 31], '3000000'), segment([2026, 11, 1], [2026, 11, 30], '2000000'), segment([2026, 8, 1], [2026, 8, 31], '1000000'), { budgetAmountMicros: '9' }];
  const { client } = fakeClient();
  const metadata = createMetadataService({ client: { ...client, async getInsertionOrder() { return insertionOrder(shuffled) as never; } }, now: () => NOW });
  const result = await metadata.get({ resource: 'insertionOrder', id: '30', advertiserId: '10' });
  assert.deepEqual(result.segments, [
    '2026-08-01–2026-08-31 1.00 TRY', 'current: 2026-11-01–2026-11-30 2.00 TRY', '2026-12-01–2026-12-31 3.00 TRY', '? 0.00 TRY',
  ]);
});

test('get shows impression segments as plain counts and caps the segment lines at 20', async () => {
  const many = Array.from({ length: 25 }, (_, index) => segment([2020 + Math.floor(index / 12), (index % 12) + 1, 1], [2020 + Math.floor(index / 12), (index % 12) + 1, 28], '15800000'));
  const io = insertionOrder(many);
  (io.budget as Entity).budgetUnit = 'BUDGET_UNIT_IMPRESSIONS';
  const { client } = fakeClient();
  const metadata = createMetadataService({ client: { ...client, async getInsertionOrder() { return io as never; } }, now: () => NOW });
  const result = await metadata.get({ resource: 'insertionOrder', id: '30', advertiserId: '10' });
  assert.equal(result.segments!.length, 21);
  assert.ok(result.segments![0].endsWith('15,800,000 impressions'));
  assert.equal(result.segments![20], '… 5 more segments in the details below');
  const empty = createMetadataService({ client: { ...client, async getInsertionOrder() { return insertionOrder([]) as never; } }, now: () => NOW });
  assert.equal((await empty.get({ resource: 'insertionOrder', id: '30', advertiserId: '10' })).segments, undefined);
});

test('get omits details larger than 12,000 characters instead of cutting them', async () => {
  const { client } = fakeClient();
  const big = { ...lineItem(), notes: 'x'.repeat(12_000) };
  const metadata = createMetadataService({ client: { ...client, async getLineItem() { return big as never; } }, now: () => NOW });
  const result = await metadata.get({ resource: 'lineItem', id: '40', advertiserId: '10' });
  assert.equal(result.details, '');
  assert.ok(result.detailsOmitted! > 12_000);
  const exact = JSON.stringify({ ...lineItem(), notes: '' }).length;
  const sized = { ...lineItem(), notes: 'y'.repeat(12_000 - exact) };
  const fits = createMetadataService({ client: { ...client, async getLineItem() { return sized as never; } }, now: () => NOW });
  const kept = await fits.get({ resource: 'lineItem', id: '40', advertiserId: '10' });
  assert.equal(kept.details.length, 12_000);
  assert.equal(kept.detailsOmitted, undefined);
});

test('get names are shown up to 200 characters', async () => {
  const { client } = fakeClient();
  const metadata = createMetadataService({ client: { ...client, async getPartner() { return { ...partner, displayName: 'P'.repeat(300) } as never; } }, now: () => NOW });
  const result = await metadata.get({ resource: 'partner', id: '1' });
  assert.equal(result.name, `${'P'.repeat(199)}…`);
});

test('safeErrorMessage passes known messages and hides everything else', () => {
  assert.equal(safeErrorMessage(new Dv360Error('not_found')), 'Not found, or not visible to the Google account this server uses.');
  assert.equal(safeErrorMessage(new GoogleCredentialsError('not_found')), new GoogleCredentialsError('not_found').message);
  assert.equal(safeErrorMessage(new Error('https://storage.googleapis.com/secret')), GENERIC);
  assert.equal(safeErrorMessage('plain string'), GENERIC);
  assert.equal(safeErrorMessage(undefined), GENERIC);
});

// --- Step 2: every client call carries { signal, deadline: start + 45 s } ---

function recordingService() {
  const { client } = fakeClient();
  const raw: [string, unknown][] = [];
  const wrapped = Object.fromEntries(Object.entries(client).map(([name, method]) => [name,
    (...args: unknown[]) => { raw.push([name, args.at(-1)]); return (method as (...a: unknown[]) => unknown)(...args); }])) as unknown as Dv360Client;
  return { metadata: createMetadataService({ client: wrapped, now: () => NOW }), raw };
}

test('list passes { signal, deadline } to the list call and the advertiser lookup', async () => {
  const signal = new AbortController().signal;
  const expected = { signal, deadline: NOW.getTime() + 45_000 };
  for (const request of [
    { resource: 'partner', signal }, { resource: 'advertiser', partnerId: '1', signal },
    { resource: 'campaign', advertiserId: '10', signal }, { resource: 'insertionOrder', advertiserId: '10', campaignId: '20', signal },
    { resource: 'lineItem', advertiserId: '10', signal },
  ] as const) {
    const { metadata, raw } = recordingService();
    await metadata.list(request);
    assert.equal(raw.length, request.resource === 'partner' || request.resource === 'advertiser' ? 1 : 2);
    for (const [name, call] of raw) assert.deepEqual(call, expected, name);
  }
});

test('get passes { signal, deadline } to the get call and the advertiser lookup', async () => {
  const signal = new AbortController().signal;
  const expected = { signal, deadline: NOW.getTime() + 45_000 };
  for (const request of [
    { resource: 'partner', id: '1', signal }, { resource: 'advertiser', id: '10', signal },
    { resource: 'campaign', id: '20', advertiserId: '10', signal },
    { resource: 'insertionOrder', id: '30', advertiserId: '10', signal }, { resource: 'lineItem', id: '40', advertiserId: '10', signal },
  ] as const) {
    const { metadata, raw } = recordingService();
    await metadata.get(request);
    assert.equal(raw.length, request.resource === 'partner' || request.resource === 'advertiser' ? 1 : 2);
    for (const [name, call] of raw) assert.deepEqual(call, expected, name);
  }
});

// M5 step 3: record the raw call options without changing the older fixture.
test('callId reaches list/get and their parallel advertiser lookups', async () => {
  const { client } = fakeClient();
  const options: unknown[] = [];
  const list = client.listLineItems;
  const get = client.getLineItem;
  const lookup = client.getAdvertiser;
  const metadata = createMetadataService({ now: () => NOW, client: {
    ...client,
    listLineItems: async (id, args, call) => { options.push(call); return list(id, args, call); },
    getLineItem: async (id, itemId, call) => { options.push(call); return get(id, itemId, call); },
    getAdvertiser: async (id, call) => { options.push(call); return lookup(id, call); },
  } });
  const signal = new AbortController().signal;
  const callId = '0123456789abcdef';
  await metadata.list({ resource: 'lineItem', advertiserId: '10', signal, callId });
  await metadata.get({ resource: 'lineItem', advertiserId: '10', id: '40', signal, callId });
  assert.deepEqual(options, Array.from({ length: 4 }, () => ({ signal, deadline: NOW.getTime() + 45_000, callId })));
});

test('page-token fingerprints exclude callId and accept a continuation from another call', async () => {
  const { metadata, calls } = service({ pages: { listLineItems: { items: [lineItem()], nextPageToken: 'private-google-token' } } });
  const args = { resource: 'lineItem' as const, advertiserId: '10' };
  const first = await metadata.list({ ...args, callId: '1111111111111111' });
  const other = await metadata.list({ ...args, callId: '2222222222222222' });
  assert.equal(first.nextPageToken, other.nextPageToken);
  assert.ok(first.nextPageToken);
  await metadata.list({ ...args, callId: '3333333333333333', pageToken: first.nextPageToken });
  assert.deepEqual(calls.filter(call => call.method === 'listLineItems').at(-1)?.args,
    ['10', { pageSize: DEFAULT_PAGE_SIZE, pageToken: 'private-google-token' }]);
});

// ---------------------------------------------------------------------------------------------
// find() (M6 step 1)

type ListMethod = 'listPartners' | 'listAdvertisers' | 'listCampaigns' | 'listInsertionOrders' | 'listLineItems';
type FindCall = { readonly method: ListMethod; readonly args: readonly unknown[]; readonly call: CallOptions };
type Handler = (...args: unknown[]) => Promise<Page<Entity>>;

let clock = NOW.getTime();
const findNow = () => new Date(clock);

function findSetup(handlers: Partial<Record<ListMethod, Handler>>) {
  clock = NOW.getTime();
  const calls: FindCall[] = [];
  const method = (name: ListMethod) => async (...allArgs: unknown[]) => {
    const call = allArgs.at(-1) as CallOptions;
    const args = allArgs.slice(0, -1);
    calls.push({ method: name, args, call });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected ${name}`);
    return handler(...args);
  };
  const unexpected = async () => { throw new Error('unexpected get'); };
  const client = {
    listPartners: method('listPartners'), listAdvertisers: method('listAdvertisers'), listCampaigns: method('listCampaigns'),
    listInsertionOrders: method('listInsertionOrders'), listLineItems: method('listLineItems'),
    getPartner: unexpected, getAdvertiser: unexpected, getCampaign: unexpected, getInsertionOrder: unexpected, getLineItem: unexpected,
  } as unknown as Dv360Client;
  const service = createMetadataService({ client, now: findNow });
  const count = (name: ListMethod, partnerId?: string) =>
    calls.filter(call => call.method === name && (partnerId === undefined || call.args[0] === partnerId)).length;
  return { service, calls, count };
}

// Serves items in pages of the requested size; the token is the next offset.
function paged(items: readonly Entity[]): (options: unknown) => Promise<Page<Entity>> {
  return async options => {
    const { pageSize = 100, pageToken } = (options ?? {}) as { pageSize?: number; pageToken?: string };
    const start = pageToken === undefined ? 0 : Number(pageToken);
    const end = start + pageSize;
    return { items: items.slice(start, end), ...(end < items.length ? { nextPageToken: String(end) } : {}) };
  };
}
const lastOptions = (args: readonly unknown[]) => args.at(-1) as Record<string, unknown>;
const tick = () => new Promise(resolve => setImmediate(resolve));

const partnerEntity = (id: string, name = `Partner ${id}`, status = 'ENTITY_STATUS_ACTIVE'): Entity =>
  ({ partnerId: id, displayName: name, entityStatus: status });
const advertiserEntity = (id: string, partnerId: string, name: string, status = 'ENTITY_STATUS_ACTIVE'): Entity =>
  ({ advertiserId: id, partnerId, displayName: name, entityStatus: status });
const campaignEntity = (id: string, name: string): Entity =>
  ({ campaignId: id, advertiserId: '10', displayName: name, entityStatus: 'ENTITY_STATUS_ACTIVE' });

function directoryHandler(byPartner: Record<string, readonly Entity[]>): Handler {
  return async (partnerId, options) => paged(byPartner[partnerId as string] ?? [])(options);
}

const PARENT_MESSAGE = "advertiserId is required to search campaigns, insertion orders, and line items. If you know only the advertiser's name, find it first with type advertiser.";
const SERVER_ERROR_TEXT = 'Display & Video 360 had a temporary problem. Try again shortly.';
const isInvalid = (message: string) => (error: unknown) =>
  error instanceof Dv360Error && error.kind === 'invalid_request' && error.message === message;

test('find validates the name, parents, refresh and statuses before any Google call', async () => {
  const { service, calls } = findSetup({});
  const cases: [FindRequest, string][] = [
    [{ resource: 'partner', name: '   ' }, 'name must not be empty.'],
    [{ resource: 'partner', name: '' }, 'name must not be empty.'],
    [{ resource: 'partner', name: 'a'.repeat(201) }, 'name must be at most 200 characters.'],
    [{ resource: 'campaign', name: 'x' }, PARENT_MESSAGE],
    [{ resource: 'insertionOrder', name: 'x' }, PARENT_MESSAGE],
    [{ resource: 'lineItem', name: 'x' }, PARENT_MESSAGE],
    [{ resource: 'campaign', name: 'x', advertiserId: '10', partnerId: '1' }, 'partnerId is only valid for advertisers.'],
    [{ resource: 'partner', name: 'x', advertiserId: '10' }, 'advertiserId is only valid for campaigns, insertion orders, and line items.'],
    [{ resource: 'advertiser', name: 'x', advertiserId: '10' }, 'advertiserId is only valid for campaigns, insertion orders, and line items.'],
    [{ resource: 'campaign', name: 'x', advertiserId: '10', campaignId: '20' }, 'campaignId is only valid for insertion orders and line items.'],
    [{ resource: 'insertionOrder', name: 'x', advertiserId: '10', insertionOrderId: '30' }, 'insertionOrderId is only valid for line items.'],
    [{ resource: 'campaign', name: 'x', advertiserId: '10', refresh: 'no_exact' }, 'refresh is only valid for advertisers.'],
    [{ resource: 'advertiser', name: 'x', statuses: ['DRAFT'] }, 'ENTITY_STATUS_DRAFT is not a valid status for advertisers.'],
    [{ resource: 'advertiser', name: 'x', partnerId: '1', statuses: ['ARCHIVED'] }, 'ENTITY_STATUS_ARCHIVED is not a valid status for advertisers.'],
    [{ resource: 'campaign', name: 'x', advertiserId: '10', statuses: ['DRAFT'] }, 'ENTITY_STATUS_DRAFT is not a valid status for campaigns.'],
    [{ resource: 'insertionOrder', name: 'x', advertiserId: '10', statuses: ['SCHEDULED_FOR_DELETION'] }, 'ENTITY_STATUS_SCHEDULED_FOR_DELETION is not a valid status for insertion orders.'],
    [{ resource: 'lineItem', name: 'x', advertiserId: '10', statuses: ['SCHEDULED_FOR_DELETION'] }, 'ENTITY_STATUS_SCHEDULED_FOR_DELETION is not a valid status for line items.'],
    [{ resource: 'partner', name: 'x', statuses: [] }, 'statuses must not be empty.'],
    [{ resource: 'advertiser', name: 'x', statuses: ['nope' as StatusName] }, 'That value is not a valid status for advertisers.'],
  ];
  for (const [request, message] of cases) {
    await assert.rejects(service.find(request), isInvalid(message), message);
  }
  assert.equal(calls.length, 0);
});

test('find partners pages with the partner default statuses, ranks matches, and reports counts', async () => {
  const partners = [partnerEntity('3', 'Beta Acme'), partnerEntity('2', 'ACME'), partnerEntity('1', 'Acme Spring'), partnerEntity('4', 'Zeta')];
  const { service, calls } = findSetup({ listPartners: async options => paged(partners)(options) });
  const result = await service.find({ resource: 'partner', name: '  acme ' });
  assert.deepEqual(lastOptions(calls[0].args), {
    statuses: FILTERABLE_STATUSES.partner.filter(status => status !== 'ENTITY_STATUS_ARCHIVED'), pageSize: 200,
  });
  assert.deepEqual(result.matches.map(match => [match.id, match.kind]), [['2', 'exact'], ['1', 'prefix'], ['3', 'contains']]);
  assert.deepEqual(result.matches[0], { id: '2', name: 'ACME', status: 'ACTIVE', kind: 'exact' });
  assert.equal(result.query, 'acme');
  assert.equal(result.totalMatches, 3);
  assert.equal(result.exactMatches, 1);
  assert.equal(result.searched, 4);
  assert.equal(result.complete, true);
  assert.equal(result.statusFilter, 'default');
  assert.equal(result.partnersSearched, undefined);
  assert.deepEqual([result.notes, result.warnings], [[], []]);

  const withStatuses = await service.find({ resource: 'partner', name: 'acme', statuses: ['ARCHIVED', 'ACTIVE', 'ACTIVE'] });
  assert.deepEqual(lastOptions(calls[1].args).statuses, ['ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_ARCHIVED']);
  assert.deepEqual(withStatuses.statusFilter, ['ACTIVE', 'ARCHIVED']);
});

test('find campaigns sends no status filter by default, keeps the advertiser on matches, and cuts at MAX_MATCHES', async () => {
  const campaigns = [
    ...Array.from({ length: 22 }, (_, index) => campaignEntity(String(100 + index), `Spring sale ${index}`)),
    campaignEntity('9', 'Spring'), campaignEntity('10', 'spring'), campaignEntity('11', 'SPRING'), campaignEntity('12', 'Winter'),
  ];
  const { service, calls } = findSetup({ listCampaigns: async (_advertiserId, options) => paged(campaigns)(options) });
  const result = await service.find({ resource: 'campaign', name: 'Spring', advertiserId: '10' });
  assert.equal(calls[0].args[0], '10');
  assert.deepEqual(lastOptions(calls[0].args), { pageSize: 200 });
  assert.equal(result.matches.length, MAX_MATCHES);
  assert.equal(result.totalMatches, 25);
  assert.equal(result.exactMatches, 3);
  assert.equal(result.searched, 26);
  assert.deepEqual(result.matches.slice(0, 3).map(match => match.id), ['9', '10', '11']);
  assert.deepEqual(result.matches[0], { id: '9', name: 'Spring', status: 'ACTIVE', kind: 'exact', advertiserId: '10' });

  await service.find({ resource: 'campaign', name: 'x', advertiserId: '10', statuses: ['PAUSED', 'ACTIVE'] });
  assert.deepEqual(lastOptions(calls[1].args).statuses, ['ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED']);
});

test('find insertion orders and line items narrow by parents, use their page sizes, and keep parent IDs', async () => {
  const io = { insertionOrderId: '30', advertiserId: '10', campaignId: '20', displayName: 'Q4 video', entityStatus: 'ENTITY_STATUS_DRAFT' };
  const li = { lineItemId: '40', advertiserId: '10', campaignId: '20', insertionOrderId: '30', displayName: 'Video LI', entityStatus: 'ENTITY_STATUS_PAUSED' };
  const { service, calls } = findSetup({
    listInsertionOrders: async (_id, options) => paged([io])(options),
    listLineItems: async (_id, options) => paged([li])(options),
  });
  const ios = await service.find({ resource: 'insertionOrder', name: 'video', advertiserId: '10', campaignId: '20' });
  assert.deepEqual(lastOptions(calls[0].args), { pageSize: 100, campaignId: '20' });
  assert.deepEqual(ios.matches, [{ id: '30', name: 'Q4 video', status: 'DRAFT', kind: 'contains', advertiserId: '10', campaignId: '20' }]);
  const lis = await service.find({ resource: 'lineItem', name: 'video', advertiserId: '10', campaignId: '20', insertionOrderId: '30' });
  assert.deepEqual(lastOptions(calls[1].args), { pageSize: 200, campaignId: '20', insertionOrderId: '30' });
  assert.deepEqual(lis.matches, [{
    id: '40', name: 'Video LI', status: 'PAUSED', kind: 'prefix', advertiserId: '10', campaignId: '20', insertionOrderId: '30',
  }]);
});

test('find follows page tokens and stops at MAX_FIND_PAGES with one warning', async () => {
  const many = Array.from({ length: 450 }, (_, index) => campaignEntity(String(index + 1), `C ${index}`));
  const { service, count } = findSetup({ listCampaigns: async (_id, options) => paged(many)(options) });
  const result = await service.find({ resource: 'campaign', name: 'c', advertiserId: '10' });
  assert.equal(count('listCampaigns'), 3);
  assert.equal(result.searched, 450);
  assert.equal(result.complete, true);

  const huge = Array.from({ length: 1_200 }, (_, index) => campaignEntity(String(index + 1), `C ${index}`));
  const capped = findSetup({ listCampaigns: async (_id, options) => paged(huge)(options) });
  const cut = await capped.service.find({ resource: 'campaign', name: 'c', advertiserId: '10' });
  assert.equal(capped.count('listCampaigns'), MAX_FIND_PAGES);
  assert.equal(cut.searched, 1_000);
  assert.equal(cut.complete, false);
  assert.deepEqual(cut.warnings, ['The search stopped before the end of the list (too many entries); results may be missing. Narrow it with a more specific name.']);

  const ios = Array.from({ length: 600 }, (_, index) => ({ ...insertionOrder(), insertionOrderId: String(index + 1), displayName: `IO ${index}` }));
  const ioSetup = findSetup({ listInsertionOrders: async (_id, options) => paged(ios)(options) });
  const ioResult = await ioSetup.service.find({ resource: 'insertionOrder', name: 'io', advertiserId: '10' });
  assert.equal(ioSetup.count('listInsertionOrders'), MAX_FIND_PAGES);
  assert.ok(ioSetup.calls.every(call => lastOptions(call.args).pageSize === 100));
  assert.deepEqual(ioResult.warnings, ['The search stopped before the end of the list (too many entries); results may be missing. Narrow it with campaignId.']);

  const lineItems = Array.from({ length: 1_100 }, (_, index) => ({ ...lineItem(String(index + 1)) }));
  const liSetup = findSetup({ listLineItems: async (_id, options) => paged(lineItems)(options) });
  const liResult = await liSetup.service.find({ resource: 'lineItem', name: 'line', advertiserId: '10' });
  assert.deepEqual(liResult.warnings, ['The search stopped before the end of the list (too many entries); results may be missing. Narrow it with campaignId or insertionOrderId.']);
});

test('find starts no page request after the scan budget, and counts pages already read', async () => {
  const many = Array.from({ length: 450 }, (_, index) => campaignEntity(String(index + 1), `C ${index}`));
  const { service, count } = findSetup({
    listCampaigns: async (_id, options) => { const page = await paged(many)(options); clock += SCAN_BUDGET_MS + 1; return page; },
  });
  const result = await service.find({ resource: 'campaign', name: 'c', advertiserId: '10' });
  assert.equal(count('listCampaigns'), 1);
  assert.equal(result.searched, 200);
  assert.equal(result.totalMatches, 200);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ['The search stopped before the end of the list (time limit); results may be missing. Narrow it with a more specific name.']);
});

test('find advertisers lists partners once with page size 200, loads directories unfiltered, and filters statuses locally', async () => {
  const directory = {
    1: [advertiserEntity('11', '1', 'Acme', 'ENTITY_STATUS_ACTIVE'), advertiserEntity('12', '1', 'Acme Paused', 'ENTITY_STATUS_PAUSED')],
    2: [advertiserEntity('21', '2', 'Old Acme', 'ENTITY_STATUS_SCHEDULED_FOR_DELETION'), advertiserEntity('22', '2', 'Other', 'ENTITY_STATUS_PAUSED')],
  };
  const { service, calls, count } = findSetup({
    listPartners: async () => ({ items: [partnerEntity('1'), partnerEntity('2')] }),
    listAdvertisers: directoryHandler(directory),
  });
  const result = await service.find({ resource: 'advertiser', name: 'acme' });
  assert.deepEqual(lastOptions(calls[0].args), {
    statuses: FILTERABLE_STATUSES.partner.filter(status => status !== 'ENTITY_STATUS_ARCHIVED'), pageSize: 200,
  });
  assert.deepEqual(calls.filter(call => call.method === 'listAdvertisers').map(call => lastOptions(call.args)), [{ pageSize: 200 }, { pageSize: 200 }]);
  assert.deepEqual(result.matches.map(match => [match.id, match.kind, match.partnerId]), [['11', 'exact', '1'], ['12', 'prefix', '1'], ['21', 'contains', '2']]);
  assert.equal(result.searched, 4);
  assert.deepEqual([result.partnersSearched, result.partnersDenied, result.partnersFailed, result.partnersNotStarted], [2, 0, 0, 0]);
  assert.equal(result.complete, true);
  assert.equal(result.statusFilter, 'default');

  // Local filtering of the cached directories gives what Google's filter would: no new request.
  const paused = await service.find({ resource: 'advertiser', name: 'acme', statuses: ['PAUSED'] });
  const expected = Object.values(directory).flat()
    .filter(entity => entity.entityStatus === 'ENTITY_STATUS_PAUSED' && String(entity.displayName).toLowerCase().includes('acme'))
    .map(entity => entity.advertiserId);
  assert.deepEqual(paused.matches.map(match => match.id), expected);
  assert.equal(paused.searched, 2);
  assert.deepEqual(paused.statusFilter, ['PAUSED']);
  assert.equal(count('listAdvertisers'), 2);
  assert.equal(count('listPartners'), 2);
});

test('find advertisers under one partnerId skips the partner list', async () => {
  const { service, count } = findSetup({ listAdvertisers: directoryHandler({ 7: [advertiserEntity('71', '7', 'Acme')] }) });
  const result = await service.find({ resource: 'advertiser', name: 'acme', partnerId: '7' });
  assert.equal(count('listPartners'), 0);
  assert.equal(count('listAdvertisers', '7'), 1);
  assert.equal(result.partnersSearched, 1);
  assert.deepEqual(result.matches.map(match => match.id), ['71']);
});

test('find loads at most three partner directories at once', async () => {
  let inFlight = 0;
  let peak = 0;
  const { service, count } = findSetup({
    listPartners: async () => ({ items: Array.from({ length: 8 }, (_, index) => partnerEntity(String(index + 1))) }),
    listAdvertisers: async () => { inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--; return { items: [] }; },
  });
  await service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(count('listAdvertisers'), 8);
  assert.equal(peak, MAX_PARTNER_SCANS);
});

test('find searches only the first 50 partners when the account sees more', async () => {
  const partners = Array.from({ length: 51 }, (_, index) => partnerEntity(String(index + 1)));
  const { service, count } = findSetup({ listPartners: async () => ({ items: partners }), listAdvertisers: async () => ({ items: [] }) });
  const result = await service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(count('listPartners'), 1);
  assert.equal(count('listAdvertisers'), MAX_PARTNERS);
  assert.equal(count('listAdvertisers', '51'), 0);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ['The account sees more than 50 partners; only the first 50 were searched. Give partnerId to search one partner.']);

  const tokened = findSetup({ listPartners: async () => ({ items: [partnerEntity('1')], nextPageToken: 't' }), listAdvertisers: async () => ({ items: [] }) });
  const second = await tokened.service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(tokened.count('listPartners'), 1);
  assert.equal(second.complete, false);
  assert.equal(second.warnings.length, 1);
});

test('find leaves partners unstarted after the scan budget, and a repeat continues with only those', async () => {
  let slow = true;
  const { service, count } = findSetup({
    listPartners: async () => ({ items: Array.from({ length: 5 }, (_, index) => partnerEntity(String(index + 1))) }),
    listAdvertisers: async partnerId => {
      await tick();
      if (slow) clock = NOW.getTime() + SCAN_BUDGET_MS + 1;
      return { items: [advertiserEntity(`${partnerId as string}0`, partnerId as string, 'Acme')] };
    },
  });
  const first = await service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(count('listAdvertisers'), 3);
  assert.deepEqual([first.partnersSearched, first.partnersNotStarted, first.partnersFailed], [3, 2, 0]);
  assert.equal(first.complete, false);
  assert.deepEqual(first.warnings, ['2 of 5 partners were not searched (time limit); repeat the search to continue, or give partnerId.']);
  assert.equal(first.totalMatches, 3);

  slow = false;
  const second = await service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(count('listAdvertisers'), 5);
  assert.equal(count('listAdvertisers', '4'), 1);
  assert.equal(count('listAdvertisers', '5'), 1);
  assert.equal(second.complete, true);
  assert.equal(second.totalMatches, 5);
});

test('find reports failed partners with the earliest partner error, and rethrows it when all fail', async () => {
  const slowError = new Dv360Error('server_error');
  const fastError = new Dv360Error('rate_limited');
  const handlers = (third: boolean): Partial<Record<ListMethod, Handler>> => ({
    listPartners: async () => ({ items: [partnerEntity('1'), partnerEntity('2'), ...(third ? [partnerEntity('3')] : [])] }),
    listAdvertisers: async partnerId => {
      if (partnerId === '1') { await tick(); await tick(); throw slowError; }
      if (partnerId === '2') throw fastError;
      return { items: [advertiserEntity('31', '3', 'Acme')] };
    },
  });
  const { service } = findSetup(handlers(true));
  const result = await service.find({ resource: 'advertiser', name: 'acme' });
  assert.deepEqual([result.partnersSearched, result.partnersFailed], [1, 2]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, [`2 of 3 partners could not be searched (${SERVER_ERROR_TEXT}); results may be missing.`]);
  assert.deepEqual(result.matches.map(match => match.id), ['31']);

  const allFail = findSetup(handlers(false));
  await assert.rejects(allFail.service.find({ resource: 'advertiser', name: 'acme' }), error => error === slowError);
});

test('find treats denied partners as skipped: cached, a note, and still complete', async () => {
  const { service, count } = findSetup({
    listPartners: async () => ({ items: [partnerEntity('1'), partnerEntity('2')] }),
    listAdvertisers: async () => { throw new Dv360Error('access_denied'); },
  });
  const result = await service.find({ resource: 'advertiser', name: 'acme' });
  assert.deepEqual([result.totalMatches, result.partnersSearched, result.partnersDenied, result.partnersFailed], [0, 0, 2, 0]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.notes, ["2 of 2 partners don't give this account access to their advertisers; they were skipped."]);
  assert.deepEqual(result.warnings, []);

  await service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(count('listAdvertisers'), 2);
  clock += DIRECTORY_TTL_MS;
  await service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(count('listAdvertisers'), 4);
});

test('find gives denied and failed partners separate lines', async () => {
  const { service } = findSetup({
    listPartners: async () => ({ items: [partnerEntity('1'), partnerEntity('2'), partnerEntity('3')] }),
    listAdvertisers: async partnerId => {
      if (partnerId === '1') throw new Dv360Error('access_denied');
      if (partnerId === '2') throw new Dv360Error('server_error');
      return { items: [] };
    },
  });
  const result = await service.find({ resource: 'advertiser', name: 'acme' });
  assert.deepEqual(result.notes, ["1 of 3 partners don't give this account access to their advertisers; they were skipped."]);
  assert.deepEqual(result.warnings, [`1 of 3 partners could not be searched (${SERVER_ERROR_TEXT}); results may be missing.`]);
  assert.equal(result.complete, false);
});

test('find stops at a caller abort: no further client call, the original error, no warning', async () => {
  const controller = new AbortController();
  const abortError = new Dv360Error('network');
  const { service, calls } = findSetup({
    listPartners: async () => ({ items: Array.from({ length: 6 }, (_, index) => partnerEntity(String(index + 1))) }),
    listAdvertisers: async partnerId => {
      if (partnerId === '4') { controller.abort(); await tick(); throw abortError; }
      return { items: [] };
    },
  });
  await assert.rejects(service.find({ resource: 'advertiser', name: 'acme', signal: controller.signal }), error => error === abortError);
  assert.deepEqual(calls.filter(call => call.method === 'listAdvertisers').map(call => call.args[0]), ['1', '2', '3', '4']);
});

test('find caches complete directories for the TTL and reloads them after it', async () => {
  const { service, count } = findSetup({
    listPartners: async () => ({ items: [partnerEntity('1')] }),
    listAdvertisers: directoryHandler({ 1: [advertiserEntity('11', '1', 'Acme')] }),
  });
  await service.find({ resource: 'advertiser', name: 'acme' });
  clock += DIRECTORY_TTL_MS - 1;
  await service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(count('listAdvertisers'), 1);
  clock += 1;
  await service.find({ resource: 'advertiser', name: 'acme' });
  assert.equal(count('listAdvertisers'), 2);
});

test('find drops an expired directory: a failed reload counts as a failed partner', async () => {
  let fail = false;
  const { service } = findSetup({
    listPartners: async () => ({ items: [partnerEntity('1'), partnerEntity('2')] }),
    listAdvertisers: async (partnerId, options) => {
      if (fail && partnerId === '1') throw new Dv360Error('server_error');
      return paged([advertiserEntity(`${partnerId as string}1`, partnerId as string, 'Acme')])(options);
    },
  });
  await service.find({ resource: 'advertiser', name: 'acme' });
  clock += DIRECTORY_TTL_MS;
  fail = true;
  const result = await service.find({ resource: 'advertiser', name: 'acme' });
  assert.deepEqual(result.matches.map(match => match.id), ['21']);
  assert.equal(result.partnersFailed, 1);
  assert.equal(result.complete, false);
});

test('find does not store a directory cut by its page bound', async () => {
  const advertisers = Array.from({ length: (MAX_DIRECTORY_PAGES + 1) * 200 }, (_, index) => advertiserEntity(String(index + 1), '1', `Adv ${index}`));
  const { service, count } = findSetup({ listAdvertisers: async (_id, options) => paged(advertisers)(options) });
  const result = await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1' });
  assert.equal(count('listAdvertisers'), MAX_DIRECTORY_PAGES);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ['The search stopped before the end of the list (too many entries); results may be missing. Narrow it with partnerId.']);
  await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1' });
  assert.equal(count('listAdvertisers'), 2 * MAX_DIRECTORY_PAGES);
});

test('find keeps at most 50 directories and evicts the oldest', async () => {
  const { service, count } = findSetup({ listAdvertisers: async () => ({ items: [] }) });
  for (let partner = 1; partner <= MAX_CACHED_DIRECTORIES + 1; partner++) {
    clock += 1;
    await service.find({ resource: 'advertiser', name: 'acme', partnerId: String(partner), refresh: 'zero_matches' });
  }
  assert.equal(count('listAdvertisers'), 51);
  await service.find({ resource: 'advertiser', name: 'acme', partnerId: '51' });
  await service.find({ resource: 'advertiser', name: 'acme', partnerId: '2' });
  assert.equal(count('listAdvertisers'), 51);
  await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1' });
  assert.equal(count('listAdvertisers', '1'), 2);
});

test('find refreshes on zero matches only directories older than 60 s, only once, never those loaded in this call', async () => {
  const { service, count } = findSetup({
    listPartners: async () => ({ items: [partnerEntity('1'), partnerEntity('2')] }),
    listAdvertisers: directoryHandler({ 1: [advertiserEntity('11', '1', 'Acme')], 2: [advertiserEntity('21', '2', 'Beta')] }),
  });
  await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1' });
  clock += DIRECTORY_REFRESH_AFTER_MS;
  const exactly60 = await service.find({ resource: 'advertiser', name: 'missing', partnerId: '1' });
  assert.equal(count('listAdvertisers', '1'), 1);
  assert.equal(exactly60.totalMatches, 0);
  clock += 1;
  const result = await service.find({ resource: 'advertiser', name: 'missing' });
  assert.equal(count('listAdvertisers', '1'), 2);
  assert.equal(count('listAdvertisers', '2'), 1);
  assert.equal(result.totalMatches, 0);
  assert.deepEqual(result.warnings, []);

  // A partial match is not a miss in the default mode.
  clock += DIRECTORY_REFRESH_AFTER_MS + 1;
  await service.find({ resource: 'advertiser', name: 'acm', partnerId: '1' });
  assert.equal(count('listAdvertisers', '1'), 2);
});

test('find refresh no_exact reloads when only partial matches exist and finds the new exact name', async () => {
  let created = false;
  const { service, count } = findSetup({
    listAdvertisers: async (_id, options) => paged([
      advertiserEntity('11', '1', 'Acme Old'), ...(created ? [advertiserEntity('12', '1', 'Acme')] : []),
    ])(options),
  });
  await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1' });
  created = true;
  clock += DIRECTORY_REFRESH_AFTER_MS + 1;
  const partial = await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1' });
  assert.equal(count('listAdvertisers'), 1);
  assert.deepEqual(partial.matches.map(match => match.id), ['11']);
  const result = await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1', refresh: 'no_exact' });
  assert.equal(count('listAdvertisers'), 2);
  assert.deepEqual(result.matches.map(match => [match.id, match.kind]), [['12', 'exact'], ['11', 'prefix']]);
  assert.equal(result.exactMatches, 1);
});

test('find keeps the old directory when a refresh fails, and warns', async () => {
  let fail = false;
  const { service, count } = findSetup({
    listAdvertisers: async (_id, options) => {
      if (fail) throw new Dv360Error('access_denied');
      return paged([advertiserEntity('11', '1', 'Acme')])(options);
    },
  });
  await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1' });
  clock += DIRECTORY_REFRESH_AFTER_MS + 1;
  fail = true;
  const result = await service.find({ resource: 'advertiser', name: 'missing', partnerId: '1' });
  assert.equal(count('listAdvertisers'), 2);
  assert.equal(result.complete, true);
  assert.equal(result.partnersDenied, 0);
  assert.deepEqual(result.warnings, ['Some advertiser lists could not be refreshed; results may be up to 10 minutes old.']);
  const cached = await service.find({ resource: 'advertiser', name: 'acme', partnerId: '1' });
  assert.equal(count('listAdvertisers'), 2);
  assert.deepEqual(cached.matches.map(match => match.id), ['11']);
});

test('find passes callId, signal and the 45 s deadline to every client call', async () => {
  const controller = new AbortController();
  const many = Array.from({ length: 250 }, (_, index) => advertiserEntity(String(index + 1), '1', `Adv ${index}`));
  const { service, calls } = findSetup({
    listPartners: async options => paged([partnerEntity('1')])(options),
    listAdvertisers: async (_id, options) => paged(many)(options),
    listCampaigns: async (_id, options) => paged(Array.from({ length: 250 }, (_, index) => campaignEntity(String(index + 1), `C ${index}`)))(options),
  });
  const request = { name: 'missing', signal: controller.signal, callId: 'find-call' };
  await service.find({ resource: 'advertiser', ...request });
  clock += DIRECTORY_REFRESH_AFTER_MS + 1;
  await service.find({ resource: 'advertiser', ...request });   // refresh
  await service.find({ resource: 'partner', ...request });
  await service.find({ resource: 'campaign', advertiserId: '10', ...request });
  assert.deepEqual([...new Set(calls.map(call => call.method))].sort(), ['listAdvertisers', 'listCampaigns', 'listPartners']);
  assert.equal(calls.filter(call => call.method === 'listAdvertisers').length, 4);
  for (const call of calls) {
    assert.equal(call.call.signal, controller.signal);
    assert.equal(call.call.callId, 'find-call');
    assert.equal(typeof call.call.deadline, 'number');
  }
});

for (const resource of [undefined, 'campaign', 'insertionOrder', 'lineItem'] as const) test(`describeTarget reads ${resource ?? 'advertiser'} with existing summaries`, async () => {
  const h = service();
  const target = resource === undefined ? undefined : { resource, id: resource === 'campaign' ? '20' : resource === 'insertionOrder' ? '30' : '40' };
  const result = await h.metadata.describeTarget({ advertiserId: '10', target });
  assert.equal(h.calls.length, target ? 2 : 1);
  assert.equal(result.advertiser?.partnerId, '1');
  assert.equal(result.advertiser?.currency, 'TRY');
  assert.equal(result.target?.resource, resource);
  if (target) {
    const details = await h.metadata.get({ advertiserId: '10', resource: target.resource, id: target.id });
    assert.deepEqual(result.target?.summary, details.summary);
  }
});
test('describeTarget starts both calls in parallel and propagates options', async () => {
  const h = fakeClient();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: [string, CallOptions | undefined][] = [];
  h.client.getAdvertiser = async (_id, call) => { calls.push(['advertiser', call]); await gate; return advertiser() as Awaited<ReturnType<Dv360Client['getAdvertiser']>>; };
  h.client.getLineItem = async (_adv, _id, call) => { calls.push(['lineItem', call]); await gate; return lineItem() as Awaited<ReturnType<Dv360Client['getLineItem']>>; };
  const signal = new AbortController().signal, deadline = NOW.getTime() + 10_000;
  const result = createMetadataService({ client: h.client, now: () => NOW }).describeTarget({ advertiserId: '10', target: { resource: 'lineItem', id: '40' }, signal, deadline, callId: 'synthetic' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(([, call]) => call), Array(2).fill({ signal, deadline, callId: 'synthetic' }));
  release();
  const described = await result;
  assert.equal(described.target?.campaignId, '20');
  assert.equal(described.target?.insertionOrderId, '30');
  assert.equal(described.target?.lineItemType, 'LINE_ITEM_TYPE_DISPLAY_DEFAULT');
});
for (const kind of ['not_found', 'access_denied'] as const) test(`describeTarget rethrows advertiser ${kind}`, async () => {
  const error = new Dv360Error(kind);
  const h = service({ lookup: async () => { throw error; } });
  await assert.rejects(h.metadata.describeTarget({ advertiserId: '10', target: { resource: 'campaign', id: '20' } }), e => e === error);
});
test('describeTarget target errors are rethrown', async () => {
  const error = new Dv360Error('not_found');
  const h = service({ fail: { getCampaign: async () => { throw error; } } });
  await assert.rejects(h.metadata.describeTarget({ advertiserId: '10', target: { resource: 'campaign', id: '20' } }), e => e === error);
});
test('describeTarget degrades advertiser server errors without currency', async () => {
  const error = new Dv360Error('server_error');
  const h = service({ lookup: async () => { throw error; } });
  const described = await h.metadata.describeTarget({ advertiserId: '10', target: { resource: 'lineItem', id: '40' } });
  assert.equal(described.advertiser, undefined);
  assert.equal(described.advertiserProblem, error.message);
  assert.ok(described.warnings.some(w => w.includes(error.message)));
  assert.ok(described.target?.summary.some(line => line.includes('(advertiser currency)')));
});
for (const partnerId of ['123', '1'.repeat(20), '1'.repeat(21), 'bad', '', undefined]) test(`describeTarget partner validity ${partnerId}`, async () => {
  const h = service({ lookup: async () => advertiser({ partnerId }) });
  const result = await h.metadata.describeTarget({ advertiserId: '10' });
  assert.equal(result.advertiser?.partnerId, partnerId !== undefined && /^[0-9]{1,20}$/.test(partnerId) ? partnerId : undefined);
});
for (const [advertiserId, targetId] of [['bad', '20'], ['10', 'bad'], ['', '20'], ['10', '1'.repeat(21)]]) test(`describeTarget invalid IDs ${advertiserId}/${targetId}`, async () => {
  const h = service();
  await assert.rejects(h.metadata.describeTarget({ advertiserId, target: { resource: 'campaign', id: targetId } }), { message: 'IDs must be numeric.' });
  assert.deepEqual(h.calls, []);
});
test('find external deadline stops the next page and reaches client', async () => {
  const h = fakeClient();
  let time = NOW.getTime(), calls = 0;
  const deadline = time + 1000;
  h.client.listCampaigns = async (_id, _options, call) => {
    calls++;
    assert.equal(call?.deadline, deadline);
    time = deadline;
    return { items: [], nextPageToken: 'next' };
  };
  const found = await createMetadataService({ client: h.client, now: () => new Date(time) }).find({ resource: 'campaign', advertiserId: '10', name: 'test', deadline });
  assert.equal(calls, 1);
  assert.equal(found.complete, false);
});

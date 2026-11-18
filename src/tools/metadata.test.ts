import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../server.js';
import { registerMetadataTools, renderFind, renderGet, renderList } from './metadata.js';
import { Dv360Error } from '../integrations/dv360/errors.js';
import { MAX_ROW_CHARS } from '../integrations/dv360/format.js';
import { RESOURCE_STATUSES, type FindResult, type GetResult, type ListRequest, type ListResult, type MetadataService } from '../integrations/dv360/metadata.js';
import { createToolRunner, type ToolCallEvent } from './call.js';

const reporting = {
  async startAdHocReport() { throw new Error('Unexpected reporting call'); },
  async startSavedReport() { throw new Error('Unexpected reporting call'); },
  async collectReport() { throw new Error('Unexpected reporting call'); },
  async listSavedQueries() { throw new Error('Unexpected reporting call'); },
};
const emptyList: ListResult = { resource: 'partner', rows: [], statusFilter: 'default', warnings: [] };
const emptyGet: GetResult = {
  resource: 'partner', id: '1', name: 'Partner A', status: 'ACTIVE', summary: ['currency USD'], details: '{"partnerId":"1"}', warnings: [],
};
const emptyFind: FindResult = {
  resource: 'partner', query: 'acme', matches: [], totalMatches: 0, exactMatches: 0, searched: 0, complete: true,
  statusFilter: 'default', notes: [], warnings: [],
};
function service(overrides: Partial<MetadataService> = {}): MetadataService {
  return { async describeTarget() { throw new Error('Unexpected describe call'); }, async list() { return emptyList; }, async get() { return emptyGet; }, async find() { return emptyFind; }, ...overrides };
}
async function connect(t: TestContext, metadata = service()): Promise<Client> {
  const server = createServer({ performance: { async getPerformance() { throw new Error('Unexpected performance call'); } }, reporting, metadata });
  const client = new Client({ name: 'test-client', version: '1' });
  t.after(() => client.close()); t.after(() => server.close());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  return client;
}
function resultText(result: { content?: unknown }): string {
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}
const failing = async (): Promise<never> => { assert.fail('must not call the service'); };

test('every metadata tool forwards the runner callId with its mapped resource and arguments', async t => {
  const calls: { method: string; request: unknown }[] = [];
  const events: ToolCallEvent[] = [];
  let sequence = 0;
  const server = createServer({ performance: { async getPerformance() { throw new Error('Unexpected performance call'); } },
    reporting,
    metadata: service({
      async list(request) { calls.push({ method: 'list', request }); return { ...emptyList, resource: request.resource }; },
      async get(request) { calls.push({ method: 'get', request }); return { ...emptyGet, resource: request.resource }; },
    }),
    runTool: createToolRunner({ log: event => events.push(event), now: () => 100, newCallId: () => `metadata-call-${++sequence}` }),
  });
  const client = new Client({ name: 'test-client', version: '1' });
  t.after(() => client.close()); t.after(() => server.close());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const requests = [
    ['list_partners', { statuses: ['ACTIVE'], pageSize: 5, pageToken: 'v1.token' }, { resource: 'partner', statuses: ['ACTIVE'], pageSize: 5, pageToken: 'v1.token' }],
    ['list_advertisers', { partnerId: '1', pageSize: 40 }, { resource: 'advertiser', partnerId: '1', pageSize: 40 }],
    ['list_campaigns', { advertiserId: '10', statuses: ['PAUSED'] }, { resource: 'campaign', advertiserId: '10', statuses: ['PAUSED'] }],
    ['list_insertion_orders', { advertiserId: '10', campaignId: '20' }, { resource: 'insertionOrder', advertiserId: '10', campaignId: '20' }],
    ['list_line_items', { advertiserId: '10', campaignId: '20', insertionOrderId: '30' }, { resource: 'lineItem', advertiserId: '10', campaignId: '20', insertionOrderId: '30' }],
    ['get_metadata', { type: 'partner', id: '1' }, { resource: 'partner', id: '1' }],
    ['get_metadata', { type: 'advertiser', id: '10' }, { resource: 'advertiser', id: '10' }],
    ['get_metadata', { type: 'campaign', id: '20', advertiserId: '10' }, { resource: 'campaign', id: '20', advertiserId: '10' }],
    ['get_metadata', { type: 'insertion_order', id: '30', advertiserId: '10' }, { resource: 'insertionOrder', id: '30', advertiserId: '10' }],
    ['get_metadata', { type: 'line_item', id: '40', advertiserId: '10' }, { resource: 'lineItem', id: '40', advertiserId: '10' }],
  ] as const;
  for (const [index, [name, args, request]] of requests.entries()) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    assert.equal(calls.length, index + 1);
    assert.equal(calls[index].method, name === 'get_metadata' ? 'get' : 'list');
    const { signal, ...forwarded } = calls[index].request as Record<string, unknown>;
    assert.ok(signal instanceof AbortSignal);
    const callId = `metadata-call-${index + 1}`;
    assert.deepEqual(forwarded, { ...request, callId });
    assert.deepEqual(events[index], { type: 'tool.call', tool: name, callId, outcome: 'ok', durationMs: 0 });
  }
  assert.equal(events.length, requests.length);
});

const PAGING = '\nUse pageToken from a result to get the next page, with exactly the same other arguments.';
const expected = {
  list_partners: ['List partners', "Lists the DV360 partners the server's Google account can see (ID, name, status, currency). Start here when the user names no IDs. DV360's hierarchy is partner → advertiser → campaign → insertion order → line item; drill down with list_advertisers, list_campaigns, list_insertion_orders, and list_line_items. Archived partners are hidden unless statuses includes ARCHIVED.\nIDs from these tools work in the report tools' filters (e.g. FILTER_PARTNER, FILTER_ADVERTISER, FILTER_MEDIA_PLAN for campaigns, FILTER_INSERTION_ORDER, FILTER_LINE_ITEM)." + PAGING],
  list_advertisers: ['List advertisers', "Lists the advertisers under one DV360 partner (ID, name, status, currency, time zone). Needs a partnerId (from list_partners). Statuses: ACTIVE, PAUSED, SCHEDULED_FOR_DELETION; all are shown by default (advertisers can't be archived).\nTo find an advertiser by name, use find_entities." + PAGING],
  list_campaigns: ['List campaigns', 'Lists the campaigns of one advertiser (ID, name, status, goal, planned dates, planned spend). Archived campaigns are hidden unless statuses includes ARCHIVED. Planned spend is informational and does not cap spending.' + PAGING],
  list_insertion_orders: ['List insertion orders', "Lists the insertion orders of one advertiser, optionally only those of one campaign (ID, name, status, campaign, budget type and automation, the current or next budget segment, pacing). Drafts are shown; archived insertion orders are hidden unless statuses includes ARCHIVED.\nAmounts are converted from Google's micros and shown with the advertiser's currency. Impression budgets are shown as impression counts, never money." + PAGING],
  list_line_items: ['List line items', 'Lists the line items of one advertiser, optionally narrowed to one campaign or insertion order (ID, name, status, insertion order, type, flight, budget, bid strategy). Archived line items are hidden unless statuses includes ARCHIVED; an empty list can mean they are all archived.\nBudgets: "fixed" amounts are money in the advertiser\'s currency or impression counts, as labelled; "unlimited" has no cap; "automatic" is set by the insertion order. Never add money across advertisers with different currencies.' + PAGING],
  get_metadata: ['Get DV360 entity details', "Shows one DV360 partner, advertiser, campaign, insertion order, or line item in detail: a readable summary (amounts with currency, every budget segment) followed by Google's full record as JSON. Campaigns, insertion orders, and line items need their advertiserId.\nPrefer the summary lines for amounts. In the JSON, money fields (budgetAmountMicros and maxAmount under a currency budget, bidAmountMicros, plannedSpendAmountMicros, dailyMaxMicros) are millionths of the advertiser's currency. Other Micros fields are not money: performanceGoalPercentageMicros is a percentage in millionths, and performanceGoalAmountMicros depends on the goal type (money, percentage, or a ratio such as ROAS). Under budgetUnit BUDGET_UNIT_IMPRESSIONS, line item maxAmount and insertion order segment budgetAmountMicros are plain impression counts (not micros, despite the name); for campaign budgets the unit is not yet verified."],
  find_entities: ['Find DV360 entities by name', "Finds DV360 partners, advertisers, campaigns, insertion orders, or line items by name and returns their IDs. Matching ignores case and finds every name that contains the text; exact names come first, then names that start with it. Campaigns, insertion orders, and line items need their advertiserId (find the advertiser first if you only know its name). Advertisers are searched under partnerId, or under every partner the account can see when partnerId is omitted.\nStatuses: partners, insertion orders, and line items accept ACTIVE, PAUSED, DRAFT, ARCHIVED (partners also SCHEDULED_FOR_DELETION); campaigns ACTIVE, PAUSED, ARCHIVED; advertisers ACTIVE, PAUSED, SCHEDULED_FOR_DELETION. Defaults are the list tools' (archived hidden; all advertisers shown).\nUse the IDs with get_metadata, the list tools, and the report tools' filters. When several entities match, ask the user which one they mean instead of guessing. An incomplete search is not proof that no match exists."],
} as const;

test('the server lists thirteen tools; the seven metadata tools have exact titles, descriptions, annotations and no output schema', async t => {
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  for (const [name, [title, description]] of Object.entries(expected)) {
    const tool = tools.find(tool => tool.name === name)!;
    assert.ok(tool, name);
    assert.equal(tool.title, title);
    assert.equal(tool.description, description);
    assert.equal(tool.outputSchema, undefined);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  }
});

test('input schemas expose the documented fields, page size limit, and per-resource statuses', async t => {
  const client = await connect(t);
  const { tools } = await client.listTools();
  const schema = (name: string) => tools.find(tool => tool.name === name)!.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] };
  assert.deepEqual(Object.keys(schema('list_partners').properties).sort(), ['pageSize', 'pageToken', 'statuses']);
  assert.deepEqual(schema('list_advertisers').required, ['partnerId']);
  assert.deepEqual(schema('list_campaigns').required, ['advertiserId']);
  assert.deepEqual(Object.keys(schema('list_insertion_orders').properties).sort(), ['advertiserId', 'campaignId', 'pageSize', 'pageToken', 'statuses']);
  assert.deepEqual(Object.keys(schema('list_line_items').properties).sort(), ['advertiserId', 'campaignId', 'insertionOrderId', 'pageSize', 'pageToken', 'statuses']);
  assert.deepEqual(schema('get_metadata').required?.sort(), ['id', 'type']);
  assert.equal(schema('list_partners').properties.pageSize.maximum, 40);
  const statusEnum = (name: string) => ((schema(name).properties.statuses.items as { enum: string[] }).enum);
  assert.deepEqual(statusEnum('list_partners'), ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'SCHEDULED_FOR_DELETION']);
  assert.deepEqual(statusEnum('list_advertisers'), ['ACTIVE', 'PAUSED', 'SCHEDULED_FOR_DELETION']);
  assert.deepEqual(statusEnum('list_campaigns'), ['ACTIVE', 'PAUSED', 'ARCHIVED']);
  assert.deepEqual(statusEnum('list_insertion_orders'), ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED']);
  assert.deepEqual(statusEnum('list_line_items'), ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED']);
});

for (const [name, args] of [
  ['list_partners', { typo: true }],
  ['list_partners', { pageSize: 41 }],
  ['list_partners', { pageSize: 0 }],
  ['list_partners', { statuses: [] }],
  ['list_advertisers', {}],
  ['list_advertisers', { partnerId: 'abc' }],
  ['list_advertisers', { partnerId: '1', statuses: ['ARCHIVED'] }],
  ['list_campaigns', { advertiserId: '1/2' }],
  ['list_campaigns', { advertiserId: '1', statuses: ['DRAFT'] }],
  ['list_campaigns', { advertiserId: '1', pageToken: 'x'.repeat(2001) }],
  ['list_insertion_orders', { advertiserId: '1', campaignId: 'x' }],
  ['list_insertion_orders', { advertiserId: '1', insertionOrderId: '2' }],
  ['list_line_items', { advertiserId: '1', statuses: ['SCHEDULED_FOR_DELETION'] }],
  ['list_line_items', { advertiserId: '1'.repeat(21) }],
  ['get_metadata', { type: 'creative', id: '1' }],
  ['get_metadata', { type: 'partner', id: 'x' }],
  ['get_metadata', { type: 'partner', id: '1', typo: true }],
] as const) {
  test(`${name} rejects ${JSON.stringify(args).slice(0, 60)} before the service`, async t => {
    const client = await connect(t, service({ list: failing, get: failing }));
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
  });
}

test('every list tool forwards its arguments unchanged with the right resource', async t => {
  const calls: ListRequest[] = [];
  const client = await connect(t, service({ async list(request) { calls.push(request); return { ...emptyList, resource: request.resource }; } }));
  const requests = [
    ['list_partners', { statuses: ['ACTIVE', 'ARCHIVED'], pageSize: 5, pageToken: 'v1.token' }, 'partner'],
    ['list_advertisers', { partnerId: '1', pageSize: 40 }, 'advertiser'],
    ['list_campaigns', { advertiserId: '10', statuses: ['PAUSED'] }, 'campaign'],
    ['list_insertion_orders', { advertiserId: '10', campaignId: '20', statuses: ['DRAFT'] }, 'insertionOrder'],
    ['list_line_items', { advertiserId: '10', campaignId: '20', insertionOrderId: '30', pageSize: 1 }, 'lineItem'],
  ] as const;
  for (const [name, args, resource] of requests) {
    const result = await client.callTool({ name, arguments: args });
    resultText(result);
    assert.equal(result.structuredContent, undefined);
    assert.notEqual(result.isError, true);
    const { signal, callId, ...request } = calls.at(-1)!;
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(request, { resource, ...args });
  }
  assert.equal(calls.length, 5);
});

test('get_metadata maps type names, forwards arguments, and checks advertiserId', async t => {
  const calls: unknown[] = [];
  const client = await connect(t, service({ async get(request) { calls.push(request); return { ...emptyGet, resource: request.resource }; } }));
  const ok: [Record<string, string>, unknown][] = [
    [{ type: 'partner', id: '1' }, { resource: 'partner', id: '1' }],
    [{ type: 'advertiser', id: '10' }, { resource: 'advertiser', id: '10' }],
    [{ type: 'campaign', id: '20', advertiserId: '10' }, { resource: 'campaign', id: '20', advertiserId: '10' }],
    [{ type: 'insertion_order', id: '30', advertiserId: '10' }, { resource: 'insertionOrder', id: '30', advertiserId: '10' }],
    [{ type: 'line_item', id: '40', advertiserId: '10' }, { resource: 'lineItem', id: '40', advertiserId: '10' }],
  ];
  for (const [args, request] of ok) {
    const result = await client.callTool({ name: 'get_metadata', arguments: args });
    assert.notEqual(result.isError, true);
    const { signal, callId, ...forwarded } = calls.at(-1) as Record<string, unknown>;
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(forwarded, request);
  }
  const before = calls.length;
  for (const type of ['campaign', 'insertion_order', 'line_item']) {
    const result = await client.callTool({ name: 'get_metadata', arguments: { type, id: '1' } });
    assert.equal(result.isError, true);
    assert.equal(resultText(result), 'advertiserId is required for campaigns, insertion orders, and line items.');
  }
  for (const type of ['partner', 'advertiser']) {
    const result = await client.callTool({ name: 'get_metadata', arguments: { type, id: '1', advertiserId: '10' } });
    assert.equal(result.isError, true);
    assert.equal(resultText(result), 'advertiserId is only used for campaigns, insertion orders, and line items.');
  }
  assert.equal(calls.length, before);
});

test('service errors become safe tool errors; unknown errors never leak', async t => {
  for (const [error, text] of [
    [new Dv360Error('access_denied'), 'Access denied. The partner or advertiser ID may be wrong, or the Google account this server uses has no access to it.'],
    [new Dv360Error('rate_limited'), 'Too many Display & Video 360 requests in the last minute. Wait a minute, then try again.'],
    [new Error('https://secret.example/advertisers/987'), "Unexpected server error. Try again; if it keeps happening, report it to the server's maintainer."],
  ] as const) {
    const client = await connect(t, service({ async list() { throw error; }, async get() { throw error; } }));
    for (const call of [{ name: 'list_partners', arguments: {} }, { name: 'get_metadata', arguments: { type: 'partner', id: '1' } }]) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.equal(resultText(result), text);
    }
  }
});

const row = (id: string) => ({ id, line: `- ${id} · Name ${id} · ACTIVE · currency USD` });

test('renderList: headers, parent clauses, status clauses, note, warnings, and token or end of list', () => {
  const base = { ...emptyList, rows: [row('1'), row('2')] };
  assert.equal(renderList(base, { resource: 'partner' }),
    'Partners (2 shown; statuses: all except archived):\n- 1 · Name 1 · ACTIVE · currency USD\n- 2 · Name 2 · ACTIVE · currency USD\nEnd of list.');
  assert.equal(renderList({ ...base, resource: 'advertiser', nextPageToken: 'v1.abc.def' }, { resource: 'advertiser', partnerId: '1' }).split('\n')[0],
    'Advertisers under partner 1 (2 shown; statuses: all):');
  assert.equal(renderList({ ...base, resource: 'campaign', statusFilter: ['ACTIVE', 'ARCHIVED'] }, { resource: 'campaign', advertiserId: '10' }).split('\n')[0],
    'Campaigns of advertiser 10 (2 shown; statuses: ACTIVE, ARCHIVED):');
  assert.equal(renderList({ ...base, resource: 'insertionOrder' }, { resource: 'insertionOrder', advertiserId: '10', campaignId: '20' }).split('\n')[0],
    'Insertion orders of advertiser 10, campaign 20 (2 shown; statuses: all except archived):');
  assert.equal(renderList({ ...base, resource: 'lineItem' }, { resource: 'lineItem', advertiserId: '10', campaignId: '20', insertionOrderId: '30' }).split('\n')[0],
    'Line items of advertiser 10, campaign 20, insertion order 30 (2 shown; statuses: all except archived):');
  assert.equal(renderList({ ...base, resource: 'lineItem' }, { resource: 'lineItem', advertiserId: '10', insertionOrderId: '30' }).split('\n')[0],
    'Line items of advertiser 10, insertion order 30 (2 shown; statuses: all except archived):');
  const full = renderList({ ...base, resource: 'lineItem', currency: 'TRY', warnings: ['w1', 'w2'], nextPageToken: 'v1.abc.def' }, { resource: 'lineItem', advertiserId: '10' }).split('\n');
  assert.deepEqual(full.slice(3), [
    "Note: amounts are in TRY (the advertiser's currency).", 'Warning: w1', 'Warning: w2',
    'More line items follow: call list_line_items again with the same arguments and pageToken "v1.abc.def".',
  ]);
});

test('renderList: an empty list says so and an absent token ends the list', () => {
  const lines = renderList({ ...emptyList, resource: 'lineItem' }, { resource: 'lineItem', advertiserId: '10' }).split('\n');
  assert.deepEqual(lines, [
    'Line items of advertiser 10 (0 shown; statuses: all except archived):',
    'No line items found with these statuses. An empty list means none are visible to this account with these statuses.',
    'End of list.',
  ]);
  assert.equal(renderList({ ...emptyList, resource: 'insertionOrder' }, { resource: 'insertionOrder', advertiserId: '10' }).includes('No insertion orders found'), true);
});

test('renderList: an empty page that still has a token says more follow, never that none are visible', () => {
  const text = renderList({ ...emptyList, resource: 'lineItem', nextPageToken: 'v1.abc.def' }, { resource: 'lineItem', advertiserId: '10' });
  assert.deepEqual(text.split('\n'), [
    'Line items of advertiser 10 (0 shown; statuses: all except archived):',
    'No line items on this page; more follow.',
    'More line items follow: call list_line_items again with the same arguments and pageToken "v1.abc.def".',
  ]);
  assert.ok(!text.includes('none are visible'));
});

test('renderList prints each row exactly as the service built it and never reformats', () => {
  const odd = { id: '1', line: '- 1 · exactly this line, unchanged' };
  assert.ok(renderList({ ...emptyList, rows: [odd] }, { resource: 'partner' }).split('\n').includes(odd.line));
});

test('renderGet: summary lines, segments, warnings, and details', () => {
  assert.equal(renderGet(emptyGet), [
    'Partner 1: Partner A', 'Status: ACTIVE', 'currency USD',
    "Details (Google's record as JSON; for units of Micros and budget fields see the get_metadata description, and prefer the summary lines above):",
    '{"partnerId":"1"}',
  ].join('\n'));
  const io: GetResult = { ...emptyGet, resource: 'insertionOrder', id: '30', name: 'IO 30', summary: ['campaign 20'], segments: ['a', 'current: b'], warnings: ['careful'] };
  assert.deepEqual(renderGet(io).split('\n').slice(0, 8), [
    'Insertion order 30: IO 30', 'Status: ACTIVE', 'campaign 20', 'Budget segments:', '- a', '- current: b', 'Warning: careful',
    "Details (Google's record as JSON; for units of Micros and budget fields see the get_metadata description, and prefer the summary lines above):",
  ]);
  assert.ok(!renderGet({ ...io, segments: [] }).includes('Budget segments:'));
  for (const [resource, label] of [['advertiser', 'Advertiser'], ['campaign', 'Campaign'], ['lineItem', 'Line item']] as const) {
    assert.ok(renderGet({ ...emptyGet, resource }).startsWith(`${label} 1: `));
  }
});

test('renderGet: omitted details are explained, and the JSON is not repeated', () => {
  const text = renderGet({ ...emptyGet, details: '', detailsOmitted: 13_000 });
  assert.ok(text.endsWith("Details omitted: Google's record is 13000 characters, too long to show here. The summary above has the key fields."));
  assert.ok(!text.includes('Details (Google'));
});

test('a worst-case list page fits the limit and keeps its page token', async t => {
  const line = `- ${'9'.repeat(20)} · ${'N'.repeat(80)} · ${'S'.repeat(24)}`.padEnd(MAX_ROW_CHARS, 'x');
  assert.equal(line.length, MAX_ROW_CHARS);
  const token = `v1.${'a'.repeat(16)}.${'b'.repeat(1334)}`;
  const worst: ListResult = {
    resource: 'lineItem', rows: Array.from({ length: 40 }, (_, index) => ({ id: String(index), line })), statusFilter: 'default',
    nextPageToken: token, currency: 'TRY', warnings: ['w'.repeat(200), 'w'.repeat(200), 'w'.repeat(200), 'w'.repeat(200)],
  };
  const client = await connect(t, service({ async list() { return worst; } }));
  const result = await client.callTool({ name: 'list_line_items', arguments: { advertiserId: '10' } });
  assert.notEqual(result.isError, true);
  const text = resultText(result);
  assert.ok(text.length <= 20_000, `length ${text.length}`);
  assert.ok(text.includes(token));
});

test('a list result over the limit is refused whole, with no page token in it', async t => {
  const token = `v1.${'a'.repeat(16)}.SECRET_TOKEN`;
  const huge: ListResult = { ...emptyList, rows: [{ id: '1', line: 'x'.repeat(21_000) }], nextPageToken: token };
  const client = await connect(t, service({ async list() { return huge; } }));
  const result = await client.callTool({ name: 'list_partners', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(resultText(result), 'The result was too long to show. Use a smaller pageSize.');
  assert.ok(!resultText(result).includes('SECRET_TOKEN'));
});

test('a get result over the limit is refused', async t => {
  const client = await connect(t, service({ async get() { return { ...emptyGet, details: 'x'.repeat(17_000) }; } }));
  const result = await client.callTool({ name: 'get_metadata', arguments: { type: 'partner', id: '1' } });
  assert.equal(result.isError, true);
  assert.equal(resultText(result), 'The record was too long to show.');
});

test('registerMetadataTools registers exactly the seven tools on a bare server', async () => {
  const names: string[] = [];
  registerMetadataTools({ registerTool(name: string) { names.push(name); } } as never, service());
  assert.deepEqual(names, ['list_partners', 'list_advertisers', 'list_campaigns', 'list_insertion_orders', 'list_line_items', 'get_metadata', 'find_entities']);
});

// ---------------------------------------------------------------------------------------------
// find_entities (M6 step 1)

const match = (id: string, name: string, extra: Partial<FindResult['matches'][number]> = {}): FindResult['matches'][number] =>
  ({ id, name, status: 'ACTIVE', kind: 'contains', ...extra });
const found = (overrides: Partial<FindResult>): FindResult => ({ ...emptyFind, ...overrides });
const USE_IDS = "Use these IDs with get_metadata, the list tools, and the report tools' filters.";

test('find_entities maps the type, forwards the arguments, signal and callId to find', async t => {
  const requests: unknown[] = [];
  const server = createServer({ performance: { async getPerformance() { throw new Error('Unexpected performance call'); } },
    reporting,
    metadata: service({ async find(request) { requests.push(request); return { ...emptyFind, resource: request.resource }; } }),
    runTool: createToolRunner({ log: () => {}, now: () => 100, newCallId: () => 'find-1' }),
  });
  const client = new Client({ name: 'test-client', version: '1' });
  t.after(() => client.close()); t.after(() => server.close());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  await client.callTool({ name: 'find_entities', arguments: { type: 'line_item', name: 'video', advertiserId: '10', campaignId: '20', insertionOrderId: '30', statuses: ['PAUSED'] } });
  await client.callTool({ name: 'find_entities', arguments: { type: 'advertiser', name: 'acme', partnerId: '1' } });
  const [first, second] = requests as Record<string, unknown>[];
  assert.ok(first.signal instanceof AbortSignal);
  const { signal: _s1, ...firstRest } = first;
  const { signal: _s2, ...secondRest } = second;
  assert.deepEqual(firstRest, { resource: 'lineItem', name: 'video', advertiserId: '10', campaignId: '20', insertionOrderId: '30', statuses: ['PAUSED'], callId: 'find-1' });
  assert.deepEqual(secondRest, { resource: 'advertiser', name: 'acme', partnerId: '1', callId: 'find-1' });
});

test('find_entities schema is strict and bounds name and statuses', async t => {
  const client = await connect(t, service({ find: failing }));
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'find_entities')!.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['advertiserId', 'campaignId', 'insertionOrderId', 'name', 'partnerId', 'statuses', 'type']);
  assert.deepEqual(schema.required?.sort(), ['name', 'type']);
  for (const args of [
    { type: 'partner', name: 'x', typo: true },
    { type: 'partner', name: 'a'.repeat(201) },
    { type: 'partner', name: '' },
    { type: 'partner', name: 'x', statuses: [] },
    { type: 'partner', name: 'x', statuses: ['UNKNOWN'] },
    { type: 'partner', name: 'x', refresh: 'no_exact' },
    { type: 'creative', name: 'x' },
    { type: 'advertiser', name: 'x', partnerId: 'abc' },
  ]) {
    const result = await client.callTool({ name: 'find_entities', arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
});

test('find_entities status sentence matches the per-resource status table', () => {
  assert.deepEqual(RESOURCE_STATUSES.partner, ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'SCHEDULED_FOR_DELETION']);
  assert.deepEqual(RESOURCE_STATUSES.insertionOrder, ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED']);
  assert.deepEqual(RESOURCE_STATUSES.lineItem, ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED']);
  assert.deepEqual(RESOURCE_STATUSES.campaign, ['ACTIVE', 'PAUSED', 'ARCHIVED']);
  assert.deepEqual(RESOURCE_STATUSES.advertiser, ['ACTIVE', 'PAUSED', 'SCHEDULED_FOR_DELETION']);
  const sentence = expected.find_entities[1].split('\n')[1];
  assert.ok(sentence.startsWith(`Statuses: partners, insertion orders, and line items accept ${RESOURCE_STATUSES.lineItem.join(', ')} (partners also SCHEDULED_FOR_DELETION); campaigns ${RESOURCE_STATUSES.campaign.join(', ')}; advertisers ${RESOURCE_STATUSES.advertiser.join(', ')}.`));
});

test('renderFind headers follow the literal examples for each branch', () => {
  const header = (result: FindResult, request: Parameters<typeof renderFind>[1]) => renderFind(result, request).split('\n')[0];
  const shownOf = (shown: number, total: number) => ({
    matches: Array.from({ length: shown }, (_, index) => match(String(index + 1), `M ${index}`)), totalMatches: total,
  });
  assert.equal(header(found({ resource: 'partner', ...shownOf(2, 2), searched: 15 }), { resource: 'partner' }),
    'Partners matching "acme" (2 of 2 shown; searched 15 partners; statuses: all except archived):');
  assert.equal(header(found({ resource: 'advertiser', ...shownOf(3, 3), searched: 273, partnersSearched: 15 }), { resource: 'advertiser' }),
    'Advertisers under all partners matching "acme" (3 of 3 shown; searched 273 advertisers under 15 partners; statuses: all):');
  assert.equal(header(found({ resource: 'advertiser', ...shownOf(1, 1), searched: 273, partnersSearched: 1 }), { resource: 'advertiser', partnerId: '123' }),
    'Advertisers under partner 123 matching "acme" (1 of 1 shown; searched 273 advertisers; statuses: all):');
  assert.equal(header(found({ resource: 'campaign', query: 'spring', ...shownOf(2, 2), searched: 17 }), { resource: 'campaign', advertiserId: '456' }),
    'Campaigns of advertiser 456 matching "spring" (2 of 2 shown; searched 17 campaigns; statuses: all except archived):');
  assert.equal(header(found({ resource: 'insertionOrder', query: 'q4', ...shownOf(1, 1), searched: 12, statusFilter: ['ACTIVE', 'PAUSED'] }),
    { resource: 'insertionOrder', advertiserId: '456', campaignId: '789' }),
  'Insertion orders of advertiser 456, campaign 789 matching "q4" (1 of 1 shown; searched 12 insertion orders; statuses: ACTIVE, PAUSED):');
  assert.equal(header(found({ resource: 'lineItem', query: 'video', ...shownOf(20, 31), searched: 45 }),
    { resource: 'lineItem', advertiserId: '456', insertionOrderId: '111' }),
  'Line items of advertiser 456, insertion order 111 matching "video" (20 of 31 shown; searched 45 line items; statuses: all except archived):');
});

test('renderFind rows carry parent tags and the exact mark, then the more line and the IDs hint', () => {
  const text = renderFind(found({
    resource: 'advertiser', totalMatches: 23, exactMatches: 1, searched: 300, partnersSearched: 2,
    matches: [match('11', 'Acme', { kind: 'exact', partnerId: '1' }), match('12', 'Acme Spring', { kind: 'prefix', partnerId: '2' })],
  }), { resource: 'advertiser' });
  assert.deepEqual(text.split('\n').slice(1), [
    '11 · Acme · ACTIVE · partner 1 · exact name',
    '12 · Acme Spring · ACTIVE · partner 2',
    '21 more matches not shown; use a more specific name.',
    USE_IDS,
  ]);
  const io = renderFind(found({ resource: 'insertionOrder', totalMatches: 1, matches: [match('30', 'IO', { advertiserId: '10', campaignId: '20' })] }), { resource: 'insertionOrder', advertiserId: '10' });
  assert.equal(io.split('\n')[1], '30 · IO · ACTIVE · campaign 20');
  const li = renderFind(found({ resource: 'lineItem', totalMatches: 2, matches: [
    match('40', 'LI', { advertiserId: '10', campaignId: '20', insertionOrderId: '30' }), match('41', 'LI 2', { advertiserId: '10' }),
  ] }), { resource: 'lineItem', advertiserId: '10' });
  assert.deepEqual(li.split('\n').slice(1, 3), ['40 · LI · ACTIVE · insertion order 30', '41 · LI 2 · ACTIVE']);
  const campaign = renderFind(found({ resource: 'campaign', totalMatches: 1, matches: [match('20', 'C', { advertiserId: '10', kind: 'exact' })] }), { resource: 'campaign', advertiserId: '10' });
  assert.equal(campaign.split('\n')[1], '20 · C · ACTIVE · exact name');
});

test('renderFind zero matches: incomplete first, else a hint per resource', () => {
  const lines = (result: FindResult, request: Parameters<typeof renderFind>[1]) => renderFind(result, request).split('\n').slice(1);
  const base = 'Matching ignores case and finds names that contain the text.';
  assert.deepEqual(lines(found({ resource: 'campaign', complete: false, warnings: ['W'] }), { resource: 'campaign', advertiserId: '10' }),
    ['The search was incomplete, so this is not proof that no match exists.', 'Warning: W']);
  assert.deepEqual(lines(found({ resource: 'partner' }), { resource: 'partner' }),
    [`No partners match "acme". ${base} Check the spelling, or include ARCHIVED in statuses.`]);
  for (const resource of ['campaign', 'insertionOrder', 'lineItem'] as const) {
    assert.match(lines(found({ resource }), { resource, advertiserId: '10' })[0], /Check the spelling, or include ARCHIVED in statuses\.$/);
  }
  assert.deepEqual(lines(found({ resource: 'advertiser', partnersSearched: 1 }), { resource: 'advertiser', partnerId: '1' }),
    [`No advertisers match "acme". ${base} Check the spelling, or search under all partners (omit partnerId).`]);
  assert.deepEqual(lines(found({ resource: 'advertiser', partnersSearched: 15 }), { resource: 'advertiser' }),
    [`No advertisers match "acme". ${base} Check the spelling.`]);
  assert.deepEqual(lines(found({ resource: 'campaign', statusFilter: ['ARCHIVED'] }), { resource: 'campaign', advertiserId: '10' }),
    [`No campaigns match "acme". ${base} Check the spelling.`]);
});

test('renderFind lists notes before warnings', () => {
  const text = renderFind(found({
    resource: 'advertiser', complete: false, partnersSearched: 1, notes: ['N1'], warnings: ['W1', 'W2'],
    totalMatches: 1, matches: [match('11', 'Acme', { partnerId: '1' })],
  }), { resource: 'advertiser' });
  assert.deepEqual(text.split('\n').slice(2), ['Note: N1', 'Warning: W1', 'Warning: W2', USE_IDS]);
});

test('find_entities returns the rendered text, refuses an oversized result, and makes service errors safe', async t => {
  const ok = await connect(t, service({ async find() { return found({ resource: 'partner', totalMatches: 1, searched: 1, matches: [match('1', 'Acme')] }); } }));
  const okResult = await ok.callTool({ name: 'find_entities', arguments: { type: 'partner', name: 'acme' } });
  assert.notEqual(okResult.isError, true);
  assert.equal(resultText(okResult), renderFind(found({ resource: 'partner', totalMatches: 1, searched: 1, matches: [match('1', 'Acme')] }), { resource: 'partner' }));

  const huge = await connect(t, service({ async find() { return found({ resource: 'partner', warnings: ['x'.repeat(12_001)] }); } }));
  const hugeResult = await huge.callTool({ name: 'find_entities', arguments: { type: 'partner', name: 'acme' } });
  assert.equal(hugeResult.isError, true);
  assert.equal(resultText(hugeResult), 'The result was too long to show. Use a more specific name.');

  const invalid = await connect(t, service({ async find() { throw new Dv360Error('invalid_request', 'statuses must not be empty.'); } }));
  const invalidResult = await invalid.callTool({ name: 'find_entities', arguments: { type: 'partner', name: 'acme' } });
  assert.equal(invalidResult.isError, true);
  assert.equal(resultText(invalidResult), 'statuses must not be empty.');

  const broken = await connect(t, service({ async find() { throw new Error('secret internal detail'); } }));
  const brokenResult = await broken.callTool({ name: 'find_entities', arguments: { type: 'partner', name: 'acme' } });
  assert.equal(brokenResult.isError, true);
  assert.equal(resultText(brokenResult), "Unexpected server error. Try again; if it keeps happening, report it to the server's maintainer.");
});

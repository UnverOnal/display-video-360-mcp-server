import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleCredentialsError } from '../google/auth.js';
import type { BidManagerClient, ListQueriesOptions, Query } from './client.js';
import { CLEANUP_MIN_INTERVAL_MS, createQueryCleanup } from './cleanup.js';
import { BidManagerError } from './errors.js';

const NOW = new Date('2026-11-06T12:00:00Z');
const OLD_TITLE = '[MCP] old report 2026-10-01T12:00:00Z';
const GENERIC_WARNING = 'Old [MCP] queries could not be cleaned up this time.';
const RESET_WARNING = 'The cleanup position for old [MCP] queries was reset.';

test('clean runs throttle until exactly thirty minutes after completion, retaining the cursor', async () => {
  const fake = fakeClient(teamQueries(301));
  let time = NOW.getTime();
  const cleanup = createQueryCleanup(fake.client, { now: () => new Date(time), minIntervalMs: CLEANUP_MIN_INTERVAL_MS });
  assert.equal(CLEANUP_MIN_INTERVAL_MS, 30 * 60_000);
  await cleanup.run();
  assert.equal(fake.listCalls.length, 2);
  time += CLEANUP_MIN_INTERVAL_MS - 1;
  assert.deepEqual(await cleanup.run(), { status: 'skipped', deletedQueryIds: [], warnings: [] });
  assert.equal(fake.listCalls.length, 2);
  time++;
  assert.equal((await cleanup.run()).status, 'completed');
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+200=');
});

test('a warned run does not begin the throttle interval', async () => {
  const fake = fakeClient([]);
  fake.hooks.beforeList = () => { throw new BidManagerError('network'); };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW, minIntervalMs: CLEANUP_MIN_INTERVAL_MS });
  assert.deepEqual((await cleanup.run()).warnings, [GENERIC_WARNING]);
  fake.hooks.beforeList = undefined;
  assert.equal((await cleanup.run()).status, 'completed');
  assert.equal(fake.listCalls.length, 2);
  assert.equal((await cleanup.run()).status, 'skipped');
});

test('a reset run does not begin the throttle interval', async () => {
  const fake = fakeClient(teamQueries(301));
  let time = NOW.getTime();
  const cleanup = createQueryCleanup(fake.client, { now: () => new Date(time), minIntervalMs: CLEANUP_MIN_INTERVAL_MS });
  await cleanup.run();
  time += CLEANUP_MIN_INTERVAL_MS;
  fake.hooks.beforeList = () => { throw new BidManagerError('server_error'); };
  assert.deepEqual((await cleanup.run()).warnings, [RESET_WARNING]);
  fake.hooks.beforeList = undefined;
  assert.equal((await cleanup.run()).status, 'completed');
  assert.equal(fake.listCalls[3].pageToken, undefined);
});

test('a concurrent skip does not touch the clock and the interval starts at completion', async () => {
  const fake = fakeClient([]);
  const gate = deferred();
  fake.hooks.beforeList = () => gate.promise;
  let time = NOW.getTime();
  let reads = 0;
  const cleanup = createQueryCleanup(fake.client, {
    now: () => { reads++; return new Date(time); }, minIntervalMs: CLEANUP_MIN_INTERVAL_MS,
  });
  const first = cleanup.run();
  const beforeSkip = reads;
  assert.equal((await cleanup.run()).status, 'skipped');
  assert.equal(reads, beforeSkip);
  time += 60_000;
  gate.resolve();
  await first;
  time += CLEANUP_MIN_INTERVAL_MS - 1;
  assert.equal((await cleanup.run()).status, 'skipped');
  assert.equal(fake.listCalls.length, 1);
  time++;
  assert.equal((await cleanup.run()).status, 'completed');
});

test('a deadline at or before entry starts no requests or throttle interval', async () => {
  for (const deadline of [NOW.getTime(), NOW.getTime() - 1]) {
    const fake = fakeClient([]);
    const cleanup = createQueryCleanup(fake.client, { now: () => NOW, minIntervalMs: CLEANUP_MIN_INTERVAL_MS });
    assert.deepEqual(await cleanup.run({ deadline }), { status: 'completed', deletedQueryIds: [], warnings: [] });
    assert.equal(fake.listCalls.length, 0);
    assert.equal((await cleanup.run()).status, 'completed');
    assert.equal(fake.listCalls.length, 1);
  }
});

test('a deadline between deletes keeps the current page and permits an immediate retry', async () => {
  const fake = fakeClient([...teamQueries(100), ...oldQueries(3, 101)]);
  let time = NOW.getTime();
  const deadline = time + 1000;
  fake.hooks.beforeDelete = () => { time = deadline; };
  const cleanup = createQueryCleanup(fake.client, { now: () => new Date(time), minIntervalMs: CLEANUP_MIN_INTERVAL_MS });
  assert.deepEqual(await cleanup.run({ deadline }), { status: 'completed', deletedQueryIds: ['101'], warnings: [] });
  assert.deepEqual(fake.deleteCalls, ['101']);
  fake.hooks.beforeDelete = undefined;
  assert.deepEqual((await cleanup.run()).deletedQueryIds, ['102', '103']);
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+100=');
});

test('a deadline after a list prevents the next page request and retains its cursor', async () => {
  const fake = fakeClient(teamQueries(201));
  let time = NOW.getTime();
  const deadline = time + 1000;
  fake.hooks.beforeList = () => { time = deadline; };
  const cleanup = createQueryCleanup(fake.client, { now: () => new Date(time), minIntervalMs: CLEANUP_MIN_INTERVAL_MS });
  assert.deepEqual(await cleanup.run({ deadline }), { status: 'completed', deletedQueryIds: [], warnings: [] });
  assert.equal(fake.listCalls.length, 1);
  fake.hooks.beforeList = undefined;
  assert.equal((await cleanup.run()).status, 'completed');
  assert.equal(fake.listCalls[1].pageToken, 'opaque/+100=');
});

function query(id: number, title = 'Team report'): Query {
  return { queryId: String(id), metadata: { title } };
}

function teamQueries(count: number, firstId = 1): Query[] {
  return Array.from({ length: count }, (_, index) => query(firstId + index));
}

function oldQueries(count: number, firstId = 1): Query[] {
  return Array.from({ length: count }, (_, index) => query(firstId + index, OLD_TITLE));
}

// Tokens are opaque to cleanup; this fake models mutable offset-based pagination.
function fakeClient(initialQueries: readonly Query[]) {
  const queries = [...initialQueries];
  const listCalls: ListQueriesOptions[] = [];
  const deleteCalls: string[] = [];
  const positions = new Map<string, number>();
  const hooks: {
    beforeList?: (options: ListQueriesOptions) => void | Promise<void>;
    beforeDelete?: (id: string) => void | Promise<void>;
  } = {};
  const client: Pick<BidManagerClient, 'listQueries' | 'deleteQuery'> = {
    async listQueries(options = {}) {
      listCalls.push({ ...options });
      await hooks.beforeList?.(options);
      assert.equal(options.pageSize, 100);
      assert.equal(options.orderBy, 'queryId');
      const offset = options.pageToken === undefined ? 0 : positions.get(options.pageToken);
      assert.notEqual(offset, undefined, 'fake received an unknown page token');
      const end = offset! + options.pageSize;
      const pageQueries = queries.slice(offset, end);
      if (end >= queries.length) return { queries: pageQueries };
      const token = `opaque/+${end}=`;
      positions.set(token, end);
      return { queries: pageQueries, nextPageToken: token };
    },
    async deleteQuery(id) {
      deleteCalls.push(id);
      await hooks.beforeDelete?.(id);
      const index = queries.findIndex(item => item.queryId === id);
      if (index !== -1) queries.splice(index, 1);
    },
  };
  return { client, queries, listCalls, deleteCalls, hooks };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

test('successive bounded runs pass 300 team queries and delete only the three expired MCP queries', async () => {
  const fake = fakeClient([...teamQueries(300), ...oldQueries(3, 301)]);
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [] });
  assert.equal(fake.listCalls.length, 2);
  assert.deepEqual(await cleanup.run(), {
    status: 'completed', deletedQueryIds: ['301', '302', '303'], warnings: [],
  });
  assert.equal(fake.listCalls.length, 4);
  assert.deepEqual(fake.deleteCalls, ['301', '302', '303']);
  assert.deepEqual(fake.queries, teamQueries(300));
});

for (const teamCount of [0, 100]) {
  test(`five-delete cap retains the current page token with ${teamCount} preceding team queries`, async () => {
    const fake = fakeClient([...teamQueries(teamCount), ...oldQueries(8, teamCount + 1)]);
    const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
    const first = await cleanup.run();
    assert.deepEqual(first.deletedQueryIds, Array.from({ length: 5 }, (_, i) => String(teamCount + i + 1)));
    assert.equal(fake.deleteCalls.length, 5);
    const retainedToken = fake.listCalls.at(-1)?.pageToken;
    const priorLists = fake.listCalls.length;
    const second = await cleanup.run();
    assert.deepEqual(second.deletedQueryIds, Array.from({ length: 3 }, (_, i) => String(teamCount + i + 6)));
    assert.equal(fake.listCalls[priorLists].pageToken, retainedToken);
    assert.equal(fake.listCalls.length - priorLists, 1);
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(second.warnings, []);
  });
}

test('exactly five eligible queries finish the page and advance even when the run exhausts both budgets', async () => {
  const fake = fakeClient([...teamQueries(100), ...oldQueries(5, 101), ...teamQueries(200, 106)]);
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual((await cleanup.run()).deletedQueryIds, ['101', '102', '103', '104', '105']);
  assert.equal(fake.listCalls.length, 2);
  assert.deepEqual((await cleanup.run()).warnings, []);
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+200=');
});

test('a cap reached on the first page still finishes it and reads at most one further page', async () => {
  const fake = fakeClient([...oldQueries(5), ...teamQueries(95, 6), ...oldQueries(8, 101)]);
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.equal((await cleanup.run()).deletedQueryIds.length, 5);
  assert.equal(fake.listCalls.length, 2);
  assert.equal(fake.deleteCalls.length, 5);
  assert.equal(fake.listCalls[1].pageToken, 'opaque/+100=');
  await cleanup.run();
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+100=');
});

test('end of the last page wraps for the next run without reading the first page again', async () => {
  const fake = fakeClient(teamQueries(101));
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  await cleanup.run();
  assert.equal(fake.listCalls.length, 2);
  await cleanup.run();
  assert.equal(fake.listCalls[2].pageToken, undefined);
  assert.equal(fake.listCalls.length, 4);
});

test('an empty page with a next token advances and an empty final page wraps', async () => {
  const calls: ListQueriesOptions[] = [];
  const cleanup = createQueryCleanup({
    async listQueries(options = {}) {
      calls.push(options);
      return options.pageToken === undefined ? { queries: [], nextPageToken: 'opaque-next' } : { queries: [] };
    },
    async deleteQuery() { assert.fail('empty pages must not delete'); },
  }, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [] });
  assert.deepEqual(calls.map(call => call.pageToken), [undefined, 'opaque-next']);
  await cleanup.run();
  assert.equal(calls[2].pageToken, undefined);
});

test('invalid_request while listing a saved token resets the cursor and ends the run', async () => {
  const fake = fakeClient(teamQueries(301));
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  await cleanup.run();
  fake.hooks.beforeList = () => { throw new BidManagerError('invalid_request', 'private details'); };
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [RESET_WARNING] });
  assert.equal(fake.listCalls.length, 3);
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+200=');
  fake.hooks.beforeList = undefined;
  await cleanup.run();
  assert.equal(fake.listCalls[3].pageToken, undefined);
});

test('invalid_request without a saved token returns only the generic warning', async () => {
  const fake = fakeClient([]);
  fake.hooks.beforeList = () => { throw new BidManagerError('invalid_request'); };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [GENERIC_WARNING] });
  fake.hooks.beforeList = undefined;
  assert.deepEqual((await cleanup.run()).warnings, []);
  assert.equal(fake.listCalls[1].pageToken, undefined);
});

test('server_error while listing a saved token resets the cursor and ends the run', async () => {
  const fake = fakeClient(teamQueries(301));
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  await cleanup.run();
  fake.hooks.beforeList = () => { throw new BidManagerError('server_error', 'private details'); };
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [RESET_WARNING] });
  assert.equal(fake.listCalls.length, 3);
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+200=');
  assert.deepEqual(fake.deleteCalls, []);
  fake.hooks.beforeList = undefined;
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [] });
  assert.equal(fake.listCalls[3].pageToken, undefined);
});

test('server_error without a saved token gives the generic warning and retries the first page', async () => {
  const fake = fakeClient([]);
  fake.hooks.beforeList = () => { throw new BidManagerError('server_error', 'private details'); };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [GENERIC_WARNING] });
  assert.equal(fake.listCalls.length, 1);
  assert.equal(fake.listCalls[0].pageToken, undefined);
  fake.hooks.beforeList = undefined;
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [] });
  assert.equal(fake.listCalls.length, 2);
  assert.equal(fake.listCalls[1].pageToken, undefined);
});

for (const [label, failure] of [
  ['timeout', new BidManagerError('timeout')],
  ['network', new BidManagerError('network')],
  ['rate_limited', new BidManagerError('rate_limited')],
  ['resource_exhausted', new BidManagerError('resource_exhausted')],
  ['GoogleCredentialsError', new GoogleCredentialsError('expired_or_revoked')],
] as const) {
  test(`${label} while listing a saved token gives the generic warning and reuses that token`, async () => {
    const fake = fakeClient(teamQueries(301));
    const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
    await cleanup.run();
    fake.hooks.beforeList = () => { throw failure; };
    assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [GENERIC_WARNING] });
    assert.equal(fake.listCalls.length, 3);
    assert.equal(fake.listCalls[2].pageToken, 'opaque/+200=');
    assert.deepEqual(fake.deleteCalls, []);
    fake.hooks.beforeList = undefined;
    assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [] });
    assert.equal(fake.listCalls[3].pageToken, 'opaque/+200=');
  });
}

test('server_error on the second page resets the cursor while preserving completed deletions', async () => {
  const fake = fakeClient([...oldQueries(1), ...teamQueries(200, 2)]);
  fake.hooks.beforeList = options => {
    if (options.pageToken !== undefined) throw new BidManagerError('server_error');
  };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), {
    status: 'completed', deletedQueryIds: ['1'], warnings: [RESET_WARNING],
  });
  assert.deepEqual(fake.listCalls.map(call => call.pageToken), [undefined, 'opaque/+100=']);
  assert.deepEqual(fake.deleteCalls, ['1']);
  fake.hooks.beforeList = undefined;
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [] });
  assert.equal(fake.listCalls[2].pageToken, undefined);
  assert.deepEqual(fake.deleteCalls, ['1']);
});

test('server_error during delete keeps the page cursor and reports only completed deletions', async () => {
  const fake = fakeClient([...teamQueries(100), ...oldQueries(3, 101)]);
  fake.hooks.beforeDelete = id => {
    if (id === '102') throw new BidManagerError('server_error', 'private details');
  };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), {
    status: 'completed', deletedQueryIds: ['101'], warnings: [GENERIC_WARNING],
  });
  assert.equal(fake.listCalls.length, 2);
  assert.deepEqual(fake.deleteCalls, ['101', '102']);
  fake.hooks.beforeDelete = undefined;
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: ['102', '103'], warnings: [] });
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+100=');
  assert.deepEqual(fake.deleteCalls, ['101', '102', '102', '103']);
});

test('concurrent calls skip immediately while listing and the flag clears after success', async () => {
  const fake = fakeClient([]);
  const gate = deferred();
  fake.hooks.beforeList = () => gate.promise;
  let clockCalls = 0;
  const cleanup = createQueryCleanup(fake.client, { now: () => { clockCalls++; return NOW; } });
  const first = cleanup.run();
  assert.deepEqual(await cleanup.run(), { status: 'skipped', deletedQueryIds: [], warnings: [] });
  assert.equal(fake.listCalls.length, 1);
  assert.equal(clockCalls, 1);
  gate.resolve();
  assert.deepEqual((await first).warnings, []);
  await cleanup.run();
  assert.equal(fake.listCalls.length, 2);
  assert.equal(clockCalls, 2);
});

test('the concurrency guard also covers a pending delete and clears after its rejection', async () => {
  const fake = fakeClient(oldQueries(1));
  const entered = deferred();
  const release = deferred();
  fake.hooks.beforeDelete = async () => { entered.resolve(); await release.promise; throw 'private failure'; };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  const first = cleanup.run();
  await entered.promise;
  assert.deepEqual(await cleanup.run(), { status: 'skipped', deletedQueryIds: [], warnings: [] });
  assert.equal(fake.listCalls.length, 1);
  assert.equal(fake.deleteCalls.length, 1);
  release.resolve();
  assert.deepEqual((await first).warnings, [GENERIC_WARNING]);
  fake.hooks.beforeDelete = undefined;
  assert.deepEqual((await cleanup.run()).deletedQueryIds, ['1']);
});

test('not_found counts as deleted, consumes the cap, and allows subsequent candidates', async () => {
  const fake = fakeClient(oldQueries(8));
  fake.hooks.beforeDelete = id => {
    if (id === '1') throw new BidManagerError('not_found');
  };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), {
    status: 'completed', deletedQueryIds: ['1', '2', '3', '4', '5'], warnings: [],
  });
  assert.deepEqual(fake.deleteCalls, ['1', '2', '3', '4', '5']);
});

test('a delete failure preserves successful IDs, stops immediately, and retains the failing page token', async () => {
  const fake = fakeClient([...teamQueries(100), ...oldQueries(3, 101)]);
  fake.hooks.beforeDelete = id => {
    if (id === '102') throw new BidManagerError('invalid_request', 'private details');
  };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), {
    status: 'completed', deletedQueryIds: ['101'], warnings: [GENERIC_WARNING],
  });
  assert.deepEqual(fake.deleteCalls, ['101', '102']);
  fake.hooks.beforeDelete = undefined;
  assert.deepEqual((await cleanup.run()).deletedQueryIds, ['102', '103']);
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+100=');
});

test('a list failure on the next page preserves deletions already completed and keeps that page token', async () => {
  const fake = fakeClient([...oldQueries(1), ...teamQueries(200, 2)]);
  fake.hooks.beforeList = options => {
    if (options.pageToken !== undefined) throw new BidManagerError('network');
  };
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual(await cleanup.run(), {
    status: 'completed', deletedQueryIds: ['1'], warnings: [GENERIC_WARNING],
  });
  fake.hooks.beforeList = undefined;
  await cleanup.run();
  assert.equal(fake.listCalls[2].pageToken, 'opaque/+100=');
});

test('only strictly expired parseable MCP titles are deleted', async () => {
  const kept = [
    'Team report',
    '[mcp] old report 2026-10-01T12:00:00Z',
    '[MCP] no timestamp',
    '[MCP] invalid calendar 2026-02-30T12:00:00Z',
    '[MCP] milliseconds 2026-10-01T12:00:00.000Z',
    '[MCP] exact boundary 2026-10-30T12:00:00Z',
    '[MCP] recent 2026-11-01T12:00:00Z',
    '[MCP] future 2027-01-01T00:00:00Z',
  ];
  const fake = fakeClient([...kept.map((title, i) => query(i + 1, title)), query(9, OLD_TITLE)]);
  const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
  assert.deepEqual((await cleanup.run()).deletedQueryIds, ['9']);
  assert.deepEqual(fake.deleteCalls, ['9']);
  assert.deepEqual(fake.queries.map(item => item.metadata.title), kept);
});

test('the clock is read once and its instant is shared by both pages', async () => {
  const fake = fakeClient([
    ...teamQueries(100),
    query(101, '[MCP] boundary 2026-10-30T12:00:00Z'),
  ]);
  let clockCalls = 0;
  const cleanup = createQueryCleanup(fake.client, {
    now: () => { clockCalls++; return new Date(NOW.getTime() + (clockCalls - 1) * 1000); },
  });
  assert.deepEqual((await cleanup.run()).deletedQueryIds, []);
  assert.equal(clockCalls, 1);
  assert.deepEqual((await cleanup.run()).deletedQueryIds, ['101']);
  assert.equal(clockCalls, 2);
});

test('the default clock can clean up without an injected dependency', async () => {
  const fake = fakeClient([query(1, '[MCP] ancient 2000-01-01T00:00:00Z')]);
  assert.deepEqual((await createQueryCleanup(fake.client).run()).deletedQueryIds, ['1']);
});

test('a throwing clock resolves safely and does not leave the guard locked', async () => {
  const fake = fakeClient([]);
  let fail = true;
  const cleanup = createQueryCleanup(fake.client, {
    now: () => { if (fail) throw new Error('private clock failure'); return NOW; },
  });
  assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [GENERIC_WARNING] });
  assert.equal(fake.listCalls.length, 0);
  fail = false;
  assert.deepEqual((await cleanup.run()).warnings, []);
});

test('separate cleanup instances have independent cursors and running flags', async () => {
  const firstFake = fakeClient(teamQueries(301));
  const secondFake = fakeClient([]);
  const first = createQueryCleanup(firstFake.client, { now: () => NOW });
  const second = createQueryCleanup(secondFake.client, { now: () => NOW });
  await first.run();
  const gate = deferred();
  firstFake.hooks.beforeList = () => gate.promise;
  const pending = first.run();
  assert.deepEqual((await second.run()).warnings, []);
  assert.equal(secondFake.listCalls[0].pageToken, undefined);
  assert.equal(firstFake.listCalls[2].pageToken, 'opaque/+200=');
  gate.resolve();
  await pending;
});

for (const [label, failure] of [
  ['credential error', new GoogleCredentialsError('expired_or_revoked')],
  ['plain Error', new Error('private error details')],
  ['non-Error value', { private: 'do not expose' }],
] as const) {
  for (const operation of ['list', 'delete'] as const) {
    test(`${operation} throwing a ${label} resolves with one fixed warning and preserves its cursor`, async () => {
      const fake = fakeClient([...teamQueries(100), ...oldQueries(1, 101)]);
      const cleanup = createQueryCleanup(fake.client, { now: () => NOW });
      if (operation === 'list') {
        fake.hooks.beforeList = options => { if (options.pageToken !== undefined) throw failure; };
      } else {
        fake.hooks.beforeDelete = () => { throw failure; };
      }
      assert.deepEqual(await cleanup.run(), { status: 'completed', deletedQueryIds: [], warnings: [GENERIC_WARNING] });
      fake.hooks.beforeList = undefined;
      fake.hooks.beforeDelete = undefined;
      assert.deepEqual((await cleanup.run()).deletedQueryIds, ['101']);
      assert.equal(fake.listCalls[2].pageToken, 'opaque/+100=');
    });
  }
}

test('every cleanup call is a single attempt carrying the caller signal and deadline', async () => {
  const seen: [string, unknown][] = [];
  const client: Pick<BidManagerClient, 'listQueries' | 'deleteQuery'> = {
    async listQueries(_options, call) { seen.push(['list', call]); return { queries: [query(1, OLD_TITLE), query(2, OLD_TITLE)] }; },
    async deleteQuery(_id, call) { seen.push(['delete', call]); },
  };
  const signal = new AbortController().signal;
  const result = await createQueryCleanup(client, { now: () => NOW }).run({ signal, deadline: NOW.getTime() + 45_000 });
  assert.deepEqual(result.deletedQueryIds, ['1', '2']);
  const expected = { signal, deadline: NOW.getTime() + 45_000, singleAttempt: true };
  assert.deepEqual(seen, [['list', expected], ['delete', expected], ['delete', expected]]);
});

test('cleanup without call options still makes single attempts', async () => {
  const seen: unknown[] = [];
  const client: Pick<BidManagerClient, 'listQueries' | 'deleteQuery'> = {
    async listQueries(_options, call) { seen.push(call); return { queries: [] }; },
    async deleteQuery() { assert.fail('nothing to delete'); },
  };
  await createQueryCleanup(client, { now: () => NOW }).run();
  assert.deepEqual(seen, [{ singleAttempt: true }]);
});

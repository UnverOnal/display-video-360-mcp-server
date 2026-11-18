// Shared harness for the composition tests (logging.test.ts, reliability.test.ts, request-counts.test.ts): the real tool handlers,
// services, clients and request loop behind the real MCP server, against a scripted fake Google.
// No tests of its own. The .test.ts suffix keeps it out of boundaries.test.ts's scan, which would flag the real factories used here.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from './server.js';
import { createToolRunner } from './tools/call.js';
import type { AuthorizedFetch } from './integrations/google/auth.js';
import { createJsonLogger } from './integrations/google/log.js';
import { createBidManagerClient } from './integrations/bidmanager/client.js';
import { createQueryCleanup } from './integrations/bidmanager/cleanup.js';
import { createReportingService } from './integrations/bidmanager/reporting.js';
import type { ReportPage } from './integrations/bidmanager/report-file.js';
import { createDv360Client } from './integrations/dv360/client.js';
import { createMetadataService } from './integrations/dv360/metadata.js';
import { createPerformanceService } from './combined/performance.js';
import { YOUTUBE_FILTER_LEVELS } from './combined/presets.js';

export const markers = ['MRK-tok-abc/xyz', 'MRK-name-def/ghi', 'privateTokenABC123', 'CUSTOMER_SECRET', 'legacyPrivateABC456', 'privateKindXYZ789'];
export const [token, title, reason, status, legacy, kind] = markers;
export const ids = ['987654321012', '987654321013', '987654321014'];
export const [queryId, reportId, advertiserId] = ids;
export const fileUrl = `https://storage.googleapis.com/${token}?Signature=${title}`;
export const query = { queryId, metadata: { title, format: 'XLSX', dataRange: { range: 'PREVIOUS_DAY' } }, params: { type: 'STANDARD', groupBys: ['FILTER_ADVERTISER'] } };
export const report = { key: { queryId, reportId }, metadata: { status: { state: 'DONE', format: 'XLSX' }, googleCloudStoragePath: fileUrl }, params: query.params };
export const page: ReportPage = {
  format: 'XLSX', header: [], rows: [], text: title, totalRows: 0, offset: 0, returnedRows: 0,
  truncated: false, cellsShortened: false, metadata: { groupBy: [], filters: [] }, warnings: [], notes: [], fileBytes: 1,
};
export const json = (value: unknown, code = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status: code, headers });
export function googleError(code: number, googleStatus = status, googleReason = reason,
  headers: Record<string, string> | undefined = code === 429 ? { 'retry-after': '1' } : undefined) {
  return json({ error: { code, status: googleStatus, message: title,
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: googleReason, domain: token, metadata: { secret: title } }],
    errors: [{ reason: legacy, message: token, domain: title }],
  } }, code, headers);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * One scripted Google response. `takes` advances the fake clock before answering; with mocked timeouts,
 * a step that takes longer than its attempt's timeout (or has `timesOut`) instead advances the clock by
 * that timeout and throws a `TimeoutError`, as a real fetch would.
 */
export type Step = {
  path: string; method?: string; takes?: number; timesOut?: boolean;
  respond?: (url: URL, body?: string) => Response | Promise<Response>; check?: (url: URL, body?: string) => void;
};

export type FakeRequest = {
  readonly url: URL; readonly method?: string; readonly body?: string;
  readonly at: number;                 // fake-clock time the request started
  readonly signal?: AbortSignal;       // the signal the request loop passed to fetch
  readonly timeoutMs?: number;         // the attempt's timeout, when timeouts are mocked
};

/** A sleep held until the test releases it (advancing the clock by `ms`) or its signal aborts. */
export type HeldSleep = { readonly ms: number; readonly signal?: AbortSignal; release(): void };

export type LogEventLine = { readonly type: string; readonly callId?: string } & Record<string, unknown>;

export type CompositionOptions = {
  readonly random?: () => number;      // default () => 0
  readonly heldSleeps?: boolean;       // default false: every sleep is instant and advances the clock
  readonly mockTimeouts?: boolean;     // mock AbortSignal.timeout and record each requested delay
  readonly cleanupMinIntervalMs?: number; // default 0: preserve unthrottled cleanup in existing cases
};

export const START = Date.parse('2026-11-13T12:00:00Z');

export async function composition(t: TestContext, options: CompositionOptions = {}) {
  let clock = START;
  const lines: string[] = [];
  const requests: FakeRequest[] = [];
  const steps: Step[] = [];
  const readers: (() => ReportPage)[] = [];
  const reads: { url: string; limit?: number; offset?: number }[] = [];
  const sleeps: number[] = [];
  const timeouts: number[] = [];
  const held: HeldSleep[] = [];
  const sleepWaiters: ((sleep: HeldSleep) => void)[] = [];
  const watchers: { match: (event: LogEventLine) => boolean; resolve: (event: LogEventLine) => void }[] = [];

  if (options.mockTimeouts) {
    t.mock.method(AbortSignal, 'timeout', (delay: number) => { timeouts.push(delay); return new AbortController().signal; });
  }
  const log = createJsonLogger({ now: () => clock, write: line => {
    lines.push(line);
    const event = JSON.parse(line) as LogEventLine;
    for (const watcher of [...watchers]) {
      if (watcher.match(event)) { watchers.splice(watchers.indexOf(watcher), 1); watcher.resolve(event); }
    }
  } });
  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    sleeps.push(ms);
    if (!options.heldSleeps) { clock += ms; return Promise.resolve(); }
    return new Promise(resolve => {
      let settled = false;
      const finish = (advance: boolean) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (advance) clock += ms;
        resolve();
      };
      const onAbort = () => finish(false);
      const entry: HeldSleep = { ms, signal, release: () => finish(true) };
      const waiter = sleepWaiters.shift();
      if (waiter) waiter(entry); else held.push(entry);
      if (signal?.aborted) finish(false); else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  const runtime = { now: () => clock, random: options.random ?? (() => 0), sleep, logger: log };
  const fetch: AuthorizedFetch = async (raw, init) => {
    const url = new URL(raw);
    const timeoutMs = options.mockTimeouts ? timeouts.at(-1) : undefined;
    requests.push({ url, method: init?.method, body: init?.body, at: clock, signal: init?.signal, timeoutMs });
    const step = steps.shift();
    assert.ok(step, `unexpected fake request: ${url.pathname}`);
    assert.equal(url.pathname, step.path);
    assert.equal(init?.method, step.method ?? 'GET');
    step.check?.(url, init?.body);
    const limit = timeoutMs ?? Number.POSITIVE_INFINITY;
    if (step.timesOut || (step.takes ?? 0) > limit) {
      assert.ok(Number.isFinite(limit), 'a timing-out step needs mockTimeouts');
      clock += limit;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    clock += step.takes ?? 0;
    assert.ok(step.respond, `step ${step.path} has no response`);
    return step.respond(url, init?.body);
  };
  const bidmanager = createBidManagerClient(fetch, { runtime });
  const now = () => new Date(clock);
  const reporting = createReportingService({ client: bidmanager, cleanup: createQueryCleanup(bidmanager, { now, minIntervalMs: options.cleanupMinIntervalMs ?? 0 }), now,
    random: runtime.random, sleep: runtime.sleep, readReportFile: async request => {
      reads.push({ url: request.url, limit: request.limit, offset: request.offset });
      assert.equal(request.url, fileUrl);
      const read = readers.shift();
      assert.ok(read, 'unexpected reader invocation');
      return read();
    } });
  const metadata = createMetadataService({ client: createDv360Client(fetch, { runtime }), now });
  const performance = createPerformanceService({ metadata, reporting, youtubeFilterLevels: YOUTUBE_FILTER_LEVELS, now });
  const deps = { performance, reporting, metadata, runTool: createToolRunner({ log, now: runtime.now }) };
  const server = createServer(deps);
  const client = new Client({ name: 'redaction-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const callIds = new Set<string>();
  const claimed = new Set<string>();
  async function call(name: string, args: Record<string, unknown> = {}) {
    const start = lines.length;
    const result = await client.callTool({ name, arguments: args });
    const events = lines.slice(start).map(line => JSON.parse(line));
    const tools = events.filter(event => event.type === 'tool.call');
    assert.equal(tools.length, 1, name);
    const tool = tools[0];
    assert.equal(tool.tool, name);
    assert.match(tool.callId, /^[0-9a-f]{16}$/);
    assert.ok(!callIds.has(tool.callId));
    callIds.add(tool.callId);
    for (const event of events) assert.equal(event.callId, tool.callId, event.type);
    assert.equal(events.at(-1), tool);
    assert.equal(steps.length, 0, `${name} did not consume its fake responses`);
    return { result, events, tool, text: JSON.stringify(result.content) };
  }

  /** Resolves with the next logged event that matches. */
  function nextEvent(match: (event: LogEventLine) => boolean): Promise<LogEventLine> {
    return new Promise(resolve => { watchers.push({ match, resolve }); });
  }
  /**
   * Starts a call without the sequential helper's assertions. `result` is the client promise (a rejection,
   * e.g. a cancelled call, is handled); `logged` is the server-completion barrier: the call's `tool.call` line.
   */
  function start(name: string, args: Record<string, unknown> = {}, callOptions: { signal?: AbortSignal } = {}) {
    // Each barrier claims its own line, so concurrent calls of the same tool get different ones.
    const logged = nextEvent(event => {
      if (event.type !== 'tool.call' || event.tool !== name || claimed.has(event.callId as string)) return false;
      claimed.add(event.callId as string);
      return true;
    });
    const result = client.callTool({ name, arguments: args }, callOptions);
    result.catch(() => {});
    return { result, logged };
  }
  /** Every logged event of one call, correlated by call ID (never by position). */
  function eventsOf(callId: string): LogEventLine[] {
    return lines.map(line => JSON.parse(line) as LogEventLine).filter(event => event.callId === callId);
  }
  /** Resolves with the next sleep that enters (or one already waiting). Held-sleep mode only. */
  function nextSleep(): Promise<HeldSleep> {
    const entry = held.shift();
    return entry ? Promise.resolve(entry) : new Promise(resolve => { sleepWaiters.push(resolve); });
  }

  return {
    lines, requests, steps, readers, reads, call, client, sleeps, timeouts, deps,
    now: () => clock, advance: (ms: number) => { clock += ms; },
    start, nextEvent, eventsOf, nextSleep,
  };
}

export function checkRedaction(lines: string[]) {
  const common = ['ts', 'type', 'callId'];
  const fields: Record<string, string[]> = {
    'tool.call': ['tool', 'outcome', 'durationMs', 'errorClass', 'kind'],
    'google.request': ['api', 'operation', 'attempt', 'durationMs', 'outcome', 'httpStatus', 'status', 'reasons'],
    'google.retry': ['api', 'operation', 'attempt', 'kind', 'delayMs'],
    'google.give_up': ['api', 'operation', 'attempts', 'kind', 'reason'],
    'google.latched': ['api', 'operation', 'untilMs'],
    'google.latch_blocked': ['api', 'operation'],
  };
  for (const line of lines) {
    assert.ok(line.endsWith('\n'));
    assert.equal(line.trim().split('\n').length, 1);
    const event = JSON.parse(line);
    assert.equal(new Date(event.ts).toISOString(), event.ts);
    assert.deepEqual(Object.keys(event).slice(0, 2), ['ts', 'type']);
    assert.ok(fields[event.type], event.type);
    for (const key of Object.keys(event)) assert.ok([...common, ...fields[event.type]].includes(key), key);
    for (const marker of markers) for (const form of [marker, encodeURIComponent(marker), Buffer.from(marker).toString('base64url')]) {
      assert.ok(!line.includes(form), `marker leaked in ${event.type}`);
    }
    for (const id of ids) assert.ok(!line.includes(id), `numeric ID leaked in ${event.type}`);
  }
}

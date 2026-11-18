import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createJsonLogger, LOGGED_REASONS, LOGGED_STATUSES } from './log.js';

test('JSON logger emits one ISO timestamped newline per event with ts and type first', () => {
  const lines: string[] = [];
  const log = createJsonLogger({ write: line => { lines.push(line); }, now: () => 0 });
  log({ type: 'google.request', attempt: 1, callId: undefined });
  log({ type: 'tool.call', tool: 'health' });
  assert.deepEqual(lines, [
    '{"ts":"1970-01-01T00:00:00.000Z","type":"google.request","attempt":1}\n',
    '{"ts":"1970-01-01T00:00:00.000Z","type":"tool.call","tool":"health"}\n',
  ]);
});

test('JSON logger swallows throwing writers and clocks', () => {
  assert.doesNotThrow(() => createJsonLogger({ now: () => 0, write: () => { throw new Error('EPIPE'); } })({ type: 'test' }));
  let writes = 0;
  assert.doesNotThrow(() => createJsonLogger({ now: () => { throw new Error('clock'); }, write: () => { writes++; } })({ type: 'test' }));
  assert.equal(writes, 0);
});

test('logged reasons match the private classifier 403 table and statuses match google.rpc.Code', () => {
  // The classifier table is private: compare a literal contract and its source table.
  const reasons = ['USER_PROJECT_DENIED', 'SERVICE_DISABLED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'dailyLimitExceeded', 'userRateLimitExceeded'];
  assert.deepEqual(LOGGED_REASONS, reasons);
  const source = readFileSync(new URL('./errors.ts', import.meta.url), 'utf8');
  const table = source.slice(source.indexOf('const FORBIDDEN_REASONS'), source.indexOf('function isObject'));
  assert.deepEqual([...table.matchAll(/\['([^']+)',/g)].map(match => match[1]), reasons);
  assert.deepEqual(LOGGED_STATUSES, ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS']);
});

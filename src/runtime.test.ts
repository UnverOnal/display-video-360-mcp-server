import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LogLine } from './integrations/google/log.js';
import { createRuntime } from './runtime.js';

test('createRuntime builds once and hands out a new server per call, without logging or calling Google', () => {
  const events: LogLine[] = [];
  const runtime = createRuntime({ googleCloudQuotaProject: 'test-quota-project' }, { log: event => { events.push(event); } });
  const first = runtime.createMcpServer();
  const second = runtime.createMcpServer();
  assert.notEqual(first, second);
  assert.deepEqual(events, []);
});

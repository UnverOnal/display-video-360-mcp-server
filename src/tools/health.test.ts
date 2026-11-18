import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHealthResult, healthOutputSchema } from './health.js';

test('health result reports the supplied version and timestamp', () => {
  const result = buildHealthResult('1.2.3', new Date('2026-01-02T03:04:05.000Z'));
  assert.deepEqual(result.structuredContent, {
    status: 'ok',
    serverVersion: '1.2.3',
    timestamp: '2026-01-02T03:04:05.000Z',
  });
});

test('health text matches its structured content', () => {
  const result = buildHealthResult('1.2.3', new Date('2026-01-02T03:04:05.000Z'));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('health result satisfies its declared output schema', () => {
  const result = buildHealthResult('1.2.3', new Date('2026-01-02T03:04:05.000Z'));
  assert.deepEqual(healthOutputSchema.parse(result.structuredContent), result.structuredContent);
});

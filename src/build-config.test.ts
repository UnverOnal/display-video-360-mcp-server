import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('production build config extends the full config and excludes tests', () => {
  const config = JSON.parse(readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8'));
  assert.equal(config.extends, './tsconfig.json');
  assert.ok(config.exclude.includes('src/**/*.test.ts'));
});

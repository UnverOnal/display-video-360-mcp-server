import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from './config.js';

test('reads only the quota project', () => {
  const config = loadConfig({
    GOOGLE_CLOUD_QUOTA_PROJECT: 'test-quota-project', PORT: '8080', MCP_BIND_ADDRESS: '0.0.0.0', AUTH0_ISSUER: 'https://auth.example.test',
  });
  assert.deepEqual(config, { googleCloudQuotaProject: 'test-quota-project' });
});

for (const input of ['test-quota-project', ' test-quota-project ', 'abcdef', 'a' + 'b'.repeat(28) + 'c']) {
  test(`accepts quota project ${JSON.stringify(input)}`, () => {
    assert.equal(loadConfig({ GOOGLE_CLOUD_QUOTA_PROJECT: input }).googleCloudQuotaProject, input.trim());
  });
}

for (const input of [undefined, '', '   ', 'abcde', 'a'.repeat(31), 'Test-project',
  '1test-project', 'test-project-', 'test_project', 'test.project']) {
  test(`rejects quota project ${JSON.stringify(input)}`, () => {
    assert.throws(() => loadConfig({ GOOGLE_CLOUD_QUOTA_PROJECT: input }), {
      message: `GOOGLE_CLOUD_QUOTA_PROJECT must be a Google Cloud project ID (received ${JSON.stringify(input)})`,
    });
  });
}

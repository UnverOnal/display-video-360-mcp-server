import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import packageJson from '../package.json' with { type: 'json' };
import { createServer } from './server.js';

const fakeDeps = { reporting: {
  async startAdHocReport() { throw new Error('Unexpected reporting call'); },
  async startSavedReport() { throw new Error('Unexpected reporting call'); },
  async collectReport() { throw new Error('Unexpected reporting call'); },
  async listSavedQueries() { throw new Error('Unexpected reporting call'); },
}, metadata: {
  async list() { throw new Error('Unexpected metadata call'); },
  async get() { throw new Error('Unexpected metadata call'); },
  async find() { throw new Error('Unexpected metadata call'); },
  async describeTarget() { throw new Error('Unexpected metadata call'); },
}, performance: { async getPerformance() { throw new Error('Unexpected performance call'); } } };

async function connectClient(t: TestContext): Promise<Client> {
  const server = createServer(fakeDeps);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  t.after(() => client.close());
  t.after(() => server.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('server reports its name and package version during initialization', async t => {
  const client = await connectClient(t);
  assert.deepEqual(client.getServerVersion(), {
    name: 'display-video-360-mcp-server',
    version: packageJson.version,
  });
});

test('server lists health, the five reporting tools, and the seven metadata tools', async t => {
  const client = await connectClient(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [
    'health', 'list_report_fields', 'run_report', 'run_saved_report', 'get_report', 'list_saved_reports',
    'list_partners', 'list_advertisers', 'list_campaigns', 'list_insertion_orders', 'list_line_items', 'get_metadata', 'find_entities', 'get_performance',
  ]);
  assert.equal(tools[0].name, 'health');
  assert.ok(tools[0].outputSchema);
});

test('health tool succeeds through the in-memory MCP client', async t => {
  const client = await connectClient(t);
  const result = await client.callTool({ name: 'health', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent);
  const output = result.structuredContent as Record<string, unknown>;
  assert.equal(output.status, 'ok');
  assert.equal(output.serverVersion, packageJson.version);
  assert.equal(typeof output.timestamp, 'string');
  assert.ok(!Number.isNaN(Date.parse(output.timestamp as string)));
});

test('server factory creates independent instances', async t => {
  const first = createServer(fakeDeps);
  const second = createServer(fakeDeps);
  t.after(() => first.close());
  t.after(() => second.close());
  assert.notStrictEqual(first, second);
});

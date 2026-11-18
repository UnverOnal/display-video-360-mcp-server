import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import packageJson from '../package.json' with { type: 'json' };

// The real entry point as a child process, the way Claude Code or Claude Desktop starts it.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INDEX = fileURLToPath(new URL('./index.ts', import.meta.url));
const NAME = 'display-video-360-mcp-server';
const TOOLS = [
  'find_entities', 'get_metadata', 'get_performance', 'get_report', 'health', 'list_advertisers', 'list_campaigns',
  'list_insertion_orders', 'list_line_items', 'list_partners', 'list_report_fields', 'list_saved_reports',
  'run_report', 'run_saved_report',
];

// A home without gcloud files and a credentials path that does not exist: no real Google login can be found.
function isolatedEnv(t: TestContext, extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'dv360-stdio-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    PATH: process.env.PATH ?? '', HOME: home,
    GOOGLE_APPLICATION_CREDENTIALS: join(home, 'missing-credentials.json'),
    GOOGLE_CLOUD_QUOTA_PROJECT: 'test-quota-project',
    ...extra,
  };
}

test('stdio entry point serves the tools to a real MCP client', { timeout: 20_000 }, async t => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', INDEX], cwd: ROOT, env: isolatedEnv(t), stderr: 'pipe',
  });
  let stderrText = '';
  // The stderr stream exists before start(), so no early line is missed.
  transport.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString('utf8'); });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);

  assert.deepEqual(client.getServerVersion(), { name: NAME, version: packageJson.version });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), TOOLS);

  const health = await client.callTool({ name: 'health', arguments: {} });
  assert.notEqual(health.isError, true);

  // A Google-backed tool fails safely without a login, and the server stays up.
  const partners = await client.callTool({ name: 'list_partners', arguments: {} });
  assert.equal(partners.isError, true);
  assert.match(JSON.stringify(partners.content), /Google credentials/);
  assert.notEqual((await client.callTool({ name: 'health', arguments: {} })).isError, true);

  await client.close();
  assert.match(stderrText, new RegExp(`^${NAME} ${packageJson.version.replaceAll('.', '\\.')} running on stdio$`, 'm'));
  // Log lines on stderr are JSON; the tool calls above produced some.
  const logLines = stderrText.split('\n').filter(line => line.startsWith('{'));
  assert.ok(logLines.some(line => JSON.parse(line).type === 'tool.call'));
});

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function run(t: TestContext, env: Record<string, string>, input: 'close' | 'keep') {
  const child = spawn(process.execPath, ['--import', 'tsx', INDEX], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let finished = false;
  const exited = new Promise<Exit>((resolve, reject) => {
    child.once('error', reject);
    // close follows exit and pipe draining, so captured output is complete.
    child.once('close', (code, signal) => { finished = true; resolve({ code, signal, stdout, stderr }); });
  });
  t.after(async () => { if (!finished) child.kill('SIGKILL'); await exited.catch(() => {}); });
  if (input === 'close') child.stdin.end();
  return { exited, kill: (signal: NodeJS.Signals) => { child.kill(signal); }, stderrSoFar: () => stderr };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('the process exits cleanly when stdin closes, with nothing on stdout', { timeout: 20_000 }, async t => {
  const result = await run(t, isolatedEnv(t), 'close').exited;
  assert.deepEqual([result.code, result.signal, result.stdout], [0, null, '']);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`the process exits cleanly on ${signal}`, { timeout: 20_000 }, async t => {
    const running = run(t, isolatedEnv(t), 'keep');
    await waitFor(() => running.stderrSoFar().includes('running on stdio'));
    running.kill(signal);
    const result = await running.exited;
    assert.deepEqual([result.code, result.signal, result.stdout], [0, null, '']);
  });
}

test('a bad quota project stops startup with a message on stderr and nothing on stdout', { timeout: 20_000 }, async t => {
  const result = await run(t, isolatedEnv(t, { GOOGLE_CLOUD_QUOTA_PROJECT: 'Bad_Project' }), 'close').exited;
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.stderr.split('\n').filter(Boolean), [
    `${NAME} failed to start: GOOGLE_CLOUD_QUOTA_PROJECT must be a Google Cloud project ID (received "Bad_Project")`,
  ]);
});

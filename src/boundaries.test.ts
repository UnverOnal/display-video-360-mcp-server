import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(SRC, { recursive: true })
  .filter((path): path is string => typeof path === 'string' && path.endsWith('.ts') && !path.endsWith('.test.ts'))
  // Reserved for deployment add-ons in forks (for example an HTTP transport); they carry their own boundary test.
  .filter(path => !path.startsWith('remote/'))
  .map(path => ({ path, content: readFileSync(new URL(path, import.meta.url), 'utf8') }));

function assertNoViolations(rule: string, violates: (path: string, content: string) => boolean): void {
  const violations = sources.filter(({ path, content }) => violates(path, content))
    .map(({ path }) => `${path}: ${rule}`);
  assert.deepEqual(violations, []);
}

test('integrations do not import the MCP SDK', () => {
  assertNoViolations('integrations must not import the MCP SDK',
    (path, content) => path.startsWith('integrations/') && /from\s+['"]@modelcontextprotocol\//.test(content));
});

test('tools do not call Google directly', () => {
  assertNoViolations('tools must call integrations instead of Google directly', (path, content) =>
    path.startsWith('tools/') && (/from\s+['"](googleapis|google-auth-library|@google-cloud\/)/.test(content)
      || /\bfetch\s*\(/.test(content)));
});

test('nothing listens on a port', () => {
  assertNoViolations('the stdio server must not listen', (_path, content) => /\.listen\s*\(/.test(content));
});

test('only config reads the environment', () => {
  assertNoViolations('only config.ts may read the environment',
    (path, content) => path !== 'config.ts' && /process\.env/.test(content));
});

test('the runtime enables the cleanup throttle', () => {
  const runtime = sources.find(({ path }) => path === 'runtime.ts');
  assert.ok(runtime);
  assert.match(runtime.content, /minIntervalMs: CLEANUP_MIN_INTERVAL_MS/);
});

test('only the entry point builds the runtime', () => {
  assertNoViolations('only index.ts may call createRuntime', (path, content) =>
    path !== 'index.ts' && path !== 'runtime.ts' && /\bcreateRuntime\s*\(/.test(content));
});

test('the runtime has no I/O of its own', () => {
  const runtimeIo = /process\.|console\.|\.listen\s*\(|setTimeout|setInterval/;
  for (const violation of ['process.env.X', 'process.stderr.write(x)', 'console.error(x)', 'server.listen(1)', 'setTimeout(fn)', 'setInterval(fn)']) {
    assert.ok(runtimeIo.test(violation), violation);
  }
  assertNoViolations('runtime.ts must not read the environment, write output, listen, or start timers', (path, content) =>
    path === 'runtime.ts' && runtimeIo.test(content));
});

test('only the cleanup may delete Bid Manager queries', () => {
  assertNoViolations('only the cleanup may delete Bid Manager queries', (path, content) =>
    path !== 'integrations/bidmanager/client.ts' && path !== 'integrations/bidmanager/cleanup.ts'
      && /\bdeleteQuery\s*\(/.test(content));
});

test('the report-file reader never uses Google credentials', () => {
  assertNoViolations('the report-file reader must not use Google credentials', (path, content) =>
    path === 'integrations/bidmanager/report-file.ts' && /google\/auth|authorization|AuthorizedFetch/i.test(content));
});

test('only the report-file reader parses spreadsheets', () => {
  assertNoViolations('only the report-file reader may import read-excel-file', (path, content) =>
    path !== 'integrations/bidmanager/report-file.ts' && path !== 'integrations/bidmanager/report-file.test.ts'
      && /from\s+['"]read-excel-file(?:\/[^'"]*)?['"]/.test(content));
});

test('fflate is used only by tests', () => {
  assertNoViolations('only tests may import fflate', (_path, content) => /from\s+['"]fflate(?:\/[^'"]*)?['"]/.test(content));
});

test('only the runtime composes process-level integrations', () => {
  const factories: Record<string, string> = {
    createAuthorizedFetch: 'integrations/google/auth.ts',
    createBidManagerClient: 'integrations/bidmanager/client.ts',
    createQueryCleanup: 'integrations/bidmanager/cleanup.ts',
    createReportingService: 'integrations/bidmanager/reporting.ts',
    createDv360Client: 'integrations/dv360/client.ts',
    createMetadataService: 'integrations/dv360/metadata.ts',
    createPerformanceService: 'combined/performance.ts',
  };
  for (const [name, definition] of Object.entries(factories)) {
    assertNoViolations(`only runtime.ts may call ${name}`, (path, content) =>
      path !== 'runtime.ts' && path !== definition && new RegExp(`\\b${name}\\s*\\(`).test(content));
  }
});

test('only the reporting service starts reports', () => {
  assertNoViolations('only reporting.ts may create or run queries', (path, content) =>
    path !== 'integrations/bidmanager/client.ts' && path !== 'integrations/bidmanager/reporting.ts'
      && /\b(?:createQuery|runQuery)\s*\(/.test(content));
});

test('tools import only the reporting service, field catalog, and metadata service from integrations', () => {
  assertNoViolations('tools may import only reporting.js, fields.js, and dv360/metadata.js from integrations', (path, content) =>
    path.startsWith('tools/') && [...content.matchAll(/from\s+['"]([^'"]*(?:integrations|combined)\/[^'"]+)['"]/g)]
      .some(match => ![
        '../integrations/bidmanager/reporting.js', '../integrations/bidmanager/fields.js', '../integrations/dv360/metadata.js', '../combined/performance.js', '../combined/presets.js',
      ].includes(match[1])));
});

test('server imports integrations only as types', () => {
  assertNoViolations('server.ts must use type-only integration imports', (path, content) =>
    path === 'server.ts' && [...content.matchAll(/import\s+([^;]+?)from\s+['"]([^'"]*(?:integrations|combined)\/[^'"]+)['"]/g)]
      .some(match => !match[1].trimStart().startsWith('type ')));
});

test('the Bid Manager and DV360 integrations must not import each other', () => {
  assertNoViolations('the Bid Manager and DV360 integrations must not import each other', (path, content) => {
    const other = path.startsWith('integrations/dv360/') ? 'bidmanager'
      : path.startsWith('integrations/bidmanager/') ? 'dv360' : undefined;
    if (!other) return false;
    const specifiers = [...content.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'`]([^"'`]+)["'`]/g)];
    return specifiers.some(match => match[1].includes(`/${other}/`));
  });
});

test('the DV360 integration may only send GET requests', () => {
  assertNoViolations('the DV360 integration may only send GET requests', (path, content) =>
    path.startsWith('integrations/dv360/') && /(['"`])(?:POST|PUT|PATCH|DELETE)\1/.test(content));
});

test('dv360/format.ts must stay pure', () => {
  assertNoViolations('dv360/format.ts must stay pure', (path, content) =>
    path === 'integrations/dv360/format.ts' && /\bfetch\s*\(|node:crypto|Date\.now|new\s+Date\s*\(/.test(content));
});

test('dv360/names.ts must stay pure', () => {
  const impureNames = /\bfetch\s*\(|node:crypto|Date\.now|new\s+Date\s*\(|console\.|setTimeout/;
  for (const violation of ['fetch(url)', "import 'node:crypto'", 'Date.now()', 'new Date()', 'console.log(x)', 'setTimeout(fn)']) {
    assert.ok(impureNames.test(violation), violation);
  }
  assert.ok(sources.some(({ path }) => path === 'integrations/dv360/names.ts'), 'dv360/names.ts must exist');
  assertNoViolations('dv360/names.ts must stay pure', (path, content) =>
    path === 'integrations/dv360/names.ts' && impureNames.test(content));
});

test('the DV360 integration uses only the GET-only request helper', () => {
  assertNoViolations('the DV360 integration may import only createGetJson from google/request.js', (path, content) => {
    if (!path.startsWith('integrations/dv360/')) return false;
    const imports = [...content.matchAll(/\b(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"][^'"]*google\/request\.js['"]/g)]
      .filter(match => !match[1]);
    const names = imports.flatMap(match => match[2].replace(/[{}]/g, ' ').split(',').map(name => name.trim()).filter(Boolean));
    return names.some(name => name !== 'createGetJson' && !name.startsWith('type '))
      || /\bimport\s*\(\s*['"`][^'"`]*google\/request\.js/.test(content);
  });
});

test('the Google clients do not call fetch directly', () => {
  assertNoViolations('Google clients must send requests through google/request.js', (path, content) =>
    (path.startsWith('integrations/bidmanager/') || path.startsWith('integrations/dv360/'))
      && path !== 'integrations/bidmanager/report-file.ts' && /\bfetch\s*\(/.test(content));
});

test('the shared Google layer does not depend on the integrations', () => {
  assertNoViolations('integrations/google must not import bidmanager or dv360', (path, content) =>
    path.startsWith('integrations/google/')
      && [...content.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'`]([^"'`]+)["'`]/g)]
        .some(match => /\/(?:bidmanager|dv360)\//.test(match[1])));
});

test('google/retry.ts must stay pure', () => {
  assertNoViolations('google/retry.ts must stay pure', (path, content) =>
    path === 'integrations/google/retry.ts' && /\bfetch\s*\(|Date\.now|new\s+Date\s*\(\s*\)|setTimeout|console\./.test(content));
});

const impureLogger = /\bfetch\s*\(|Date\.now|new\s+Date\s*\(\s*\)|setTimeout|console\.|process\./;
const directOutput = /console\.|process\.stderr|process\.stdout/;

test('google/log.ts must stay pure', () => {
  // Deliberate violations use fixtures: never mutate a concurrently owned production file.
  for (const violation of ['fetch(url)', 'Date.now()', 'new Date()', 'setTimeout(fn)', 'console.log(x)', 'process.stderr.write(x)']) {
    assert.ok(impureLogger.test(violation), violation);
  }
  assert.equal(impureLogger.test('new Date(now()).toISOString()'), false);
  assertNoViolations('google/log.ts must stay pure', (path, content) =>
    path === 'integrations/google/log.ts' && impureLogger.test(content));
});

test('only index.ts may write to the console or stderr', () => {
  for (const violation of ['console.log(x)', 'process.stderr.write(x)', 'process.stdout.write(x)']) {
    assert.ok(directOutput.test(violation), violation);
  }
  assertNoViolations('only index.ts may write to the console or stderr', (path, content) =>
    path !== 'index.ts' && directOutput.test(content));
});

// stdout carries the MCP protocol: one stray line breaks the client's connection.
const stdoutWrite = /console\.(?:log|info|debug|table|dir|trace)\b|process\.stdout/;
test('nothing writes to stdout', () => {
  for (const violation of ['console.log(x)', 'console.info(x)', 'console.debug(x)', 'console.table(x)', 'console.dir(x)', 'console.trace()', 'process.stdout.write(x)']) {
    assert.ok(stdoutWrite.test(violation), violation);
  }
  assert.equal(stdoutWrite.test('console.error(x)'), false);
  assertNoViolations('stdout is reserved for the MCP protocol', (_path, content) => stdoutWrite.test(content));
});

test('combined/presets.ts must stay pure and import only types from the integrations', () => {
  const impurePresets = /\bfetch\s*\(|node:crypto|Date\.now|new\s+Date\s*\(|console\.|setTimeout/;
  const valueImport = /import\s+(?!type\b)[^;]*from\s+['"][^'"]*integrations\//;
  for (const violation of ['fetch(url)', "import 'node:crypto'", 'Date.now()', 'new Date()', 'console.log(x)', 'setTimeout(fn)']) {
    assert.ok(impurePresets.test(violation), violation);
  }
  assert.ok(valueImport.test("import { REPORT_TYPES } from '../integrations/bidmanager/fields.js';"));
  assert.equal(valueImport.test("import type { ReportType } from '../integrations/bidmanager/fields.js';"), false);
  assert.ok(sources.some(({ path }) => path === 'combined/presets.ts'), 'combined/presets.ts must exist');
  assertNoViolations('combined/presets.ts must stay pure', (path, content) =>
    path === 'combined/presets.ts' && (impurePresets.test(content) || valueImport.test(content)));
});

const importSpecifier = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'`]([^"'`]+)["'`]/g;
function specifiers(content: string): string[] { return [...content.matchAll(importSpecifier)].map(match => match[1]); }
const combinedImports = ['../integrations/bidmanager/reporting.js', '../integrations/bidmanager/fields.js', '../integrations/dv360/metadata.js'];
const combinedIo = /@modelcontextprotocol\/|\bfetch\s*\(/;
const combinedImport = /(?:^|\/)combined\//;
const serverValueImport = /import\s+(?!type\b)[^;]+from\s+['"][^'"]*(?:integrations|combined)\//;

test('integrations never depend on combined', () => {
  for (const fixture of ["import { x } from '../../combined/performance.js'", "import('../../combined/performance.js')"]) assert.ok(specifiers(fixture).some(value => combinedImport.test(value)));
  assertNoViolations('integrations never depend on combined', (path, content) => path.startsWith('integrations/') && specifiers(content).some(value => combinedImport.test(value)));
});
test('combined relative imports use its service allowlist', () => {
  const forbidden = (content: string) => specifiers(content).some(value => value.startsWith('.') && !value.startsWith('./') && !combinedImports.includes(value));
  assert.ok(forbidden("import { x } from '../integrations/dv360/client.js'"));
  assert.equal(forbidden("import type { x } from '../integrations/dv360/metadata.js'"), false);
  assert.equal(forbidden("import { x } from './presets.js'"), false);
  assertNoViolations('combined uses services only', (path, content) => path.startsWith('combined/') && forbidden(content));
});
test('combined has no SDK or fetch', () => {
  for (const fixture of ["import { x } from '@modelcontextprotocol/server'", 'fetch(url)']) assert.ok(combinedIo.test(fixture));
  assertNoViolations('combined has no SDK or fetch', (path, content) => path.startsWith('combined/') && combinedIo.test(content));
});
test('server combined imports are type-only', () => {
  assert.ok(serverValueImport.test("import { x } from './combined/performance.js'"));
  assert.equal(serverValueImport.test("import type { x } from './combined/performance.js'"), false);
  assertNoViolations('server combined imports are type-only', (path, content) => path === 'server.ts' && serverValueImport.test(content));
});
test('combined factory and tools allowlist patterns detect violations', () => {
  const factory = /\bcreatePerformanceService\s*\(/;
  assert.ok(factory.test('createPerformanceService(deps)'));
  assert.equal(factory.test('type PerformanceService'), false);
  const allowed = [...combinedImports, '../combined/performance.js', '../combined/presets.js'];
  const forbidden = (content: string) => specifiers(content).some(value => /(?:integrations|combined)\//.test(value) && !allowed.includes(value));
  assert.ok(forbidden("import { x } from '../combined/private.js'"));
  assert.equal(forbidden("import { x } from '../combined/performance.js'"), false);
});

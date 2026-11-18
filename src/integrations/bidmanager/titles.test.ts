import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMcpTitle, isExpiredMcpTitle, MCP_QUERY_RETENTION_MS, MCP_TITLE_PREFIX, parseMcpTitle } from './titles.js';

test('title constants are the exact prefix and seven-day retention', () => {
  assert.equal(MCP_TITLE_PREFIX, '[MCP] ');
  assert.equal(MCP_QUERY_RETENTION_MS, 604_800_000);
});

for (const milliseconds of ['000', '123', '999']) {
  test(`titles round trip with .${milliseconds} milliseconds dropped, never rounded`, () => {
    const now = new Date(`2026-11-06T09:30:00.${milliseconds}Z`);
    const title = buildMcpTitle('Monthly media report', now);
    assert.equal(title, '[MCP] Monthly media report 2026-11-06T09:30:00Z');
    assert.equal(parseMcpTitle(title)?.getTime(), now.getTime() - Number(milliseconds));
  });
}

test('description cleaning replaces controls, collapses whitespace and preserves Turkish', () => {
  const description = ' \u0000 Aylık\n medya\t raporu\u007f\u0085\u009f İstanbul  ıİğĞşŞüÜöÖçÇ ';
  assert.equal(buildMcpTitle(description, new Date('2026-11-06T09:30:00Z')),
    '[MCP] Aylık medya raporu İstanbul ıİğĞşŞüÜöÖçÇ 2026-11-06T09:30:00Z');
});

test('description is cut at 80 characters and trimmed again after the cut', () => {
  const now = new Date('2026-11-06T09:30:00Z');
  const title = buildMcpTitle('a'.repeat(100), now);
  assert.equal(title, `[MCP] ${'a'.repeat(80)} 2026-11-06T09:30:00Z`);
  assert.equal(title.length, 107);
  assert.equal(buildMcpTitle(`${'a'.repeat(79)} b`, now), `[MCP] ${'a'.repeat(79)} 2026-11-06T09:30:00Z`);
});

test('empty and control-only descriptions default to report', () => {
  for (const description of ['', ' \t\n', '\u0000\u007f\u0085\u009f']) {
    assert.equal(buildMcpTitle(description, new Date('2026-11-06T09:30:00Z')), '[MCP] report 2026-11-06T09:30:00Z');
  }
});

test('build uses UTC and does not mutate the input date', () => {
  const now = new Date('2026-11-06T12:30:00.999+03:00');
  const before = now.getTime();
  assert.equal(buildMcpTitle('report', now), '[MCP] report 2026-11-06T09:30:00Z');
  assert.equal(now.getTime(), before);
});

const rejected = [
  'report 2026-11-06T09:30:00Z', '[mcp] report 2026-11-06T09:30:00Z',
  '[MCP]report 2026-11-06T09:30:00Z', '[MCP] report', '[MCP] report 2026-11-06T09:30:00.000Z',
  '[MCP] report 2026-11-06T12:30:00+03:00', '[MCP] 2026-11-06T09:30:00Z',
  '[MCP]  2026-11-06T09:30:00Z', '[MCP]   2026-11-06T09:30:00Z',
  '[MCP] report 2026-02-30T00:00:00Z', '[MCP] report 2026-11-06T24:00:00Z',
  '[MCP] report 2026-13-01T00:00:00Z', '[MCP] report 2026-00-01T00:00:00Z',
  '[MCP] report 2026-11-00T00:00:00Z', '[MCP] report 2026-11-06T09:60:00Z',
  '[MCP] report 2026-11-06T09:30:60Z', '[MCP] report 2026-11-06T09:30:00Z extra',
  '[MCP] report 2026-11-06T09:30:00Z\n', '[MCP] report2026-11-06T09:30:00Z',
  '[MCP] report 2026-1-06T09:30:00Z', '[MCP] report 2026-11-06t09:30:00z',
];
for (const title of rejected) {
  test(`parser rejects ${JSON.stringify(title)}`, () => {
    assert.equal(parseMcpTitle(title), undefined);
  });
}

test('parser accepts a real leap day and four-digit early year', () => {
  for (const timestamp of ['2024-02-29T23:59:59Z', '0000-01-01T00:00:00Z', '0099-01-01T00:00:00Z']) {
    assert.equal(parseMcpTitle(`[MCP] report ${timestamp}`)?.toISOString(), timestamp.replace('Z', '.000Z'));
  }
});

test('parsing does not impose the builder description cap on existing titles', () => {
  assert.ok(parseMcpTitle(`[MCP] ${'a'.repeat(100)} 2026-11-06T09:30:00Z`) instanceof Date);
});

test('expiry is strictly greater than seven days including the millisecond boundary', () => {
  const created = new Date('2026-11-06T09:30:00Z');
  const title = buildMcpTitle('report', created);
  for (const offset of [-1, 0, MCP_QUERY_RETENTION_MS - 1, MCP_QUERY_RETENTION_MS, MCP_QUERY_RETENTION_MS + 1, MCP_QUERY_RETENTION_MS + 1000]) {
    assert.equal(isExpiredMcpTitle(title, new Date(created.getTime() + offset)), offset > MCP_QUERY_RETENTION_MS);
  }
});

test('unparseable and future titles never expire', () => {
  const now = new Date('2026-11-06T09:30:00Z');
  for (const title of rejected) assert.equal(isExpiredMcpTitle(title, now), false);
  assert.equal(isExpiredMcpTitle(buildMcpTitle('future', new Date(now.getTime() + 1000)), now), false);
});

test('invalid build dates throw RangeError and invalid expiry dates do not expire', () => {
  assert.throws(() => buildMcpTitle('report', new Date(NaN)), RangeError);
  assert.equal(isExpiredMcpTitle('[MCP] report 2026-11-06T09:30:00Z', new Date(NaN)), false);
});

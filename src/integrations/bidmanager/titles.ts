export const MCP_TITLE_PREFIX = '[MCP] ';
export const MCP_QUERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function buildMcpTitle(description: string, now: Date): string {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cleaned = description.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return `${MCP_TITLE_PREFIX}${cleaned || 'report'} ${timestamp}`;
}

export function parseMcpTitle(title: string): Date | undefined {
  if (!title.startsWith(MCP_TITLE_PREFIX)) return undefined;
  const timestamp = title.slice(-20);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp) || title.at(-21) !== ' ') return undefined;
  if (!title.slice(MCP_TITLE_PREFIX.length, -21).trim()) return undefined;
  const created = new Date(timestamp);
  if (!Number.isFinite(created.getTime()) || created.toISOString() !== timestamp.replace(/Z$/, '.000Z')) return undefined;
  return created;
}

export function isExpiredMcpTitle(title: string, now: Date): boolean {
  const created = parseMcpTitle(title);
  return created !== undefined && now.getTime() - created.getTime() > MCP_QUERY_RETENTION_MS;
}

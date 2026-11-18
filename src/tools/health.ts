import { runWithoutLogging, type ToolRunner } from './call.js';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export const healthOutputSchema = z.object({
  status: z.literal('ok'),
  serverVersion: z.string(),
  timestamp: z.string(),
});

export type HealthOutput = z.infer<typeof healthOutputSchema>;

export function buildHealthResult(serverVersion: string, now: Date = new Date()): {
  content: [{ type: 'text'; text: string }];
  structuredContent: HealthOutput;
} {
  const output: HealthOutput = { status: 'ok', serverVersion, timestamp: now.toISOString() };
  return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
}

export function registerHealthTool(server: McpServer, serverVersion: string, run: ToolRunner = runWithoutLogging): void {
  server.registerTool(
    'health',
    {
      title: 'Health check',
      description: 'Confirms the DV360 MCP server is reachable and reports its version. Makes no Google API calls.',
      inputSchema: z.object({}),
      outputSchema: healthOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run('health', async () => buildHealthResult(serverVersion)),
  );
}

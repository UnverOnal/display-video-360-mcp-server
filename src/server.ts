import type { ToolRunner } from './tools/call.js';
import { McpServer } from '@modelcontextprotocol/server';
import packageJson from '../package.json' with { type: 'json' };
import { registerPerformanceTools } from './tools/performance.js';
import type { PerformanceService } from './combined/performance.js';
import { registerHealthTool } from './tools/health.js';
import { registerReportTools } from './tools/reports.js';
import { registerMetadataTools } from './tools/metadata.js';
import type { ReportingService } from './integrations/bidmanager/reporting.js';
import type { MetadataService } from './integrations/dv360/metadata.js';

export type ServerDependencies = { readonly performance: PerformanceService; readonly reporting: ReportingService; readonly metadata: MetadataService; readonly runTool?: ToolRunner };

export function createServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({ name: 'display-video-360-mcp-server', version: packageJson.version });
  registerHealthTool(server, packageJson.version, dependencies.runTool);
  registerReportTools(server, dependencies.reporting, dependencies.runTool);
  registerMetadataTools(server, dependencies.metadata, dependencies.runTool);
  registerPerformanceTools(server, dependencies.performance, dependencies.runTool);
  return server;
}

import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerConfig } from './config.js';
import { createServer } from './server.js';
import { createToolRunner } from './tools/call.js';
import { createPerformanceService } from './combined/performance.js';
import { YOUTUBE_FILTER_LEVELS } from './combined/presets.js';
import type { LogLine } from './integrations/google/log.js';
import { createAuthorizedFetch } from './integrations/google/auth.js';
import { BID_MANAGER_SCOPE, createBidManagerClient } from './integrations/bidmanager/client.js';
import { createQueryCleanup, CLEANUP_MIN_INTERVAL_MS } from './integrations/bidmanager/cleanup.js';
import { createReportingService } from './integrations/bidmanager/reporting.js';
import { DISPLAY_VIDEO_SCOPE, createDv360Client } from './integrations/dv360/client.js';
import { createMetadataService } from './integrations/dv360/metadata.js';

export type Runtime = {
  /** A new McpServer with every tool, sharing the process-wide Google clients, caches, and limits. */
  readonly createMcpServer: () => McpServer;
  readonly log: (event: LogLine) => void;
};

/**
 * Builds the Google clients and services once for the whole process; the entry point chooses the transport
 * and where logs go; a fork can wrap this with its own transport (see src/remote/).
 */
export function createRuntime(config: ServerConfig, options: { readonly log: (event: LogLine) => void }): Runtime {
  const { log } = options;
  const authorizedFetch = createAuthorizedFetch({
    quotaProject: config.googleCloudQuotaProject,
    scopes: [BID_MANAGER_SCOPE, DISPLAY_VIDEO_SCOPE],
  });
  const runtime = { logger: log };
  const runTool = createToolRunner({ log });
  const client = createBidManagerClient(authorizedFetch, { runtime });
  const reporting = createReportingService({ client, cleanup: createQueryCleanup(client, { minIntervalMs: CLEANUP_MIN_INTERVAL_MS }) });
  const metadata = createMetadataService({ client: createDv360Client(authorizedFetch, { runtime }) });
  const performance = createPerformanceService({ metadata, reporting, youtubeFilterLevels: YOUTUBE_FILTER_LEVELS });
  return {
    createMcpServer: () => createServer({ reporting, metadata, performance, runTool }),
    log,
  };
}

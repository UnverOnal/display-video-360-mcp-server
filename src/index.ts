import { serveStdio } from '@modelcontextprotocol/server/stdio';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';
import { createJsonLogger } from './integrations/google/log.js';
import { createRuntime } from './runtime.js';

// stdout carries the MCP protocol. Everything else, diagnostics and JSON log lines, goes to stderr.
const NAME = 'display-video-360-mcp-server';

function main(): void {
  const config = loadConfig();
  const log = createJsonLogger({ write: line => { process.stderr.write(line); }, now: Date.now });
  const runtime = createRuntime(config, { log });

  // One server for the connection. The transport closes itself when stdin ends; the process then exits.
  const handle = serveStdio(() => runtime.createMcpServer(), {
    // Only the error class: out-of-band messages can quote client input.
    onerror: error => { console.error(`${NAME} stdio error: ${error.name}`); },
  });

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    handle.close().catch((error: unknown) => {
      console.error(`${NAME} shutdown failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.error(`${NAME} ${packageJson.version} running on stdio`);
}

try {
  main();
} catch (error: unknown) {
  console.error(`${NAME} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

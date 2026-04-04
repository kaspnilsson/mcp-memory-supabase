#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryServer as _createMemoryServer } from "./server.js";
import { createDefaultLogger } from "./types.js";

export { createMemoryServer, type CreateMemoryServerResult } from "./server.js";
export { KnowledgeGraphManager, type KnowledgeGraphManagerConfig, generateDigest } from "./manager.js";
export * from "./types.js";

async function main(): Promise<void> {
  const logger = createDefaultLogger();

  try {
    const { server } = _createMemoryServer({ logger });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP Memory Server (Supabase) running on stdio");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Fatal error starting server", { error: errorMessage });
    process.exit(1);
  }
}

// Ensure this matches your JS environment execution path exactly
import url from 'url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}

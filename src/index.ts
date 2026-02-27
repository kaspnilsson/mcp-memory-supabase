#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryServer } from "./server.js";
import { createDefaultLogger } from "./types.js";

async function main(): Promise<void> {
  const logger = createDefaultLogger();

  try {
    const { server } = createMemoryServer({ logger });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP Memory Server (Supabase) running on stdio");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Fatal error starting server", { error: errorMessage });
    process.exit(1);
  }
}

main();

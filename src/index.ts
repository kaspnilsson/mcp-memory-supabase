#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KnowledgeGraphManager } from "./manager.js";
import { Entity, Relation } from "./types.js";

// Simple logger that outputs JSON to stderr (MCP uses stdout for protocol)
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

function log(level: string, message: string, data?: Record<string, unknown>): void {
  if ((LEVELS[level] ?? 1) < currentLevel) return;
  const entry = { level, message, timestamp: new Date().toISOString(), ...data };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

const logger = {
  debug: (message: string, data?: Record<string, unknown>) => log("debug", message, data),
  info: (message: string, data?: Record<string, unknown>) => log("info", message, data),
  warn: (message: string, data?: Record<string, unknown>) => log("warn", message, data),
  error: (message: string, data?: Record<string, unknown>) => log("error", message, data),
};

function withLogging<T>(toolName: string, handler: (args: T) => Promise<unknown>): (args: T) => Promise<unknown> {
  return async (args: T): Promise<unknown> => {
    const start = Date.now();
    try {
      const result = await handler(args);
      const duration = Date.now() - start;
      logger.debug(`tool:${toolName} completed`, { tool: toolName, duration_ms: duration });
      return result;
    } catch (error: unknown) {
      const duration = Date.now() - start;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`tool:${toolName} failed`, { tool: toolName, duration_ms: duration, error: errorMessage });
      throw error;
    }
  };
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY;
const EMBEDDING_API_URL = process.env.EMBEDDING_API_URL;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL;

if (SUPABASE_URL === undefined || SUPABASE_URL === "") {
  console.error("Error: SUPABASE_URL environment variable is required");
  process.exit(1);
}
if (SUPABASE_KEY === undefined || SUPABASE_KEY === "") {
  console.error("Error: SUPABASE_KEY (or SUPABASE_SERVICE_KEY) environment variable is required");
  process.exit(1);
}

const manager = new KnowledgeGraphManager({
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_KEY,
  embeddingApiKey: EMBEDDING_API_KEY,
  embeddingApiUrl: EMBEDDING_API_URL,
  embeddingModel: EMBEDDING_MODEL,
});

const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(z.string()).describe("An array of observation contents associated with the entity"),
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
});

const server = new McpServer({
  name: "memory-server-supabase",
  version: "1.0.0",
});

server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: { entities: z.array(EntitySchema) },
    outputSchema: { entities: z.array(EntitySchema) },
  },
  withLogging("create_entities", async ({ entities }): Promise<{ content: { type: "text"; text: string }[]; structuredContent: { entities: Entity[] } }> => {
    const result = await manager.createEntities(entities as Entity[]);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { entities: result },
    };
  })
);

server.registerTool(
  "create_relations",
  {
    title: "Create Relations",
    description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: { relations: z.array(RelationSchema) },
    outputSchema: { relations: z.array(RelationSchema) },
  },
  withLogging("create_relations", async ({ relations }): Promise<{ content: { type: "text"; text: string }[]; structuredContent: { relations: Relation[] } }> => {
    const result = await manager.createRelations(relations as Relation[]);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { relations: result },
    };
  })
);

server.registerTool(
  "add_observations",
  {
    title: "Add Observations",
    description: "Add new observations to existing entities in the knowledge graph",
    inputSchema: {
      observations: z.array(
        z.object({
          entityName: z.string().describe("The name of the entity to add the observations to"),
          contents: z.array(z.string()).describe("An array of observation contents to add"),
        })
      ),
    },
    outputSchema: {
      results: z.array(
        z.object({
          entityName: z.string(),
          addedObservations: z.array(z.string()),
        })
      ),
    },
  },
  withLogging("add_observations", async ({ observations }): Promise<{ content: { type: "text"; text: string }[]; structuredContent: { results: { entityName: string; addedObservations: string[] }[] } }> => {
    const result = await manager.addObservations(observations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { results: result },
    };
  })
);

server.registerTool(
  "delete_entities",
  {
    title: "Delete Entities",
    description: "Delete multiple entities and their associated relations from the knowledge graph",
    inputSchema: { entityNames: z.array(z.string()).describe("An array of entity names to delete") },
    outputSchema: { success: z.boolean(), message: z.string() },
  },
  withLogging("delete_entities", async ({ entityNames }): Promise<{ content: { type: "text"; text: string }[]; structuredContent: { success: boolean; message: string } }> => {
    await manager.deleteEntities(entityNames);
    return {
      content: [{ type: "text" as const, text: "Entities deleted successfully" }],
      structuredContent: { success: true, message: "Entities deleted successfully" },
    };
  })
);

server.registerTool(
  "delete_observations",
  {
    title: "Delete Observations",
    description: "Delete specific observations from entities in the knowledge graph",
    inputSchema: {
      deletions: z.array(
        z.object({
          entityName: z.string().describe("The name of the entity containing the observations"),
          observations: z.array(z.string()).describe("An array of observations to delete"),
        })
      ),
    },
    outputSchema: { success: z.boolean(), message: z.string() },
  },
  withLogging("delete_observations", async ({ deletions }): Promise<{ content: { type: "text"; text: string }[]; structuredContent: { success: boolean; message: string } }> => {
    await manager.deleteObservations(deletions);
    return {
      content: [{ type: "text" as const, text: "Observations deleted successfully" }],
      structuredContent: { success: true, message: "Observations deleted successfully" },
    };
  })
);

server.registerTool(
  "delete_relations",
  {
    title: "Delete Relations",
    description: "Delete multiple relations from the knowledge graph",
    inputSchema: { relations: z.array(RelationSchema).describe("An array of relations to delete") },
    outputSchema: { success: z.boolean(), message: z.string() },
  },
  withLogging("delete_relations", async ({ relations }): Promise<{ content: { type: "text"; text: string }[]; structuredContent: { success: boolean; message: string } }> => {
    await manager.deleteRelations(relations as Relation[]);
    return {
      content: [{ type: "text" as const, text: "Relations deleted successfully" }],
      structuredContent: { success: true, message: "Relations deleted successfully" },
    };
  })
);

server.registerTool(
  "read_graph",
  {
    title: "Read Graph",
    description: "Read the entire knowledge graph",
    inputSchema: {},
    outputSchema: { entities: z.array(EntitySchema), relations: z.array(RelationSchema) },
  },
  withLogging("read_graph", async (): Promise<{ content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }> => {
    const graph = await manager.readGraph();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: graph,
    };
  })
);

server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph using semantic search (requires EMBEDDING_API_KEY) or text matching fallback",
    inputSchema: { query: z.string().describe("The search query to find matching entities") },
    outputSchema: { entities: z.array(EntitySchema), relations: z.array(RelationSchema) },
  },
  withLogging("search_nodes", async ({ query }): Promise<{ content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }> => {
    const graph = await manager.searchNodes(query);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: graph,
    };
  })
);

server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: { names: z.array(z.string()).describe("An array of entity names to retrieve") },
    outputSchema: { entities: z.array(EntitySchema), relations: z.array(RelationSchema) },
  },
  withLogging("open_nodes", async ({ names }): Promise<{ content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }> => {
    const graph = await manager.openNodes(names);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: graph,
    };
  })
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP Memory Server (Supabase) running on stdio");
}

main().catch((error: unknown): never => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error("Fatal error in main()", { error: errorMessage });
  process.exit(1);
});

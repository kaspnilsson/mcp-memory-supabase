import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KnowledgeGraphManager } from "./manager.js";
import { Entity, Relation, Logger, MemoryServerOptions, createDefaultLogger } from "./types.js";

const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  description: z.string().optional().describe("A short description of the entity"),
  observations: z.array(z.string()).describe("An array of observation contents associated with the entity"),
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
});

interface ToolResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function withLogging<T>(
  toolName: string,
  handler: (args: T) => Promise<ToolResponse>,
  logger: Logger
): (args: T) => Promise<ToolResponse> {
  return async (args: T): Promise<ToolResponse> => {
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
      return {
        content: [{ type: "text", text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  };
}

export interface CreateMemoryServerResult {
  server: McpServer;
  manager: KnowledgeGraphManager;
}

export function createMemoryServer(options: MemoryServerOptions = {}): CreateMemoryServerResult {
  const supabaseUrl = options.supabaseUrl ?? process.env.SUPABASE_URL;
  const supabaseKey = options.supabaseKey ?? process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  const embeddingApiKey = options.embeddingApiKey ?? process.env.EMBEDDING_API_KEY;
  const embeddingApiUrl = options.embeddingApiUrl ?? process.env.EMBEDDING_API_URL;
  const embeddingModel = options.embeddingModel ?? process.env.EMBEDDING_MODEL;
  const logger = options.logger ?? createDefaultLogger();

  if (supabaseUrl === undefined || supabaseUrl === "") {
    throw new Error("SUPABASE_URL is required");
  }
  if (supabaseKey === undefined || supabaseKey === "") {
    throw new Error("SUPABASE_KEY (or SUPABASE_SERVICE_KEY) is required");
  }

  const manager = new KnowledgeGraphManager({
    supabaseUrl,
    supabaseKey,
    embeddingApiKey,
    embeddingApiUrl,
    embeddingModel,
    logger,
  });

  const server = new McpServer({
    name: options.serverName ?? "memory-server-supabase",
    version: options.serverVersion ?? "1.0.0",
  });

  server.tool(
    "create_entities",
    { entities: z.array(EntitySchema) },
    withLogging(
      "create_entities",
      async ({ entities }): Promise<ToolResponse> => {
        const result = await manager.createEntities(entities as Entity[]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      logger
    )
  );

  server.tool(
    "create_relations",
    { relations: z.array(RelationSchema) },
    withLogging(
      "create_relations",
      async ({ relations }): Promise<ToolResponse> => {
        const result = await manager.createRelations(relations as Relation[]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      logger
    )
  );

  server.tool(
    "add_observations",
    {
      observations: z.array(
        z.object({
          entityName: z.string().describe("The name of the entity to add the observations to"),
          contents: z.array(z.string()).describe("An array of observation contents to add"),
        })
      ),
    },
    withLogging(
      "add_observations",
      async ({ observations }): Promise<ToolResponse> => {
        const result = await manager.addObservations(observations);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      logger
    )
  );

  server.tool(
    "delete_entities",
    { entityNames: z.array(z.string()).describe("An array of entity names to delete") },
    withLogging(
      "delete_entities",
      async ({ entityNames }): Promise<ToolResponse> => {
        const result = await manager.deleteEntities(entityNames);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      logger
    )
  );

  server.tool(
    "delete_observations",
    {
      deletions: z.array(
        z.object({
          entityName: z.string().describe("The name of the entity containing the observations"),
          observations: z.array(z.string()).describe("An array of observations to delete"),
        })
      ),
    },
    withLogging(
      "delete_observations",
      async ({ deletions }): Promise<ToolResponse> => {
        const result = await manager.deleteObservations(deletions);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      logger
    )
  );

  server.tool(
    "delete_relations",
    { relations: z.array(RelationSchema).describe("An array of relations to delete") },
    withLogging(
      "delete_relations",
      async ({ relations }): Promise<ToolResponse> => {
        const result = await manager.deleteRelations(relations as Relation[]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      logger
    )
  );

  server.tool(
    "read_graph",
    {},
    withLogging(
      "read_graph",
      async (): Promise<ToolResponse> => {
        const graph = await manager.readGraph();
        return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
      },
      logger
    )
  );

  server.tool(
    "search_nodes",
    { query: z.string().describe("The search query to find matching entities") },
    withLogging(
      "search_nodes",
      async ({ query }): Promise<ToolResponse> => {
        const graph = await manager.searchNodes(query);
        return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
      },
      logger
    )
  );

  server.tool(
    "open_nodes",
    { names: z.array(z.string()).describe("An array of entity names to retrieve") },
    withLogging(
      "open_nodes",
      async ({ names }): Promise<ToolResponse> => {
        const graph = await manager.openNodes(names);
        return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
      },
      logger
    )
  );

  return { server, manager };
}

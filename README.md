# MCP Memory Server - Supabase

[![npm version](https://img.shields.io/npm/v/@kaspnilsson/mcp-memory-supabase.svg)](https://www.npmjs.com/package/@kaspnilsson/mcp-memory-supabase)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A knowledge graph memory server for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) backed by Supabase with pgvector for semantic search.

## Why This?

- **Own your AI's memory** — Your knowledge graph lives in your own Supabase database, not on someone else's servers
- **Semantic search built-in** — pgvector enables similarity-based retrieval, not just keyword matching
- **Works with any MCP client** — Claude Desktop, TypingMind, Cursor, and more
- **Free tier friendly** — Supabase's free tier works great for personal use
- **Cloud-native** — Managed Postgres with automatic backups, no self-hosting required
- **Composable** — Use as a standalone server or as a library in your own MCP server

## Quick Start

### 1. Create a Supabase Project

Go to [supabase.com](https://supabase.com) and create a new project.

### 2. Get Your Keys

In your project dashboard, go to **Settings → API**:

- **Project URL**: `https://<project-ref>.supabase.co`
- **service_role key**: ⚠️ Keep this secret! Use for server-side operations.

### 3. Run the Schema

Go to **SQL Editor** in your Supabase dashboard and run the contents of [`supabase/schema.sql`](./supabase/schema.sql).

This creates:
- `entities`, `observations`, and `relations` tables
- Row Level Security (RLS) policies
- Vector similarity search index (HNSW)
- Full-text search indexes
- Helper functions for semantic search

### 4. Install & Run

```bash
# Run directly with npx
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_KEY=your-service-role-key \
npx @kaspnilsson/mcp-memory-supabase

# Or install globally
npm install -g @kaspnilsson/mcp-memory-supabase
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_KEY=your-service-role-key \
mcp-memory-supabase
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_KEY` | Yes | Service role key (not anon key) |
| `EMBEDDING_API_KEY` | No | API key for embeddings (enables semantic search) |
| `EMBEDDING_API_URL` | No | Custom embedding API endpoint (default: OpenRouter) |
| `EMBEDDING_MODEL` | No | Model name (default: `openai/text-embedding-3-small`) |
| `LOG_LEVEL` | No | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |

### Semantic Search

With `EMBEDDING_API_KEY` set, `search_nodes` uses vector similarity search for semantic matching. Without it, search falls back to case-insensitive text matching.

The default setup uses [OpenRouter](https://openrouter.ai/) for embeddings, but you can point to any OpenAI-compatible embedding API.

### MCP Client Configuration

Add to your MCP client configuration:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@kaspnilsson/mcp-memory-supabase"],
      "env": {
        "SUPABASE_URL": "https://<project-ref>.supabase.co",
        "SUPABASE_KEY": "<service-role-key>",
        "EMBEDDING_API_KEY": "<your-embedding-api-key>"
      }
    }
  }
}
```

**TypingMind** — Use the MCP settings UI with the same configuration.

## Tools

| Tool | Description |
|------|-------------|
| `create_entities` | Create entities with observations |
| `create_relations` | Create relations between entities |
| `add_observations` | Add observations to existing entities |
| `delete_entities` | Delete entities by name |
| `delete_observations` | Delete specific observations |
| `delete_relations` | Delete specific relations |
| `read_graph` | Read entire knowledge graph |
| `search_nodes` | Search entities by query (semantic or text) |
| `open_nodes` | Get specific entities by name (case-insensitive) |

## Data Model

```
┌─────────────┐     ┌───────────────┐
│   Entity    │────<│  Observation  │
│             │     │               │
│ name        │     │ content       │
│ entityType  │     │ entity_id     │
│ embedding   │     └───────────────┘
└─────────────┘
       │
       │    ┌───────────────┐
       └────<│   Relation    │
            │               │
            │ from_entity_id│
            │ to_entity_id  │
            │ relation_type │
            └───────────────┘
```

- **Entities** are nodes in your knowledge graph (people, projects, concepts, etc.)
- **Observations** are facts/notes attached to entities
- **Relations** connect entities with typed relationships

## Using as a Library

This package exports a composable API for building custom MCP servers:

```typescript
import { createMemoryServer } from "@kaspnilsson/mcp-memory-supabase";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Create server with custom options
const { server, manager } = createMemoryServer({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  embeddingApiKey: process.env.EMBEDDING_API_KEY,
  serverName: "my-custom-memory-server",
  serverVersion: "1.0.0",
  // Custom logger (any object with debug/info/warn/error methods)
  logger: {
    debug: (msg, data) => console.debug(msg, data),
    info: (msg, data) => console.info(msg, data),
    warn: (msg, data) => console.warn(msg, data),
    error: (msg, data) => console.error(msg, data),
  },
});

// Optionally add your own tools
server.tool("my_custom_tool", { /* schema */ }, async (args) => {
  // Use manager to interact with the knowledge graph
  const graph = await manager.searchNodes(args.query);
  return { content: [{ type: "text", text: JSON.stringify(graph) }] };
});

// Connect
await server.connect(new StdioServerTransport());
```

### Import Paths

| Import | Exports |
|--------|---------|
| `@kaspnilsson/mcp-memory-supabase` | `createMemoryServer()` |
| `@kaspnilsson/mcp-memory-supabase/manager` | `KnowledgeGraphManager` class |
| `@kaspnilsson/mcp-memory-supabase/types` | `Entity`, `Relation`, `KnowledgeGraph`, `Logger`, etc. |

## Troubleshooting

### Empty results after enabling RLS

Make sure you ran the RLS policies from `schema.sql`. The service role key bypasses RLS, but Supabase requires policies to exist.

### Vector search not working

1. Ensure the `vector` extension is enabled in Supabase
2. Check that `EMBEDDING_API_KEY` is set correctly
3. Verify embeddings are being generated:
   ```sql
   SELECT name, embedding IS NOT NULL AS has_embedding FROM entities LIMIT 10;
   ```

### Using anon key instead of service_role

If you use the anon key, you'll need stricter RLS policies. The service_role key bypasses RLS entirely.

## Developing

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint
```

## License

MIT © Kasper Nilsson

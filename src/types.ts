export interface ObservationInput {
  content: string;
  memoryType?: 'user' | 'feedback' | 'project' | 'reference' | string;
}

export interface Entity {
  name: string;
  entityType: string;
  description?: string;
  observations: (string | ObservationInput)[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

export interface SearchMatch extends Entity {
  similarity: number;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createDefaultLogger(): Logger {
  const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
  const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

  const log = (level: string, message: string, data?: Record<string, unknown>): void => {
    if ((LEVELS[level] ?? 1) < currentLevel) return;
    process.stderr.write(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...data }) + "\n");
  };

  return {
    debug: (message: string, data?: Record<string, unknown>) => log("debug", message, data),
    info: (message: string, data?: Record<string, unknown>) => log("info", message, data),
    warn: (message: string, data?: Record<string, unknown>) => log("warn", message, data),
    error: (message: string, data?: Record<string, unknown>) => log("error", message, data),
  };
}

export interface MemoryServerOptions {
  supabaseUrl?: string;
  supabaseKey?: string;
  embeddingApiKey?: string;
  embeddingApiUrl?: string;
  embeddingModel?: string;
  logger?: Logger;
  serverName?: string;
  serverVersion?: string;
}

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Entity, Relation, KnowledgeGraph, SearchMatch, Logger, createDefaultLogger, ObservationInput } from "./types.js";

interface MatchResult {
  id: number;
  name: string;
  entity_type: string;
  similarity: number;
}

export interface KnowledgeGraphManagerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  embeddingApiKey?: string;
  embeddingApiUrl?: string;
  embeddingModel?: string;
  logger?: Logger;
}

const DEFAULT_EMBEDDING_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, "\\$&");
}

export class KnowledgeGraphManager {
  private readonly supabase: SupabaseClient;
  private readonly embeddingApiKey?: string;
  private readonly embeddingApiUrl: string;
  private readonly embeddingModel: string;
  private readonly logger: Logger;

  public constructor(config: KnowledgeGraphManagerConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    this.embeddingApiKey = config.embeddingApiKey;
    this.embeddingApiUrl = config.embeddingApiUrl ?? DEFAULT_EMBEDDING_URL;
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.logger = config.logger ?? createDefaultLogger();
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    if (this.embeddingApiKey === undefined || this.embeddingApiKey === "") {
      return null;
    }

    try {
      const res = await fetch(this.embeddingApiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.embeddingApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: text.slice(0, 8000),
        }),
      });

      if (!res.ok) {
        this.logger.warn("Embedding API request failed", { status: res.status });
        return null;
      }

      const data = (await res.json()) as { data?: { embedding?: number[] }[] };
      return data.data?.[0]?.embedding ?? null;
    } catch (err) {
      this.logger.error("Embedding API error", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  public async createEntities(entities: Entity[]): Promise<Entity[]> {
    const created: Entity[] = [];
    const errors: string[] = [];

    for (const entity of entities) {
      const obsStrings = entity.observations.map(o => typeof o === "string" ? o : o.content);
      const text = `${entity.name}: ${obsStrings.join(". ")}`;
      const embedding = await this.getEmbedding(text);

      const { data, error } = await this.supabase
        .from("entities")
        .upsert(
          {
            name: entity.name,
            entity_type: entity.entityType,
            description: entity.description,
            embedding,
          },
          { onConflict: "name", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      if (error !== null || data === null) {
        this.logger.warn("Failed to create entity", { name: entity.name, error: error?.message });
        errors.push(`Failed to create entity "${entity.name}": ${error?.message ?? "unknown error"}`);
        continue;
      }

      if (entity.observations.length > 0) {
        const { data: existing } = await this.supabase
          .from("observations")
          .select("content")
          .eq("entity_id", data.id);

        const existingContents = new Set((existing ?? []).map((o) => o.content));
        
        const newObservations = entity.observations.filter(o => {
          const content = typeof o === "string" ? o : o.content;
          return !existingContents.has(content);
        });

        if (newObservations.length > 0) {
          const { error: obsError } = await this.supabase.from("observations").insert(
            newObservations.map((o) => {
              const content = typeof o === "string" ? o : o.content;
              const memory_type = typeof o === "string" ? undefined : o.memoryType;
              return {
                entity_id: data.id,
                content,
                ...(memory_type ? { memory_type } : {})
              };
            })
          );
          if (obsError !== null) {
            this.logger.warn("Failed to insert observations", { entityId: data.id, error: obsError.message });
          }
        }
      }

      const { data: obs } = await this.supabase
        .from("observations")
        .select("content")
        .eq("entity_id", data.id);

      created.push({
        name: entity.name,
        entityType: entity.entityType,
        description: entity.description,
        observations: (obs ?? []).map((o) => o.content),
      });
    }

    if (errors.length > 0) {
      this.logger.warn("create_entities completed with errors", { errors, createdCount: created.length });
    }

    return created;
  }

  public async createRelations(relations: Relation[]): Promise<Relation[]> {
    const created: Relation[] = [];

    for (const relation of relations) {
      const { data: fromEntity } = await this.supabase
        .from("entities")
        .select("id")
        .ilike("name", relation.from)
        .single();

      const { data: toEntity } = await this.supabase
        .from("entities")
        .select("id")
        .ilike("name", relation.to)
        .single();

      if (fromEntity === null || toEntity === null) {
        this.logger.warn("Skipping relation - entity not found", {
          from: relation.from,
          to: relation.to,
          fromFound: fromEntity !== null,
          toFound: toEntity !== null,
        });
        continue;
      }

      const { error } = await this.supabase.from("relations").upsert(
        {
          from_entity_id: fromEntity.id,
          to_entity_id: toEntity.id,
          relation_type: relation.relationType,
        },
        { onConflict: "from_entity_id,to_entity_id,relation_type" }
      );

      if (error !== null) {
        this.logger.warn("Failed to create relation", { from: relation.from, to: relation.to, error: error.message });
        continue;
      }

      created.push(relation);
    }

    return created;
  }

  public async addObservations(
    observations: { entityName: string; contents: (string | ObservationInput)[] }[]
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const results: { entityName: string; addedObservations: string[] }[] = [];

    for (const obs of observations) {
      const { data: entity } = await this.supabase
        .from("entities")
        .select("id")
        .ilike("name", obs.entityName)
        .single();

      if (entity === null) {
        throw new Error(`Entity with name "${obs.entityName}" not found`);
      }

      const { data: existing } = await this.supabase
        .from("observations")
        .select("content")
        .eq("entity_id", entity.id);

      const existingContents = new Set((existing ?? []).map((o) => o.content));
      const newObservations = obs.contents.filter((c) => {
        const content = typeof c === "string" ? c : c.content;
        return !existingContents.has(content);
      });

      if (newObservations.length > 0) {
        const { error: insertError } = await this.supabase.from("observations").insert(
          newObservations.map((c) => {
            const content = typeof c === "string" ? c : c.content;
            const memory_type = typeof c === "string" ? undefined : c.memoryType;
            return {
              entity_id: entity.id,
              content,
              ...(memory_type ? { memory_type } : {})
            };
          })
        );

        if (insertError !== null) {
          this.logger.error("Failed to insert observations", { entityId: entity.id, error: insertError.message });
          throw new Error(`Failed to add observations to "${obs.entityName}": ${insertError.message}`);
        }

        const { data: allObservations } = await this.supabase
          .from("observations")
          .select("content")
          .eq("entity_id", entity.id);

        const allContents = (allObservations ?? []).map((o) => o.content);
        const text = `${obs.entityName}: ${allContents.join(". ")}`;
        const embedding = await this.getEmbedding(text);
        if (embedding !== null) {
          const { error: updateError } = await this.supabase
            .from("entities")
            .update({ embedding })
            .eq("id", entity.id);
          if (updateError !== null) {
            this.logger.warn("Failed to update embedding", { entityId: entity.id, error: updateError.message });
          }
        }
      }

      results.push({
        entityName: obs.entityName,
        addedObservations: newObservations.map(c => typeof c === "string" ? c : c.content),
      });
    }

    return results;
  }

  public async deleteEntities(entityNames: string[]): Promise<{ deleted: string[]; notFound: string[] }> {
    const deleted: string[] = [];
    const notFound: string[] = [];

    for (const name of entityNames) {
      const { data: entity } = await this.supabase
        .from("entities")
        .select("name")
        .ilike("name", name)
        .single();

      if (entity === null) {
        notFound.push(name);
        continue;
      }

      const { error } = await this.supabase.from("entities").delete().eq("name", entity.name);
      if (error !== null) {
        this.logger.warn("Failed to delete entity", { name, error: error.message });
        notFound.push(name);
      } else {
        deleted.push(entity.name);
      }
    }

    return { deleted, notFound };
  }

  public async deleteObservations(
    deletions: { entityName: string; observations: string[] }[]
  ): Promise<{ entityName: string; deletedCount: number }[]> {
    const results: { entityName: string; deletedCount: number }[] = [];

    for (const del of deletions) {
      const { data: entity } = await this.supabase
        .from("entities")
        .select("id")
        .ilike("name", del.entityName)
        .single();

      if (entity !== null) {
        const { data: deleted, error } = await this.supabase
          .from("observations")
          .delete()
          .eq("entity_id", entity.id)
          .in("content", del.observations)
          .select("id");

        results.push({
          entityName: del.entityName,
          deletedCount: deleted?.length ?? 0,
        });

        if (error !== null) {
          this.logger.warn("Error deleting observations", { entityName: del.entityName, error: error.message });
        }
      } else {
        results.push({ entityName: del.entityName, deletedCount: 0 });
      }
    }

    return results;
  }

  public async deleteRelations(relations: Relation[]): Promise<{ deleted: number; notFound: number }> {
    let deleted = 0;
    let notFound = 0;

    for (const rel of relations) {
      const { data: fromEntity } = await this.supabase
        .from("entities")
        .select("id")
        .ilike("name", rel.from)
        .single();

      const { data: toEntity } = await this.supabase
        .from("entities")
        .select("id")
        .ilike("name", rel.to)
        .single();

      if (fromEntity === null || toEntity === null) {
        notFound++;
        continue;
      }

      const { error } = await this.supabase.from("relations").delete().match({
        from_entity_id: fromEntity.id,
        to_entity_id: toEntity.id,
        relation_type: rel.relationType,
      });

      if (error !== null) {
        this.logger.warn("Failed to delete relation", { from: rel.from, to: rel.to, error: error.message });
        notFound++;
      } else {
        deleted++;
      }
    }

    return { deleted, notFound };
  }

  public async readGraph(): Promise<KnowledgeGraph> {
    const { data: entities, error: entitiesError } = await this.supabase
      .from("entities")
      .select("id, name, entity_type");

    if (entitiesError !== null) {
      this.logger.error("Failed to fetch entities", { error: entitiesError.message });
      return { entities: [], relations: [] };
    }

    const { data: observations, error: obsError } = await this.supabase
      .from("observations")
      .select("entity_id, content");

    if (obsError !== null) {
      this.logger.error("Failed to fetch observations", { error: obsError.message });
    }

    const entityIds = (entities ?? []).map((e) => e.id);
    const { data: relations, error: relError } = await this.supabase
      .from("relations")
      .select("from_entity_id, to_entity_id, relation_type")
      .in("from_entity_id", entityIds)
      .in("to_entity_id", entityIds);

    if (relError !== null) {
      this.logger.error("Failed to fetch relations", { error: relError.message });
    }

    const entityMap = new Map<number, { name: string; entityType: string; observations: string[] }>(
      (entities ?? []).map((e) => [e.id, { name: e.name, entityType: e.entity_type, observations: [] }])
    );

    for (const obs of observations ?? []) {
      const entity = entityMap.get(obs.entity_id);
      if (entity !== undefined) {
        entity.observations.push(obs.content);
      }
    }

    const idToName = new Map<number, string>((entities ?? []).map((e) => [e.id, e.name]));

    const formattedRelations: Relation[] = (relations ?? [])
      .map((r): Relation | null => {
        const from = idToName.get(r.from_entity_id);
        const to = idToName.get(r.to_entity_id);
        if (from !== undefined && to !== undefined) {
          return { from, to, relationType: r.relation_type };
        }
        return null;
      })
      .filter((r): r is Relation => r !== null);

    return {
      entities: Array.from(entityMap.values()),
      relations: formattedRelations,
    };
  }

  public async searchNodes(query: string): Promise<KnowledgeGraph> {
    const embedding = await this.getEmbedding(query);

    if (embedding === null) {
      return this.fallbackSearch(query);
    }

    const { data, error } = await this.supabase.rpc("match_entities", {
      query_embedding: embedding,
      match_count: 20,
    });

    if (error !== null || data === null || data.length === 0) {
      this.logger.warn("Vector search failed, falling back to text search", { error: error?.message });
      return this.fallbackSearch(query);
    }

    const entityIds = data.map((m: MatchResult) => m.id);
    const entityNames = new Set(data.map((m: MatchResult) => m.name));

    const { data: observations } = await this.supabase
      .from("observations")
      .select("entity_id, content")
      .in("entity_id", entityIds);

    const entityMap = new Map<string, SearchMatch>();

    for (const match of data) {
      entityMap.set(match.name, {
        name: match.name,
        entityType: match.entity_type,
        observations: [],
        similarity: match.similarity,
      });
    }

    for (const obs of observations ?? []) {
      const matchingEntity = data.find((m: MatchResult) => m.id === obs.entity_id);
      if (matchingEntity !== undefined) {
        const entity = entityMap.get(matchingEntity.name);
        if (entity !== undefined) {
          entity.observations.push(obs.content);
        }
      }
    }

    const { data: relations } = await this.supabase
      .from("relations")
      .select("from_entity_id, to_entity_id, relation_type")
      .in("from_entity_id", entityIds)
      .in("to_entity_id", entityIds);

    const idToName = new Map<number, string>(data.map((m: MatchResult) => [m.id, m.name]));

    const filteredRelations: Relation[] = (relations ?? [])
      .map((r): Relation | null => {
        const from = idToName.get(r.from_entity_id);
        const to = idToName.get(r.to_entity_id);
        if (from !== undefined && to !== undefined && entityNames.has(from) && entityNames.has(to)) {
          return { from, to, relationType: r.relation_type };
        }
        return null;
      })
      .filter((r): r is Relation => r !== null);

    return {
      entities: Array.from(entityMap.values()),
      relations: filteredRelations,
    };
  }

  private async fallbackSearch(query: string): Promise<KnowledgeGraph> {
    const escapedQuery = escapeLikePattern(query);

    const { data: entities } = await this.supabase
      .from("entities")
      .select("id, name, entity_type")
      .or(`name.ilike.%${escapedQuery}%,entity_type.ilike.%${escapedQuery}%`);

    const { data: matchingObs } = await this.supabase
      .from("observations")
      .select("entity_id")
      .ilike("content", `%${escapedQuery}%`);

    const obsEntityIds = new Set((matchingObs ?? []).map((o) => o.entity_id));

    const allEntities = [...(entities ?? [])];
    if (obsEntityIds.size > 0) {
      const existingIds = new Set(allEntities.map((e) => e.id));
      const additionalIds = Array.from(obsEntityIds).filter((id) => !existingIds.has(id));

      if (additionalIds.length > 0) {
        const { data: additionalEntities } = await this.supabase
          .from("entities")
          .select("id, name, entity_type")
          .in("id", additionalIds);

        for (const e of additionalEntities ?? []) {
          allEntities.push(e);
        }
      }
    }

    if (allEntities.length === 0) {
      return { entities: [], relations: [] };
    }

    const entityIds = allEntities.map((e) => e.id);
    const entityNames = new Set(allEntities.map((e) => e.name));

    const { data: observations } = await this.supabase
      .from("observations")
      .select("entity_id, content")
      .in("entity_id", entityIds);

    const entityMap = new Map<number, { name: string; entityType: string; observations: string[] }>(
      allEntities.map((e) => [e.id, { name: e.name, entityType: e.entity_type, observations: [] }])
    );

    for (const obs of observations ?? []) {
      const entity = entityMap.get(obs.entity_id);
      if (entity !== undefined) {
        entity.observations.push(obs.content);
      }
    }

    const { data: relations } = await this.supabase
      .from("relations")
      .select("from_entity_id, to_entity_id, relation_type")
      .in("from_entity_id", entityIds)
      .in("to_entity_id", entityIds);

    const idToName = new Map<number, string>(allEntities.map((e) => [e.id, e.name]));

    const filteredRelations: Relation[] = (relations ?? [])
      .map((r): Relation | null => {
        const from = idToName.get(r.from_entity_id);
        const to = idToName.get(r.to_entity_id);
        if (from !== undefined && to !== undefined && entityNames.has(from) && entityNames.has(to)) {
          return { from, to, relationType: r.relation_type };
        }
        return null;
      })
      .filter((r): r is Relation => r !== null);

    return {
      entities: Array.from(entityMap.values()),
      relations: filteredRelations,
    };
  }

  public async openNodes(names: string[]): Promise<KnowledgeGraph> {
    if (names.length === 0) {
      return { entities: [], relations: [] };
    }

    const ilikeFilters = names.map((n) => `name.ilike.%${escapeLikePattern(n)}%`).join(",");
    const { data: entities } = await this.supabase
      .from("entities")
      .select("id, name, entity_type")
      .or(ilikeFilters);

    if (entities === null || entities.length === 0) {
      return { entities: [], relations: [] };
    }

    const entityIds = entities.map((e) => e.id);
    const entityNames = new Set(entities.map((e) => e.name));

    const { data: observations } = await this.supabase
      .from("observations")
      .select("entity_id, content")
      .in("entity_id", entityIds);

    const entityMap = new Map<number, { name: string; entityType: string; observations: string[] }>(
      entities.map((e) => [e.id, { name: e.name, entityType: e.entity_type, observations: [] }])
    );

    for (const obs of observations ?? []) {
      const entity = entityMap.get(obs.entity_id);
      if (entity !== undefined) {
        entity.observations.push(obs.content);
      }
    }

    const { data: relations } = await this.supabase
      .from("relations")
      .select("from_entity_id, to_entity_id, relation_type")
      .in("from_entity_id", entityIds)
      .in("to_entity_id", entityIds);

    const idToName = new Map<number, string>(entities.map((e) => [e.id, e.name]));

    const filteredRelations: Relation[] = (relations ?? [])
      .map((r): Relation | null => {
        const from = idToName.get(r.from_entity_id);
        const to = idToName.get(r.to_entity_id);
        if (from !== undefined && to !== undefined && entityNames.has(from) && entityNames.has(to)) {
          return { from, to, relationType: r.relation_type };
        }
        return null;
      })
      .filter((r): r is Relation => r !== null);

    return {
      entities: Array.from(entityMap.values()),
      relations: filteredRelations,
    };
  }
}

export async function generateDigest(supabase: SupabaseClient, budget = 150): Promise<string> {
  const pinnedTypes = ["Person", "Preference", "Goal"];
  const pinnedCap = 50;

  const { data: pinned } = await supabase
    .from("entities")
    .select("id, name, entity_type, description, updated_at")
    .in("entity_type", pinnedTypes)
    .order("updated_at", { ascending: false })
    .limit(pinnedCap);

  const remaining = budget - (pinned?.length ?? 0);
  const { data: recent } = await supabase
    .from("entities")
    .select("id, name, entity_type, description, updated_at")
    .not("entity_type", "in", `(${pinnedTypes.map(t => `'${t}'`).join(",")})`)
    .order("updated_at", { ascending: false })
    .limit(remaining);

  const allEntities = [...(pinned ?? []), ...(recent ?? [])];
  if (allEntities.length === 0) {
    return "Graph is empty.";
  }

  const idsWithoutDesc = allEntities.filter(e => !e.description).map(e => e.id);
  const firstObsMap = new Map<number, string>();
  
  if (idsWithoutDesc.length > 0) {
    const { data: firstObs } = await supabase
      .from("observations")
      .select("entity_id, content")
      .in("entity_id", idsWithoutDesc)
      .order("created_at", { ascending: true }); // get oldest first
      
    // Map just one observation per entity
    for (const obs of firstObs ?? []) {
      if (!firstObsMap.has(obs.entity_id)) {
        firstObsMap.set(obs.entity_id, obs.content);
      }
    }
  }

  // Group by type
  const grouped = new Map<string, typeof allEntities>();
  for (const e of allEntities) {
    const type = e.entity_type;
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    grouped.get(type)!.push(e);
  }

  const lines: string[] = [];
  
  for (const [type, items] of grouped.entries()) {
    lines.push(`## ${type}s (${items.length})`);
    for (const e of items) {
      let desc = e.description || firstObsMap.get(e.id) || "No description";
      // Truncate desc if very long
      if (desc.length > 100) desc = desc.slice(0, 97) + "...";
      
      const updatedDate = new Date(e.updated_at).toISOString().split('T')[0];
      lines.push(`- **${e.name}** — ${desc} (${updatedDate})`);
    }
    lines.push("");
  }

  const { count: entityCount } = await supabase.from("entities").select("*", { count: "exact", head: true });
  const { count: obsCount } = await supabase.from("observations").select("*", { count: "exact", head: true });
  const { count: relCount } = await supabase.from("relations").select("*", { count: "exact", head: true });

  lines.push(`Graph contains ${entityCount ?? 0} entities, ${obsCount ?? 0} observations, ${relCount ?? 0} relations. Last extraction: ${new Date().toISOString()}`);

  return lines.join("\n");
}

import { Entity, Relation, KnowledgeGraph, SearchMatch } from "./types.js";

interface Database {
  public: {
    Tables: {
      entities: {
        Row: {
          id: number;
          name: string;
          entity_type: string;
          embedding: number[] | null;
        };
        Insert: {
          id?: number;
          name: string;
          entity_type: string;
          embedding?: number[] | null;
        };
        Update: {
          id?: number;
          name?: string;
          entity_type?: string;
          embedding?: number[] | null;
        };
      };
      observations: {
        Row: {
          id: number;
          entity_id: number;
          content: string;
        };
        Insert: {
          id?: number;
          entity_id: number;
          content: string;
        };
        Update: {
          id?: number;
          entity_id?: number;
          content?: string;
        };
      };
      relations: {
        Row: {
          id: number;
          from_entity_id: number;
          to_entity_id: number;
          relation_type: string;
        };
        Insert: {
          id?: number;
          from_entity_id: number;
          to_entity_id: number;
          relation_type: string;
        };
        Update: {
          id?: number;
          from_entity_id?: number;
          to_entity_id?: number;
          relation_type?: string;
        };
      };
    };
    Functions: {
      match_entities: {
        Args: {
          query_embedding: number[];
          match_count: number;
        };
        Returns: Array<{
          id: number;
          name: string;
          entity_type: string;
          similarity: number;
        }>;
      };
    };
  };
}

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface KnowledgeGraphManagerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  embeddingApiKey?: string;
  embeddingApiUrl?: string;
  embeddingModel?: string;
}

export class KnowledgeGraphManager {
  private readonly supabase: SupabaseClient<Database>;
  private readonly embeddingApiKey?: string;
  private readonly embeddingApiUrl: string;
  private readonly embeddingModel: string;

  public constructor(config: KnowledgeGraphManagerConfig) {
    this.supabase = createClient<Database>(config.supabaseUrl, config.supabaseKey);
    this.embeddingApiKey = config.embeddingApiKey;
    this.embeddingApiUrl = config.embeddingApiUrl ?? "https://openrouter.ai/api/v1/embeddings";
    this.embeddingModel = config.embeddingModel ?? "openai/text-embedding-3-small";
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
        return null;
      }

      const data = (await res.json()) as { data?: { embedding?: number[] }[] };
      return data.data?.[0]?.embedding ?? null;
    } catch {
      return null;
    }
  }

  public async createEntities(entities: Entity[]): Promise<Entity[]> {
    const created: Entity[] = [];

    for (const entity of entities) {
      const text = `${entity.name}: ${entity.observations.join(". ")}`;
      const embedding = await this.getEmbedding(text);

      const { data, error } = await this.supabase
        .from("entities")
        .upsert(
          {
            name: entity.name,
            entity_type: entity.entityType,
            embedding,
          },
          { onConflict: "name", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      if (error !== null || data === null) {
        continue;
      }

      if (entity.observations.length > 0) {
        const { data: existing } = await this.supabase
          .from("observations")
          .select("content")
          .eq("entity_id", data.id);

        const existingContents = new Set((existing ?? []).map((o) => o.content));
        const newObservations = entity.observations.filter((o) => !existingContents.has(o));

        if (newObservations.length > 0) {
          await this.supabase.from("observations").insert(
            newObservations.map((content) => ({
              entity_id: data.id,
              content,
            }))
          );
        }
      }

      const { data: obs } = await this.supabase
        .from("observations")
        .select("content")
        .eq("entity_id", data.id);

      created.push({
        name: entity.name,
        entityType: entity.entityType,
        observations: (obs ?? []).map((o) => o.content),
      });
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

      if (error === null) {
        created.push(relation);
      }
    }

    return created;
  }

  public async addObservations(
    observations: { entityName: string; contents: string[] }[]
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const results: { entityName: string; addedObservations: string[] }[] = [];

    for (const obs of observations) {
      const { data: entity } = await this.supabase
        .from("entities")
        .select("id")
        .ilike("name", obs.entityName)
        .single();

      if (entity === null) {
        throw new Error(`Entity with name ${obs.entityName} not found`);
      }

      const { data: existing } = await this.supabase
        .from("observations")
        .select("content")
        .eq("entity_id", entity.id);

      const existingContents = new Set((existing ?? []).map((o) => o.content));
      const newObservations = obs.contents.filter((c) => !existingContents.has(c));

      if (newObservations.length > 0) {
        await this.supabase.from("observations").insert(
          newObservations.map((content) => ({
            entity_id: entity.id,
            content,
          }))
        );

        const text = `${obs.entityName}: ${newObservations.join(". ")}`;
        const embedding = await this.getEmbedding(text);
        if (embedding !== null) {
          await this.supabase.from("entities").update({ embedding }).eq("id", entity.id);
        }
      }

      results.push({
        entityName: obs.entityName,
        addedObservations: newObservations,
      });
    }

    return results;
  }

  public async deleteEntities(entityNames: string[]): Promise<void> {
    for (const name of entityNames) {
      await this.supabase.from("entities").delete().ilike("name", name);
    }
  }

  public async deleteObservations(
    deletions: { entityName: string; observations: string[] }[]
  ): Promise<void> {
    for (const del of deletions) {
      const { data: entity } = await this.supabase
        .from("entities")
        .select("id")
        .ilike("name", del.entityName)
        .single();

      if (entity !== null) {
        await this.supabase
          .from("observations")
          .delete()
          .eq("entity_id", entity.id)
          .in("content", del.observations);
      }
    }
  }

  public async deleteRelations(relations: Relation[]): Promise<void> {
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

      if (fromEntity !== null && toEntity !== null) {
        await this.supabase.from("relations").delete().match({
          from_entity_id: fromEntity.id,
          to_entity_id: toEntity.id,
          relation_type: rel.relationType,
        });
      }
    }
  }

  public async readGraph(): Promise<KnowledgeGraph> {
    const { data: entities } = await this.supabase
      .from("entities")
      .select("id, name, entity_type");

    const { data: observations } = await this.supabase
      .from("observations")
      .select("entity_id, content");

    const { data: relations } = await this.supabase
      .from("relations")
      .select("from_entity_id, to_entity_id, relation_type");

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

    if (error !== null || data === null) {
      return this.fallbackSearch(query);
    }

    const entityIds = new Set(data.map((m) => m.id));
    const entityNames = new Set(data.map((m) => m.name));

    const { data: observations } = await this.supabase
      .from("observations")
      .select("entity_id, content")
      .in("entity_id", Array.from(entityIds));

    const entityMap = new Map<string, Entity & { similarity?: number }>();

    for (const match of data) {
      entityMap.set(match.name, {
        name: match.name,
        entityType: match.entity_type,
        observations: [],
        similarity: match.similarity,
      } as SearchMatch);
    }

    for (const obs of observations ?? []) {
      const matchingEntity = data.find((m) => m.id === obs.entity_id);
      if (matchingEntity !== undefined) {
        const entity = entityMap.get(matchingEntity.name);
        if (entity !== undefined) {
          entity.observations.push(obs.content);
        }
      }
    }

    const { data: relations } = await this.supabase
      .from("relations")
      .select("from_entity_id, to_entity_id, relation_type");

    const idToName = new Map<number, string>(data.map((m) => [m.id, m.name]));

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
    const { data: entities } = await this.supabase
      .from("entities")
      .select("id, name, entity_type")
      .or(`name.ilike.%${query}%,entity_type.ilike.%${query}%`);

    const { data: matchingObs } = await this.supabase
      .from("observations")
      .select("entity_id")
      .ilike("content", `%${query}%`);

    const obsEntityIds = new Set((matchingObs ?? []).map((o) => o.entity_id));

    const allEntities = [...(entities ?? [])];
    if (obsEntityIds.size > 0) {
      const { data: additionalEntities } = await this.supabase
        .from("entities")
        .select("id, name, entity_type")
        .in("id", Array.from(obsEntityIds));

      const existingIds = new Set(allEntities.map((e) => e.id));
      for (const e of additionalEntities ?? []) {
        if (!existingIds.has(e.id)) {
          allEntities.push(e);
        }
      }
    }

    if (allEntities.length === 0) {
      return { entities: [], relations: [] };
    }

    const entityIds = new Set(allEntities.map((e) => e.id));
    const entityNames = new Set(allEntities.map((e) => e.name));

    const { data: observations } = await this.supabase
      .from("observations")
      .select("entity_id, content")
      .in("entity_id", Array.from(entityIds));

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
      .select("from_entity_id, to_entity_id, relation_type");

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
    const { data: entities } = await this.supabase
      .from("entities")
      .select("id, name, entity_type")
      .in("name", names);

    if (entities === null || entities.length === 0) {
      return { entities: [], relations: [] };
    }

    const entityIds = new Set(entities.map((e) => e.id));
    const entityNames = new Set(entities.map((e) => e.name));

    const { data: observations } = await this.supabase
      .from("observations")
      .select("entity_id, content")
      .in("entity_id", Array.from(entityIds));

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
      .select("from_entity_id, to_entity_id, relation_type");

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

-- Enable pgvector extension
create extension if not exists vector;

-- Entities table
create table if not exists entities (
  id bigserial primary key,
  name text unique not null,
  entity_type text not null default 'thing',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  embedding vector(1536)
);

-- Observations table
create table if not exists observations (
  id bigserial primary key,
  entity_id bigint references entities(id) on delete cascade,
  content text not null,
  created_at timestamptz default now()
);

-- Relations table
create table if not exists relations (
  id bigserial primary key,
  from_entity_id bigint references entities(id) on delete cascade,
  to_entity_id bigint references entities(id) on delete cascade,
  relation_type text not null,
  constraint unique_relation unique(from_entity_id, to_entity_id, relation_type)
);

-- Enable Row Level Security
alter table entities enable row level security;
alter table observations enable row level security;
alter table relations enable row level security;

-- RLS Policies: Allow all access
-- These policies permit all operations for authenticated/service role users
-- Service role keys bypass RLS by default, but policies are required by Supabase
-- For multi-tenant use, replace these with user-scoped policies
create policy "Allow all access" on entities
  for all using (true) with check (true);

create policy "Allow all access" on observations
  for all using (true) with check (true);

create policy "Allow all access" on relations
  for all using (true) with check (true);

-- Trigger to auto-update updated_at timestamp
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_entities_updated_at
  before update on entities
  for each row
  execute function update_updated_at_column();

-- Vector similarity search index (HNSW)
create index if not exists idx_entities_embedding 
  on entities using hnsw (embedding vector_cosine_ops);

-- Full-text search indexes for fallback text search
create index if not exists idx_entities_name_fts 
  on entities using gin(to_tsvector('english', name));
create index if not exists idx_observations_content_fts 
  on observations using gin(to_tsvector('english', content));

-- Function for semantic search
create or replace function match_entities(
  query_embedding vector(1536),
  match_count int default 10
)
returns table (
  id bigint,
  name text,
  entity_type text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    e.id,
    e.name,
    e.entity_type,
    1 - (e.embedding <=> query_embedding) as similarity
  from entities e
  where e.embedding is not null
  order by e.embedding <=> query_embedding
  limit match_count;
end;
$$;

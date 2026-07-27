-- OpenRouter provider swap: embedding model nvidia/nemotron-3-embed-1b:free
-- outputs 2048-dim vectors (fixed, not configurable) instead of the old
-- 1536-dim OpenAI text-embedding-3-small. doc_chunks has 0 rows (never
-- ingested), so this is a clean column-type swap, not a real migration.

-- ponytail: pgvector's hnsw/ivfflat indexes cap out at 2000 dimensions, so a
-- vector(2048) column can't be indexed as-is. Dropping the index and relying
-- on a sequential scan (order by embedding <=> query_embedding limit n) is
-- fine for a docs corpus this size. If doc_chunks grows large enough that
-- scan latency matters, switch the column to halfvec(2048) and index that
-- (halfvec supports hnsw/ivfflat up to 4000 dims).
drop index if exists doc_chunks_embedding_idx;

alter table doc_chunks
  alter column embedding type vector(2048);

create or replace function match_doc_chunks(
  query_embedding vector(2048),
  match_count int default 5
)
returns table (
  id uuid,
  source_url text,
  title text,
  content text,
  section text,
  similarity float
)
language sql stable
as $$
  select id, source_url, title, content, section,
         1 - (embedding <=> query_embedding) as similarity
  from doc_chunks
  order by embedding <=> query_embedding
  limit match_count
$$;

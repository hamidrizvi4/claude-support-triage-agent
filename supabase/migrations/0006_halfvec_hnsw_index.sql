-- 0006: make doc search indexable again.
--
-- NOT YET APPLIED to the live project at the time of writing; apply it from
-- the Supabase SQL editor (or `supabase db push`).
--
-- Why: 0003 moved embeddings to vector(2048), past pgvector's 2000-dimension
-- limit for HNSW/IVFFlat on `vector`, so match_doc_chunks has been an exact
-- scan over every row. After the 2026-11 re-embed (every row rewritten) that
-- scan started hitting the statement timeout under modest concurrency. halfvec
-- indexes up to 4000 dims and halves the storage; cosine ranking at half
-- precision is effectively unchanged for retrieval.
--
-- Run separately first, outside a transaction, to reclaim the space the
-- re-embed left behind:
--   vacuum (full, analyze) doc_chunks;

alter table doc_chunks
  alter column embedding type halfvec(2048) using embedding::halfvec(2048);

create index if not exists doc_chunks_embedding_hnsw
  on doc_chunks using hnsw (embedding halfvec_cosine_ops);

-- Same signature as before (callers still pass vector(2048)); the query is
-- cast to halfvec so the index is used.
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
set search_path = public, pg_temp
as $$
  select id, source_url, title, content, section,
         1 - (embedding <=> query_embedding::halfvec(2048)) as similarity
  from doc_chunks
  where embedding is not null
  order by embedding <=> query_embedding::halfvec(2048)
  limit match_count
$$;

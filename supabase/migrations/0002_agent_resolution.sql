-- Day 2: columns to persist the agent's own submit_resolution output, and
-- the vector-search RPC backing the search_docs / check_pricing tools.

alter table draft_responses
  add column category text,
  add column escalation_reason text,
  add column retrieval_score numeric,
  add column self_certainty numeric;

-- Mirrors the submit_resolution tool's category enum in CLAUDE.md. This is a
-- finer-grained taxonomy than tickets.category (which stays as seeded by
-- generate-tickets.ts and is never overwritten by the agent).
alter table draft_responses
  add constraint draft_responses_category_check check (
    category in (
      'technical_api_error', 'billing', 'feature_question',
      'account_access', 'security_abuse', 'sales_enterprise', 'bug_report'
    )
  );

create or replace function match_doc_chunks(
  query_embedding vector(1536),
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

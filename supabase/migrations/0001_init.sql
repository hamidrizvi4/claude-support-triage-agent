-- Day 1 schema: data foundation for the support triage agent.
-- Agent tool-calling, review UI, and reporting come later (Day 2/3).

create extension if not exists vector;
create extension if not exists pgcrypto; -- gen_random_uuid()

-- Mocked accounts only. No real Anthropic customer/account data.
create table accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_tier text not null check (plan_tier in ('free', 'build', 'scale', 'enterprise')),
  monthly_usage numeric not null default 0,
  rate_limit integer not null
);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  body text not null,
  category text not null check (
    category in ('informational', 'billing', 'security', 'sales', 'bug', 'ambiguous')
  ),
  account_id uuid references accounts(id),
  status text not null default 'new' check (status in ('new', 'auto_resolved', 'escalated', 'reviewed')),
  confidence numeric,
  created_at timestamptz not null default now()
);

create table doc_chunks (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  title text not null,
  content text not null,
  embedding vector(1536),
  section text,
  created_at timestamptz not null default now()
);

create index doc_chunks_embedding_idx on doc_chunks
  using hnsw (embedding vector_cosine_ops);

create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  tool_name text not null,
  input jsonb not null,
  output jsonb,
  created_at timestamptz not null default now()
);

create table draft_responses (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  draft_text text not null,
  citations jsonb not null default '[]',
  confidence numeric,
  created_at timestamptz not null default now()
);

create table reviews (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  reviewer text not null,
  action text not null check (action in ('approve', 'edit_and_approve', 'reject')),
  edited_response text,
  created_at timestamptz not null default now()
);

-- A handful of mocked accounts for synthetic tickets to reference.
insert into accounts (name, plan_tier, monthly_usage, rate_limit) values
  ('Acme Robotics', 'free', 42.10, 60),
  ('Northwind Analytics', 'build', 1875.32, 300),
  ('Globex Data Labs', 'scale', 41200.00, 4000),
  ('Initech Platform', 'enterprise', 128900.55, 20000),
  ('Contoso AI Tools', 'build', 960.00, 300),
  ('Umbrella DevTools', 'free', 8.75, 60);

-- Security fix: RLS was disabled on all 6 public tables (ERROR-level advisor
-- finding — ANY row on ANY table is readable/writable via PostgREST). Worse,
-- 0004 granted anon/authenticated full ALL-privilege access as a fix for a
-- different problem (service_role had zero grants). The app is 100%
-- server-side today (service_role, which carries rolbypassrls=true), so
-- nothing here breaks current behavior — but the anon grant meant the first
-- client-side supabase-js call added with the publishable key would get
-- unauthenticated read/write on tickets, reviews, everything.
--
-- Two independent layers, either one alone would close the hole:
--   1. Revoke anon/authenticated's table/sequence/routine grants (incl. the
--      default-privilege versions, so future tables aren't exposed either).
--   2. Enable RLS with zero policies, which default-denies every role except
--      the table owner and BYPASSRLS roles (service_role).
-- service_role keeps its 0004 grants — it still needs them; BYPASSRLS skips
-- policy checks, not the underlying grant system.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all routines in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on routines from anon, authenticated;

alter table accounts enable row level security;
alter table tickets enable row level security;
alter table doc_chunks enable row level security;
alter table tool_calls enable row level security;
alter table draft_responses enable row level security;
alter table reviews enable row level security;

-- Function search-path hijacking (WARN): match_doc_chunks had no pinned
-- search_path, so a role that can create objects earlier in a caller's
-- search_path could shadow `doc_chunks` or the vector `<=>` operator. Pin it
-- to a fixed, known list.
alter function match_doc_chunks(vector, integer) set search_path = public, pg_temp;

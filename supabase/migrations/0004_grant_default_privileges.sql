-- Restores Supabase's standard grant bootstrap: anon/authenticated/service_role
-- had zero table/sequence/routine grants on the public schema (confirmed via
-- information_schema.role_table_grants — empty for all three roles on every
-- table), unrelated to RLS (which is separately disabled, and service_role
-- has rolbypassrls=true regardless). Without this every REST/PostgREST call
-- from the app — including the service-role admin client the scripts use —
-- gets "permission denied for table X" on all six tables.

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;

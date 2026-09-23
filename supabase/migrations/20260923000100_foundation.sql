-- ============================================================================
-- 0001 · Foundation
-- Extensions, the private schema, locked-down default privileges and shared
-- trigger helpers. Every later migration relies on the defaults set here:
-- nothing created in `public` is reachable by `anon` or `authenticated` until a
-- migration grants it explicitly.
-- ============================================================================

-- PostGIS lives in `extensions` (never `public`) so its tables and functions
-- are not exposed through the Data API.
create extension if not exists postgis with schema extensions;

-- Internal helpers, queues and trigger functions. Not exposed by the Data API.
create schema if not exists private;
revoke all on schema private from public;
-- RLS policies call helper functions in this schema as the `authenticated`
-- role, which needs USAGE on the schema (EXECUTE is granted per function).
grant usage on schema private to authenticated;

-- Supabase grants anon/authenticated full access to new objects in `public`
-- by default. Remove that for everything our migrations create.
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- PUBLIC gets EXECUTE on new functions globally; that default can only be
-- revoked globally (not per schema).
alter default privileges for role postgres revoke execute on functions from public;

-- Keeps `updated_at` current on every UPDATE.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Casts text to uuid, returning NULL instead of raising on malformed input.
-- Used by Storage policies, which must never error on an arbitrary path.
create function private.try_uuid(p_value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

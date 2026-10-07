-- ============================================================================
-- Staging pre-flight — READ ONLY. Run before any migration is applied.
--
-- Stops the deployment (raises) if the target project is not a clean,
-- compatible staging project, or if the connecting role lacks a permission
-- the migrations rely on — so an incompatibility is found before anything is
-- changed rather than half-way through the migrations.
--
-- Two modes:
--   fresh        nothing deployed yet: the project must be empty (the first
--                deployment, as before).
--   incremental  an earlier deployment completed: the migrations recorded on
--                staging must be EXACTLY the first N migrations in the
--                repository (same versions, same order, no gaps, nothing
--                unknown), with at least one newer migration pending. Any
--                other history stops the deployment; nothing is repaired.
-- Incremental mode needs the repository's migration versions, passed by the
-- workflow as  -v repo_versions=<comma-separated versions>. Without it
-- (e.g. the read-only probe) only fresh mode is accepted.
-- Everything runs inside one READ ONLY transaction that is rolled back at
-- the end. (Startup options such as PGOPTIONS are not forwarded by the
-- Supabase connection pooler, so read-only mode is set here, in-session,
-- and verified before anything else runs.)
-- ============================================================================
\set ON_ERROR_STOP on
\pset footer off

begin transaction read only;
do $$
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'pre-flight refused to run: the session is not read-only';
  end if;
end;
$$;

\echo '--- connection'
select current_user as connected_as,
       current_setting('server_version') as postgres_version,
       current_setting('transaction_read_only') as read_only_transaction;

\if :{?repo_versions}
select set_config('preflight.repo_versions', :'repo_versions', false);
\else
select set_config('preflight.repo_versions', '', false);
\endif

\echo '--- current contents (empty for a first deployment)'
select (select count(*) from pg_tables where schemaname = 'public')                              as public_tables,
       (select count(*) from pg_namespace where nspname = 'private')                              as private_schema,
       (select count(*) from storage.buckets)                                                     as storage_buckets,
       (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects')  as storage_object_policies,
       (select count(*) from auth.users)                                                          as auth_users,
       (select coalesce(n.nspname, '(not installed)') from pg_extension e
          join pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis')              as postgis_schema,
       (select count(*) from pg_available_extensions where name = 'postgis')                     as postgis_available;

\echo '--- permissions the migrations need'
select has_table_privilege('auth.users', 'TRIGGER')                                   as can_create_auth_user_trigger,
       has_table_privilege('auth.users', 'REFERENCES')                                as can_reference_auth_users,
       (select pg_has_role(current_user, c.relowner, 'USAGE')
          from pg_class c where c.oid = 'storage.objects'::regclass)                  as owns_storage_objects,
       coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb
                  -> current_user ? 'storage.objects', false)                         as storage_policy_grant,
       coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb
                  -> current_user ? 'realtime.messages', false)                       as realtime_policy_grant,
       to_regprocedure('realtime.send(jsonb, text, text, boolean)') is not null        as realtime_send_available,
       has_table_privilege('storage.buckets', 'INSERT')                               as can_create_buckets,
       has_schema_privilege('extensions', 'CREATE')                                   as can_use_extensions_schema,
       has_database_privilege(current_database(), 'CREATE')                           as can_create_schemas,
       pg_has_role(current_user, 'authenticated', 'MEMBER')                           as can_test_as_authenticated,
       pg_has_role(current_user, 'anon', 'MEMBER')                                    as can_test_as_anon;

\echo '--- triggers Supabase already has on storage.objects (for diagnosis)'
select tgname as trigger_name, pg_get_triggerdef(oid) as definition
from pg_trigger where tgrelid = 'storage.objects'::regclass and not tgisinternal order by 1;

do $$
declare
  problems text[] := '{}';
  applied  bigint := 0;
  repo     text[] := array_remove(string_to_array(current_setting('preflight.repo_versions'), ','), '');
  recorded text[] := '{}';
  mode     text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select count(*), coalesce(array_agg(version::text order by version), ''{}'') from supabase_migrations.schema_migrations'
      into applied, recorded;
  end if;
  mode := case when applied > 0 then 'incremental' else 'fresh' end;
  raise notice 'pre-flight mode: % (% migrations recorded on staging, % in the repository)', mode, applied, coalesce(array_length(repo, 1), 0);

  if mode = 'incremental' then
    -- An earlier deployment completed: only an exact prefix of the
    -- repository's history is accepted, with newer migrations pending.
    if coalesce(array_length(repo, 1), 0) = 0 then
      problems := array_append(problems, format(
        '%s migrations are already recorded in supabase_migrations, and no repository migration list was given (only a first deployment can run without it)', applied));
    elsif repo <> (select array_agg(v order by v) from unnest(repo) v) or cardinality(repo) <> (select count(distinct v) from unnest(repo) v) then
      problems := array_append(problems, 'the repository migration list is not in strictly increasing order');
    elsif applied > cardinality(repo) or recorded <> repo[1:applied] then
      problems := array_append(problems, format(
        E'the migration history on staging is not an exact prefix of the repository''s:\n      staging:    %s\n      repository: %s',
        array_to_string(recorded, ', '), array_to_string(repo, ', ')));
    elsif applied = cardinality(repo) then
      problems := array_append(problems, 'every repository migration is already recorded on staging: nothing to apply');
    else
      raise notice 'history matches the first % repository migrations; pending: %', applied, array_to_string(repo[applied + 1:], ', ');
    end if;
    -- The earlier deployment must have completed.
    if not exists (select 1 from pg_namespace where nspname = 'private') then
      problems := array_append(problems, 'migrations are recorded but the "private" schema is missing');
    end if;
    if (select count(*) from storage.buckets where id in
        ('avatars', 'community-media', 'vehicle-photos', 'journey-photos', 'location-photos', 'vehicle-documents')) <> 6 then
      problems := array_append(problems, 'migrations are recorded but the six DriveOS Storage buckets are not all present');
    end if;
  end if;

  -- First deployment: must be an empty project, nothing of ours (or anyone else's) in the way.
  if mode = 'fresh' and exists (select 1 from pg_tables where schemaname = 'public') then
    problems := array_append(problems, format('public schema already contains tables: %s',
      (select string_agg(tablename, ', ' order by tablename) from pg_tables where schemaname = 'public')));
  end if;
  if mode = 'fresh' and exists (select 1 from pg_namespace where nspname = 'private') then
    problems := array_append(problems, 'a "private" schema already exists');
  end if;
  if mode = 'fresh' and exists (select 1 from storage.buckets where id in
             ('avatars', 'community-media', 'vehicle-photos', 'journey-photos', 'location-photos', 'vehicle-documents')) then
    problems := array_append(problems, 'one or more DriveOS Storage buckets already exist');
  end if;
  if mode = 'fresh' and exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects') then
    problems := array_append(problems, 'storage.objects already has policies (the tests expect only DriveOS policies)');
  end if;
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
             where e.extname = 'postgis' and n.nspname <> 'extensions') then
    problems := array_append(problems, 'PostGIS is installed outside the "extensions" schema');
  end if;

  -- Must allow everything the migrations and tests do.
  if not exists (select 1 from pg_available_extensions where name = 'postgis') then
    problems := array_append(problems, 'PostGIS is not available on this project');
  end if;
  if not has_table_privilege('auth.users', 'TRIGGER') then
    problems := array_append(problems, 'cannot create the sign-up trigger on auth.users');
  end if;
  if not has_table_privilege('auth.users', 'REFERENCES') then
    problems := array_append(problems, 'cannot reference auth.users from profiles');
  end if;
  -- Creating policies needs ownership (plain Postgres, e.g. local tests) or,
  -- on hosted Supabase, storage.objects listed for this role in
  -- supautils.policy_grants (how Supabase lets `postgres` manage them).
  if not (select pg_has_role(current_user, c.relowner, 'USAGE') from pg_class c where c.oid = 'storage.objects'::regclass)
     and not coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb
                        -> current_user ? 'storage.objects', false) then
    problems := array_append(problems,
      'cannot create policies on storage.objects (not its owner, and not granted in supautils.policy_grants)');
  end if;
  -- Realtime presence (0017): a policy on realtime.messages and realtime.send().
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    problems := array_append(problems, 'Supabase Realtime (realtime.messages, realtime.send) is not available');
  elsif not (select pg_has_role(current_user, c.relowner, 'USAGE') from pg_class c where c.oid = 'realtime.messages'::regclass)
     and not coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb
                        -> current_user ? 'realtime.messages', false) then
    problems := array_append(problems,
      'cannot create policies on realtime.messages (not its owner, and not granted in supautils.policy_grants)');
  end if;
  if not has_table_privilege('storage.buckets', 'INSERT') then
    problems := array_append(problems, 'cannot create Storage buckets');
  end if;
  if not has_schema_privilege('extensions', 'CREATE') then
    problems := array_append(problems, 'cannot create objects in the extensions schema');
  end if;
  if not has_database_privilege(current_database(), 'CREATE') then
    problems := array_append(problems, 'cannot create schemas');
  end if;
  if not pg_has_role(current_user, 'authenticated', 'MEMBER') or not pg_has_role(current_user, 'anon', 'MEMBER') then
    problems := array_append(problems, 'cannot switch to the anon/authenticated roles needed by the security tests');
  end if;

  if array_length(problems, 1) > 0 then
    raise exception E'PRE-FLIGHT FAILED — nothing has been changed:\n  - %', array_to_string(problems, E'\n  - ');
  end if;
  if mode = 'fresh' then
    raise notice 'PRE-FLIGHT PASSED: empty staging project with every permission the migrations need';
  else
    raise notice 'PRE-FLIGHT PASSED: staging history matches the repository; every permission the migrations need';
  end if;
end;
$$;

rollback;

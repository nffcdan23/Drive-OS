-- ============================================================================
-- Staging pre-flight — READ ONLY. Run before any migration is applied.
--
-- Stops the deployment (raises) if the target project is not a clean,
-- compatible staging project, or if the connecting role lacks a permission
-- the migrations rely on — so an incompatibility is found before anything is
-- changed rather than half-way through the migrations.
-- The workflow runs this with default_transaction_read_only=on.
-- ============================================================================
\set ON_ERROR_STOP on
\pset footer off

\echo '--- connection'
select current_user as connected_as,
       current_setting('server_version') as postgres_version,
       current_setting('default_transaction_read_only') as read_only_session;

\echo '--- current contents (expected: empty staging project)'
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
          from pg_class c where c.oid = 'storage.objects'::regclass)                  as can_create_storage_policies,
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
begin
  -- Must be an empty project: nothing of ours (or anyone else's) in the way.
  if exists (select 1 from pg_tables where schemaname = 'public') then
    problems := array_append(problems, format('public schema already contains tables: %s',
      (select string_agg(tablename, ', ' order by tablename) from pg_tables where schemaname = 'public')));
  end if;
  if exists (select 1 from pg_namespace where nspname = 'private') then
    problems := array_append(problems, 'a "private" schema already exists');
  end if;
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select count(*) from supabase_migrations.schema_migrations' into applied;
    if applied > 0 then
      problems := array_append(problems, format('%s migrations are already recorded in supabase_migrations', applied));
    end if;
  end if;
  if exists (select 1 from storage.buckets where id in
             ('avatars', 'community-media', 'vehicle-photos', 'journey-photos', 'location-photos', 'vehicle-documents')) then
    problems := array_append(problems, 'one or more DriveOS Storage buckets already exist');
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects') then
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
  if not (select pg_has_role(current_user, c.relowner, 'USAGE') from pg_class c where c.oid = 'storage.objects'::regclass) then
    problems := array_append(problems, 'cannot create policies on storage.objects (not its owner)');
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
  raise notice 'PRE-FLIGHT PASSED: empty staging project with every permission the migrations need';
end;
$$;

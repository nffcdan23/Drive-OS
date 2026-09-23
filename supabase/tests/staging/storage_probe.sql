-- ============================================================================
-- Staging probe — READ ONLY. Changes nothing.
--
-- Finds out how Supabase expects Storage policies to be created, because
-- `postgres` does not own storage.objects on the hosted platform:
--   * which role owns storage.objects (and related objects)
--   * whether `postgres` can inherit or SET ROLE to that owner
--   * which privileges and platform settings (supautils) are available
--
-- Runs inside one READ ONLY transaction that is rolled back. The only role
-- switch (SET LOCAL ROLE) is reverted immediately and is itself not a write.
-- The last step deliberately attempts a write to prove it is refused.
-- ============================================================================
\set ON_ERROR_STOP on
\pset footer off

begin transaction read only;
do $$
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'probe refused to run: the session is not read-only';
  end if;
end;
$$;

\echo '--- 1. connected role'
select current_user, session_user, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolbypassrls,
       current_setting('server_version') as postgres_version,
       current_setting('transaction_read_only') as read_only_transaction
from pg_roles r where r.rolname = current_user;

\echo '--- 2. owners of the objects the migrations touch'
select n.nspname as schema, c.relname as object, pg_get_userbyid(c.relowner) as owner,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where (n.nspname, c.relname) in (('storage', 'objects'), ('storage', 'buckets'), ('auth', 'users'))
order by 1, 2;
select nspname as schema, pg_get_userbyid(nspowner) as owner
from pg_namespace where nspname in ('auth', 'storage', 'public', 'extensions') order by 1;

\echo '--- 3. relationship between the connected role and the storage.objects owner'
with o as (select pg_get_userbyid(relowner) as owner from pg_class where oid = 'storage.objects'::regclass)
select o.owner,
       pg_has_role(current_user, o.owner, 'MEMBER') as is_member,
       pg_has_role(current_user, o.owner, 'USAGE')  as inherits_owner_privileges,
       pg_has_role(current_user, o.owner, 'SET')    as can_set_role_to_owner
from o;

\echo '--- 3a. roles granted to the connected role'
select pg_get_userbyid(m.roleid) as granted_role, m.admin_option, m.inherit_option, m.set_option,
       pg_get_userbyid(m.grantor) as grantor
from pg_auth_members m
where m.member = (select oid from pg_roles where rolname = current_user)
order by 1;

\echo '--- 3b. members of the storage.objects owner role'
select pg_get_userbyid(m.member) as member, m.admin_option, m.inherit_option, m.set_option
from pg_auth_members m
where m.roleid = (select relowner from pg_class where oid = 'storage.objects'::regclass)
order by 1;

\echo '--- 4. SET ROLE to the owner (reverted immediately)'
do $$
declare
  v_owner text;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = 'storage.objects'::regclass;
  begin
    execute format('set local role %I', v_owner);
    raise notice 'SET ROLE %: ALLOWED (current_user became %)', v_owner, current_user;
    execute 'reset role';
  exception when insufficient_privilege then
    raise notice 'SET ROLE %: NOT ALLOWED (%)', v_owner, sqlerrm;
  end;
end;
$$;
select current_user as current_user_after_probe;

\echo '--- 5. privileges of the connected role on storage tables'
select t.tbl,
       has_table_privilege(t.tbl, 'SELECT')     as sel,
       has_table_privilege(t.tbl, 'INSERT')     as ins,
       has_table_privilege(t.tbl, 'UPDATE')     as upd,
       has_table_privilege(t.tbl, 'DELETE')     as del,
       has_table_privilege(t.tbl, 'TRIGGER')    as trg,
       has_table_privilege(t.tbl, 'REFERENCES') as ref
from (values ('storage.objects'), ('storage.buckets')) t(tbl);
select relname, relacl from pg_class where oid in ('storage.objects'::regclass, 'storage.buckets'::regclass);

\echo '--- 6. platform settings visible to the connected role (supautils)'
select name, setting from pg_settings where name like 'supautils.%' order by 1;
select current_setting('supautils.policy_grants', true)          as policy_grants,
       current_setting('supautils.privileged_role', true)        as privileged_role,
       current_setting('supautils.drop_trigger_grants', true)    as drop_trigger_grants,
       current_setting('supautils.reserved_roles', true)         as reserved_roles;

\echo '--- 7. existing policies and event triggers'
select schemaname, tablename, policyname, roles::text, cmd
from pg_policies where schemaname = 'storage' order by 2, 3;
select evtname, evtevent, pg_get_userbyid(evtowner) as owner, evtenabled, evtfoid::regproc as function
from pg_event_trigger order by 1;

\echo '--- 8. relevant platform roles'
select rolname, rolsuper, rolinherit, rolcreaterole, rolbypassrls, rolcanlogin
from pg_roles
where rolname in ('postgres', 'supabase_admin', 'supabase_storage_admin', 'supabase_auth_admin',
                  'authenticator', 'authenticated', 'anon', 'service_role')
order by 1;

\echo '--- 9. proof that this session cannot write'
do $$
begin
  create temporary table storage_probe_write_test (x integer);
  raise exception 'PROBE ABORTED: the session accepted a write, it is NOT read-only';
exception when read_only_sql_transaction then
  raise notice 'confirmed: writes are refused in this session';
end;
$$;

rollback;
\echo '=== PROBE COMPLETE (nothing was changed) ==='

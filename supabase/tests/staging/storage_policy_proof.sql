-- ============================================================================
-- Storage policy proof — ROLLBACK ONLY. Leaves nothing behind.
--
-- Proves, on the real project, that the role migrations run as can create a
-- policy on storage.objects (via Supabase's supautils.policy_grants), before
-- migration 0013 relies on it:
--   1. opens a transaction
--   2. creates a temporary policy that grants nothing (USING false)
--   3. confirms it exists inside the transaction
--   4. ROLLS BACK unconditionally (also on any error: psql stops and the
--      server discards the open transaction when the connection closes)
-- tests/staging/storage_policy_proof_verify.sql then checks, in a separate
-- read-only session, that the policy does not exist.
-- ============================================================================
\set ON_ERROR_STOP on
\pset footer off

begin;
-- Never wait on Storage traffic: give up rather than queue behind it.
set local lock_timeout = '5s';
set local statement_timeout = '15s';

create policy driveos_rollback_only_proof on storage.objects
  as restrictive
  for select
  to authenticated
  using (false);

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'driveos_rollback_only_proof') then
    raise exception 'PROOF FAILED: the policy was not created';
  end if;
  raise notice 'PROOF: postgres created a policy on storage.objects (current_user=%)', current_user;
end;
$$;

rollback;
\echo 'rolled back'

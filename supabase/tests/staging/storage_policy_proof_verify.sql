-- ============================================================================
-- Storage policy proof, part 2 — READ ONLY. Runs in a new session after the
-- proof and fails if the temporary policy (or any policy it could have left)
-- still exists.
-- ============================================================================
\set ON_ERROR_STOP on

begin transaction read only;
do $$
begin
  if exists (select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'driveos_rollback_only_proof') then
    raise exception 'PROOF VERIFY FAILED: the temporary policy still exists';
  end if;
  raise notice 'PROOF VERIFIED: the temporary policy does not exist (nothing was left behind)';
end;
$$;
rollback;

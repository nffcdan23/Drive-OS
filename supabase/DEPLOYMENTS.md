# Supabase deployment log

Record of every deployment of `supabase/migrations` to a hosted project.
Production is never deployed from this branch.

| Date (UTC) | Target | Migrations | Trigger | Result |
|---|---|---|---|---|
| 2026-09-23 | staging (existing project) | 0001–0015 | `[deploy supabase-staging]` commit, approved by project owner | **Not applied.** Attempt 1: secrets not visible to the workflow. Attempt 2: stopped by the pre-flight — `postgres` does not own `storage.objects`, so migration 0013 could not create Storage policies. Nothing was changed. |
| 2026-09-23 | staging (existing project) | 0001–0015 | new `[deploy supabase-staging]` commit after the rollback-only Storage policy proof passed on staging, approved by project owner | **Applied (run #5).** Pre-flight and rollback-only Storage policy proof passed; all 15 migrations recorded; schema smoke tests (74) and RLS/security tests (182, plus 2 Storage deletes covered via the Storage API) passed in rolled-back transactions with nothing left behind; 46/46 live Auth / Data API / Storage checks passed; test users and files cleaned up. Security Advisor to be checked manually. |

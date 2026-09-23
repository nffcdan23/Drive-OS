# Supabase deployment log

Record of every deployment of `supabase/migrations` to a hosted project.
Production is never deployed from this branch.

| Date (UTC) | Target | Migrations | Trigger | Result |
|---|---|---|---|---|
| 2026-09-23 | staging (existing project) | 0001–0015 | `[deploy supabase-staging]` commit, approved by project owner | **Not applied.** Attempt 1: secrets not visible to the workflow. Attempt 2: stopped by the pre-flight — `postgres` does not own `storage.objects`, so migration 0013 could not create Storage policies. Nothing was changed. |
| 2026-09-23 | staging (existing project) | 0001–0015 | new `[deploy supabase-staging]` commit after the rollback-only Storage policy proof passed on staging, approved by project owner | **Applied (run #5).** Pre-flight and rollback-only Storage policy proof passed; all 15 migrations recorded; schema smoke tests (74) and RLS/security tests (182, plus 2 Storage deletes covered via the Storage API) passed in rolled-back transactions with nothing left behind; 46/46 live Auth / Data API / Storage checks passed; test users and files cleaned up. Security Advisor to be checked manually. |

## API verification runs

Runs of the Express API against staging (`[api-test supabase-staging]`). They apply no migrations and delete everything they create.

| Date (UTC) | Commit | Result |
|---|---|---|
| 2026-09-23 | `ede9598` (run #7) | **Did not reach staging.** Typecheck failed on the runner (library declaration files not built). |
| 2026-09-23 | `0c94ec2` (run #8) | **Passed, 39/39.** Real ES256 tokens verified via JWKS; TLS connection through the session pooler; journeys, friends, private convoy with join code and limit; real Storage signed upload, confirm, signed download, 60-second document link; deletion worker removed the file; account deletion via Auth admin; 0 leftover rows. |

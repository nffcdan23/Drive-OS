# Supabase deployment log

Record of every deployment of `supabase/migrations` to a hosted project.
Production is never deployed by these workflows. Since 2026-09-28, staging
deploys run only from `main`.

| Date (UTC) | Target | Migrations | Trigger | Result |
|---|---|---|---|---|
| 2026-09-23 | staging (existing project) | 0001–0015 | `[deploy supabase-staging]` commit, approved by project owner | **Not applied.** Attempt 1: secrets not visible to the workflow. Attempt 2: stopped by the pre-flight — `postgres` does not own `storage.objects`, so migration 0013 could not create Storage policies. Nothing was changed. |
| 2026-09-23 | staging (existing project) | 0001–0015 | new `[deploy supabase-staging]` commit after the rollback-only Storage policy proof passed on staging, approved by project owner | **Applied (run #5).** Pre-flight and rollback-only Storage policy proof passed; all 15 migrations recorded; schema smoke tests (74) and RLS/security tests (182, plus 2 Storage deletes covered via the Storage API) passed in rolled-back transactions with nothing left behind; 46/46 live Auth / Data API / Storage checks passed; test users and files cleaned up. Security Advisor to be checked manually. |
| 2026-10-06 | staging | 0016 (`presence`) | `[deploy supabase-staging]` on `3ec0403`, approved by project owner | **Not applied (run #111).** The pre-flight accepted only an empty project and stopped on the existing deployment; nothing was changed. The pre-flight then gained an incremental mode (history must exactly match the repository's first N migrations), approved by the project owner. |
| 2026-10-06 | staging | 0016 (`presence`) | `[deploy supabase-staging]` on `9a73e3f` (incremental pre-flight), approved by project owner | **Applied (run #112).** Incremental pre-flight passed (history = repository migrations 0001–0015, 0016 pending); Storage policy proof passed; 0016 applied; all 16 recorded versions match the repository exactly; incremental verification passed (4 exposure, 3 schema, 7 status-rule and 8 visibility checks) in a rolled-back transaction, row counts unchanged before/after (6,6,8,0,0,0), no test users or client grants left. Live checks 45/46: **failed** "Storage: a deleted file is no longer served" (a public avatar URL still returned HTTP 200 right after deletion — CDN caching; 0016 does not touch Storage). Security Advisor not run (step skipped after that failure; the access token secret is not set). |

## API verification runs

Runs of the Express API against staging (`[api-test supabase-staging]`). They apply no migrations and delete everything they create.

| Date (UTC) | Commit | Result |
|---|---|---|
| 2026-09-23 | `ede9598` (run #7) | **Did not reach staging.** Typecheck failed on the runner (library declaration files not built). |
| 2026-09-23 | `0c94ec2` (run #8) | **Passed, 39/39.** Real ES256 tokens verified via JWKS; TLS connection through the session pooler; journeys, friends, private convoy with join code and limit; real Storage signed upload, confirm, signed download, 60-second document link; deletion worker removed the file; account deletion via Auth admin; 0 leftover rows. |
| 2026-09-24 | `53f3246` (run #10, mobile) | **55/56.** App data layer against staging: sign-in/out, session restore and refresh, profile, vehicles, cover photo upload and download, Home (forced private), public Beauty Spot, recorded journey (180 of 540 GPS fixes kept; server distance 8.143 km, 81 XP; route decoded after reinstall), second-account isolation (9 checks), offline and server-error states visible with the change uploaded on reconnect, second phone sees identical data, account deletion incl. Storage files; 0 leftovers. **Failed:** sign-up through the app — staging Auth rejected the test address ("Email address … is invalid") because "Confirm email" is on with the built-in mailer. Staging Auth providers: email on, Apple off, Google off. |

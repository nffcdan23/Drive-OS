# Supabase deployment log

Record of every deployment of `supabase/migrations` to a hosted project.
Production is never deployed from this branch.

| Date (UTC) | Target | Migrations | Trigger | Result |
|---|---|---|---|---|
| 2026-09-23 | staging (existing project) | 0001–0015 | `[deploy supabase-staging]` commit, approved by project owner | **Not applied.** Attempt 1: secrets not visible to the workflow. Attempt 2: stopped by the pre-flight — `postgres` does not own `storage.objects`, so migration 0013 could not create Storage policies. Nothing was changed. |

---
name: DriveOS DB + API architecture
description: Key decisions for the persistent storage layer — auth, schema, API routes, mobile client
---

# DriveOS DB + API Architecture

## Auth approach (API, Phase 4)
Supabase Auth. The mobile app signs in with Supabase and sends `Authorization: Bearer <Supabase access token>`.
- `artifacts/api-server/src/middleware/auth.ts` (`requireUser`) verifies the token via the project's JWKS
  (`lib/jwt.ts`; HS256 only if `SUPABASE_JWT_SECRET` is set) and requires the profile row created by the
  sign-up trigger. The old device-UUID scheme is removed (the mobile app still uses it until Phase 5).
- The API connects as the table owner (bypasses RLS). Reads of other people's data go through
  `asUser()` (`lib/userDb.ts`), which sets `request.jwt.claims` so the `private.can_view_*` helpers apply
  the same rules as the RLS test suite. Every write checks ownership explicitly.

## Database
- `supabase/migrations` is the source of truth; `lib/db/src/schema/supabase.ts` is a typed Drizzle mirror
  (the only schema `@workspace/db` exports), checked by `pnpm run db:verify-local`.
- Pool: `DATABASE_URL` (Supabase session pooler), TLS via `DATABASE_SSL_MODE` / `DATABASE_SSL_CA`, `DATABASE_POOL_MAX` (default 5).
- NEVER run `drizzle-kit push`. Schema changes are new SQL migration files (see `supabase/README.md`).

## API routes
All mounted in `artifacts/api-server/src/routes/index.ts` under `/api`:
- `/healthz`, `/readyz`; `/me` (+ settings, stats, achievements, DELETE account), `/users/:id`
- `/vehicles`, `/journeys` (+ route-points, points, complete — distance/XP computed server-side), `/categories`, `/locations` (+ nearby, in-view)
- `/uploads` (signed Storage URLs + confirm), `/photos`, `/documents` (60 s links)
- `/friends`, `/friend-requests`, `/blocks`, `/convoys`, `/groups`, `/events`, `/notifications`, `/reports`
- Storage files of deleted rows are removed by `workers/storageCleanup.ts` (drains `private.storage_delete_queue`).
- Tests: `artifacts/api-server/test/api.test.mjs` (run by `db:verify-local`); staging: `supabase/tests/staging/api_staging.mjs`.
- NO orval codegen — handwritten types in `artifacts/mobile/lib/apiClient.ts` (to be updated in Phase 5).

## Mobile client
- `artifacts/mobile/lib/apiClient.ts` — imports customFetch from @workspace/api-client-react, calls setBaseUrl + setAuthTokenGetter at module init
- `artifacts/mobile/lib/deviceId.ts` — uses expo-crypto (~15.0.9) for Crypto.randomUUID()
- `artifacts/mobile/lib/journeyDraft.ts` — platform-unified draft: IndexedDB on web, AsyncStorage on native

## AppContext
- On mount: AsyncStorage first (fast) → then API (authoritative)
- `endDrive()` is now async — returns `Promise<Journey | null>`, clears state immediately, saves to API in background
- `startDrive()` is fire-and-forget async internally (external interface stays `() => void`)
- SyncBanner shows when `syncStatus !== 'idle'`

**Why:** Offline-first pattern — never block UI on network, always persist locally first.
**How to apply:** Any new mutation should update local state first, fire API call in background.

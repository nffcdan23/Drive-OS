---
name: DriveOS DB + API architecture
description: Key decisions for the persistent storage layer — auth, schema, API routes, mobile client
---

# DriveOS DB + API Architecture

## Auth approach
Anonymous auth via device UUID. No real login. On every request:
- Mobile sends `Authorization: Bearer <device-uuid>`
- API middleware (`artifacts/api-server/src/middleware/userId.ts`) upserts a `users` row, attaches `req.userId`

## Database
- Schema: `lib/db/src/schema/index.ts` — 15 Drizzle tables (users, vehicles, journeys, route_points, categories, achievements, friendships, convoys, groups, events, notifications, etc.)
- All PKs are UUIDs via `uuid_generate_v4()` default
- Push with: `pnpm --filter @workspace/db push`

## API routes
All mounted in `artifacts/api-server/src/routes/index.ts`:
- `/api/users/me`, `/api/vehicles/*`, `/api/journeys/*` (+ route-points + complete)
- `/api/categories`, `/api/notifications`, `/api/community/*` (convoys, groups, events, friends)
- NO orval codegen — handwritten types in `artifacts/mobile/lib/apiClient.ts`

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

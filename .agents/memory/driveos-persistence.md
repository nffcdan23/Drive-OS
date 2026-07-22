---
name: DriveOS persistence decisions
description: Key durable decisions for offline-first DB-backed storage in DriveOS mobile
---

# DriveOS Persistence Decisions

## Auth
Anonymous device UUID sent as `Authorization: Bearer <uuid>`. Server upserts a user row on first request. No login UI in scope.

**Why:** Friction-free onboarding; UUIDs are stable per device via expo-crypto.

## API hydration rule
API responses are always authoritative — including empty arrays (`[]`). Never guard hydration with `.length > 0`. Mock/seed data is the offline fallback only; once the API responds, local state is replaced unconditionally.

**Why:** Guarding with `.length > 0` silently keeps mock data for new users with empty DBs, breaking the core persistence guarantee.

**How to apply:** Pattern is `if (apiResult !== null) { setState(apiResult.map(toLocal)); }` — the null check handles network failure, not empty results.

## Offline-first drive recording
GPS coordinates update both React state (for UI) and a journeyDraft ref (for persistence). Draft stats (distanceKm, topSpeedKmh, speedSamples) are updated synchronously on the ref per GPS point. Periodic flush (30 s) sends pending points to server. On endDrive, remaining points are flushed inline.

**Why:** If the app crashes mid-drive the draft survives in IndexedDB (web) / AsyncStorage (native). retryJourneySync reads these stats for accurate server finalization.

## API-client-react package
Exports directly from `src/index.ts` (no build step). New exports take effect immediately — no rebuild needed.

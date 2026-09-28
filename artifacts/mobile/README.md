# DriveOS — Driving Companion App

Expo (SDK 57) app for tracking journeys, managing a vehicle garage, saving places and Beauty Spots, and driving with friends in convoys, groups and events.

## Accounts and data

- **Accounts are Supabase Auth accounts:** email + password, Sign in with Apple (iOS) and Sign in with Google.
- **Session storage:** the session is kept in the iOS Keychain / Android Keystore (`expo-secure-store`), so users stay signed in across restarts.
- **Source of truth:** your data lives in Supabase, read and written through the DriveOS API. That covers the profile, avatar, vehicles and photos, journeys and routes, saved places, Beauty Spots, friends, groups, events, convoys, settings, XP and notifications. Signing in on another phone gives the same data.
- **What stays on the phone:** only a cache, drives still uploading, and edits made offline. These are stored per user (`@driveos/u/<user id>/…`) and cleared on sign-out. The older device-only keys (`@driveos/vehicles`, …) are left untouched for a future importer and are never read.
- **Failures are always shown:** a banner reports when the phone is offline, when the server fails, when the session has expired, when changes are waiting to upload, and when the server refuses a change.
- **Journeys:**
  - Recording keeps a GPS point at most every 3 s, and only after the car has moved 25 m or turned more than 15°. Fixes worse than 100 m accuracy are dropped.
  - Drives are saved on the phone and uploaded idempotently, so a drive recorded offline uploads later without duplicates.
  - Distance, XP and the stored route are computed by the server.

The code lives in `lib/backend/`, which has no React Native dependencies. `CloudSync` is the engine, and `context/AppContext.tsx` wraps it for the screens.

## Running locally (Windows, macOS, Linux)

Needs Node 22 and pnpm 10 (`corepack enable`). From the repository root:

```sh
pnpm install
copy artifacts\mobile\.env.example artifacts\mobile\.env   # Windows (macOS/Linux: cp artifacts/mobile/.env.example artifacts/mobile/.env)
# edit artifacts/mobile/.env: the staging Supabase URL and publishable key
pnpm mobile
```

`pnpm mobile` checks the settings, then starts Expo. Press `i` for the iOS simulator, `a` for Android, `w` for web, or scan the QR code with Expo Go. Extra options pass through to `expo start`, for example:
- `pnpm mobile --tunnel`: when the phone and computer aren't on the same network;
- `pnpm mobile --clear`: resets Metro's cache.

Inside `artifacts/mobile` the same scripts are `pnpm start`, `pnpm ios`, `pnpm android` and `pnpm web`.

If a setting is missing, or a server secret has been put in `.env`, it stops with a message saying what to fix. `dev:replit`, `replit:build` and `replit:serve` are only used by the old Replit workspace (`.replit-artifact`); local development and EAS builds don't use them.

## Configuration

The app contains only public values. **Never add the Supabase secret or service-role key, the database password, the DVLA key or any other server secret.** The app refuses to start with a secret key, and CI scans for secrets.

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_APP_ENV` | `development`, `staging` or `production` (set by the EAS profile) |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The project's publishable (anon) key |
| `EXPO_PUBLIC_API_URL` | The DriveOS API base URL (HTTPS outside development) |

- **Local development:** copy `.env.example` to `.env` and fill in the staging Supabase values (see *Running locally* below).
- **EAS builds:** set the values as EAS environment variables. Use `preview` for staging builds and `production` for store builds, for example:
  - `eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_URL --value https://… --visibility plaintext`

### Build variants and app identity

The `staging` and `production` EAS profiles build separately named variants that can be installed side by side:
- staging has the `-staging` scheme and `.staging` id suffix;
- production uses the plain values.

The app's name, scheme and bundle id come from `app.identity.js`, and are **placeholders until the final name is chosen**. No bundle id is applied unless `APP_BUNDLE_ID` is set, so a build can't register one by accident. See `docs/NAMING.md`.

### More detail
- `docs/ENVIRONMENT.md`: every variable and dashboard setting (app, API, CI, Supabase Auth).
- `docs/STAGING_API.md`: the hosted staging API and the staging iPhone build.
- `docs/STAGING_DEVICE_CHECKLIST.md`: the first real-device test.
- `docs/NAMING.md`: what depends on the final name and bundle id.

## Tests

- `pnpm --filter @workspace/mobile run test`: unit tests for the data layer (no network). These run in the **Mobile** workflow.
- `pnpm --filter @workspace/mobile run test:staging`: end-to-end tests against staging, using real accounts, Storage and the API. They run in GitHub Actions for a commit containing `[mobile-test supabase-staging]` and clean up after themselves.

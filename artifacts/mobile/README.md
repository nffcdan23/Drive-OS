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

## Configuration

The app contains only public values. **Never add the Supabase secret or service-role key, the database password, the DVLA key or any other server secret.** The app refuses to start with a secret key, and CI scans for secrets.

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_APP_ENV` | `development`, `staging` or `production` (set by the EAS profile) |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The project's publishable (anon) key |
| `EXPO_PUBLIC_API_URL` | The DriveOS API base URL (HTTPS outside development) |

- **Local development:** copy `.env.example` to `.env`.
- **EAS builds:** set the values as EAS environment variables. Use `preview` for staging builds and `production` for store builds, for example:
  - `eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_URL --value https://… --visibility plaintext`

### Build variants (`app.config.js`, `eas.json`)

| Profile | App name | Bundle id / package | Link scheme |
|---|---|---|---|
| `staging` | DriveOS Staging | `com.driveos.app.staging` | `driveos-staging` |
| `production` | DriveOS | `com.driveos.app` | `driveos` |

Set `DRIVEOS_BUNDLE_ID` to use a different base id. It must match the App ID registered with Apple.

### Supabase Auth settings

- **URL configuration → Redirect URLs:** add
  - `driveos://auth/callback`
  - `driveos-staging://auth/callback`
  - the Expo Go / dev-client URL you use locally
- **Email:** keep "Confirm email" on for production, with custom SMTP. The built-in mailer only sends to project members.
- **Apple:** enable the provider and list both bundle ids under *Client IDs*. Native iOS sign-in needs no secret. Apple sign-in on Android or the web would additionally need a Services ID and key.
- **Google:** enable the provider with a Google Cloud **Web** OAuth client (ID + secret). Its authorised redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`.

## Tests

- `pnpm --filter @workspace/mobile run test`: unit tests for the data layer (no network). These run in the **Mobile** workflow.
- `pnpm --filter @workspace/mobile run test:staging`: end-to-end tests against staging, using real accounts, Storage and the API. They run in GitHub Actions for a commit containing `[mobile-test supabase-staging]` and clean up after themselves.

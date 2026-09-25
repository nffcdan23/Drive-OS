# Environment variables and settings

This file lists every value the app, the API and CI need, and where each is set. Values marked **public** end up inside the app and are safe to ship. Values marked **secret** must only exist on servers and in GitHub or EAS secrets, never in the app.

## 1. Mobile app: backend connection (build time)

| Variable | Kind | Staging value | Production value |
|---|---|---|---|
| `EXPO_PUBLIC_APP_ENV` | public | `staging` (set by the `staging` EAS profile) | `production` (set by the `production` profile) |
| `EXPO_PUBLIC_SUPABASE_URL` | public | `https://<staging-ref>.supabase.co` | production project URL (Phase 6) |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | staging publishable key (`sb_publishable_…`) | production publishable key |
| `EXPO_PUBLIC_API_URL` | public | HTTPS URL of the **hosted staging API** (the `STAGING_API_URL` domain; see `STAGING_API.md`) | production API URL (Phase 6) |

- **Where they go:**
  - locally: `artifacts/mobile/.env` (copy `.env.example`);
  - for EAS: environment variables, using `preview` for the staging profile and `production` for the production profile.
- **Example command:**
  - `eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_URL --value "https://<ref>.supabase.co" --visibility plaintext`
- **Safety checks:**
  - the app refuses to start with a secret or service-role key;
  - staging and production builds require HTTPS;
  - CI fails if a secret value appears in the app's files.

## 2. Mobile app: identity (placeholders until the name is chosen)

These are read by `app.identity.js`. None has a final value yet.

| Variable | Used for | Default (placeholder) |
|---|---|---|
| `APP_DISPLAY_NAME` | Home-screen name and all in-app wording | `DriveOS` |
| `APP_SLUG` | Expo/EAS project slug | `driveos` |
| `APP_SCHEME` | Deep-link scheme for sign-in links (`<scheme>://auth/callback`; staging adds `-staging`) | `driveos` |
| `APP_BUNDLE_ID` | iOS bundle id and Android package (staging adds `.staging`) | **none**: without it, EAS stops and asks, so nothing is registered by accident. For device testing before the name is chosen, use a throwaway id (`STAGING_API.md` §4). |
| `EAS_PROJECT_ID` | EAS project, printed by `eas init`; set in your shell, not committed | none |

Staging and production builds stop with an error if any `EXPO_PUBLIC_SUPABASE_*` or `EXPO_PUBLIC_API_URL` value is missing.

Set these as EAS environment variables when the name is final. See `NAMING.md` for everything that follows from them.

## 3. API server (hosted staging: its own Railway project, set by CI; see `STAGING_API.md`)

| Variable | Kind | Value |
|---|---|---|
| `PORT` | config | provided by the host |
| `NODE_ENV` | config | `production` |
| `DATABASE_URL` | **secret** | staging **session pooler** connection string |
| `DATABASE_SSL_MODE` | config | leave unset (defaults to `require` for remote hosts), or `verify-full` with `DATABASE_SSL_CA` |
| `DATABASE_SSL_CA` | config | optional: Supabase's SSL certificate (Database → SSL) |
| `DATABASE_POOL_MAX` | config | optional, default `5` |
| `SUPABASE_URL` | public | `https://<staging-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | **secret** | staging secret key: Storage signed URLs, file deletion, account deletion |
| `SUPABASE_JWT_SECRET` | **secret** | **not needed**: staging signs tokens with ES256 and the API checks them against the public keys |
| `DVLA_API_KEY` | **secret** | optional: enables registration lookup |
| `DVLA_VES_URL` | config | optional override of the DVLA endpoint |
| `STORAGE_WORKER` | config | optional; `off` disables the file clean-up worker |
| `STORAGE_WORKER_INTERVAL_MS` | config | optional, default `60000` |
| `LOG_LEVEL` | config | optional, default `info` |
| `APP_RELEASE` | config | optional: commit id reported in the `X-App-Release` header of `/api/healthz` |

**Health checks:** `GET /api/healthz` (the process is up) and `GET /api/readyz` (the database is reachable).

## 4. GitHub repository secrets and variables (CI against staging)

| Name | Kind | Used by |
|---|---|---|
| `SUPABASE_STAGING_DB_URL` | secret | staging jobs (migrations, checks, API tests) |
| `SUPABASE_STAGING_URL` | secret | staging jobs |
| `SUPABASE_STAGING_PROJECT_REF` | secret | staging jobs (guards against the wrong project) |
| `SUPABASE_STAGING_PUBLISHABLE_KEY` | secret | staging jobs |
| `SUPABASE_STAGING_SECRET_KEY` | secret | staging jobs |
| `RAILWAY_STAGING_TOKEN` | secret | hosted staging API deploys. It's a Railway **project token** for the separate staging project. |
| `RAILWAY_STAGING_PROJECT_ID` | **variable** | hosted staging API deploys: the staging Railway project's id. The token must belong to it. |
| `STAGING_API_URL` | **variable** | hosted staging API deploys and tests: `https://…` domain of the staging service |
| `STAGING_SIGNUP_EMAIL_DOMAIN` | **variable**, optional | domain for sign-up test addresses. Only needed if Supabase rejects the default `example.com` once "Confirm email" is off. Use a domain you control; no email is sent to it. |

## 5. Supabase Auth settings (dashboard), per project

| Setting | Staging | Production |
|---|---|---|
| Auth → Providers → Email → **Confirm email** | **Off**. Lets the automated sign-up test and testers create accounts without the built-in mailer, which only sends to project members. | **On**, with custom SMTP |
| Auth → Providers → Email → Allow new users | On | On |
| Auth → Providers → Email → Minimum password length | 8 (matches the app) | 8 |
| Auth → URL configuration → Redirect URLs | `<scheme>-staging://auth/callback`, plus the Expo Go URL while testing in Expo Go (`exp://<LAN-IP>:8081/--/auth/callback`) | `<scheme>://auth/callback` |
| Auth → Providers → Apple | enabled when you're ready; Client IDs = the final staging bundle id (see `NAMING.md`) | final production bundle id |
| Auth → Providers → Google | enabled with a Google Cloud **Web** OAuth client; redirect URI `https://<ref>.supabase.co/auth/v1/callback` | its own Web client |

`<scheme>` is `driveos` until the name is final.

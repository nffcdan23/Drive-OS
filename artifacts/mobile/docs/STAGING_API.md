# Hosted staging API and the staging iPhone build

The staging API runs in **its own Railway project**, separate from the production project. It uses only the Supabase **staging** project. Nothing here touches production, and nothing registers a final name or bundle id.

```
iPhone (staging build) ──HTTPS──▶ staging API (Railway project "…staging…") ──▶ Supabase staging
          └──────────────── Supabase staging Auth + Storage ◀──────────────────────┘
```

## 1. One-time Railway setup (in your Railway account)

1. **New Project** → Empty project. Name it with **"staging"** in it, e.g. `driveos-staging`.
   - Deploys are refused unless the project name contains "staging".
   - Create it as a **separate project**, not as an environment inside the production project.
2. In that project: **Create → Empty Service**, named `api`.
   - Don't connect the GitHub repo; CI uploads each deploy.
   - Pick the region closest to the Supabase staging project.
3. Service → **Settings → Networking → Generate Domain**, with target port left to Railway.
   - Copy the URL, e.g. `https://api-xxxx.up.railway.app`.
4. **Project Settings → Environments:** rename the project's environment (Railway calls it `production` by default) to **`staging`**.
   - This keeps "production" out of the staging project entirely.
5. **Project Settings → Tokens → Create token** for the `staging` environment.
   - This is a *project token*: it only works for this one project and environment.
6. **Project Settings → General:** copy the **Project ID**.

## 2. GitHub settings (repository → Settings → Secrets and variables → Actions)

| Name | Type | Value |
|---|---|---|
| `RAILWAY_STAGING_TOKEN` | **secret** | the project token from step 5 |
| `RAILWAY_STAGING_PROJECT_ID` | variable | the Project ID from step 6 (the token must belong to this project) |
| `STAGING_API_URL` | variable | the domain from step 3, e.g. `https://api-xxxx.up.railway.app` (no trailing slash) |

The API's own settings are **not** entered in Railway by hand. Each deploy copies them from the existing `SUPABASE_STAGING_*` secrets, after checking they all belong to the same staging project:

| Railway variable (set by CI) | From |
|---|---|
| `NODE_ENV` | `production` (the API's hardened mode) |
| `DATABASE_URL` | `SUPABASE_STAGING_DB_URL` (session pooler) |
| `SUPABASE_URL` | `SUPABASE_STAGING_URL` |
| `SUPABASE_SECRET_KEY` | `SUPABASE_STAGING_SECRET_KEY` |
| `STORAGE_WORKER_INTERVAL_MS` | `5000` |
| `LOG_LEVEL` | `info` |
| `APP_RELEASE` | the commit being deployed (lets CI confirm it is live) |
| `PORT` | provided by Railway |

- `DVLA_API_KEY` is deliberately **not** copied. Registration lookup is off on staging unless you add a separate staging key in Railway yourself.
- `SUPABASE_JWT_SECRET` isn't needed, because staging tokens are checked against Supabase's public keys.

## 3. Deploy

Deploys go only to environment **`staging`**, service **`api`**; those names are fixed in the workflow.

To run just the read-only checks (token, project, environment, service, URL), dispatch the workflow with `confirm = verify-api-staging`. It changes nothing.

- Push a commit whose message contains `[deploy api-staging]`.
- Or dispatch the "API staging deploy" workflow on this branch with `confirm = deploy-api-staging`.
  - The Actions tab only shows the **Run workflow** button once the file is on the default branch.
  - Until then, dispatch it through the API or ask Claude to.

The job then:
1. checks the secrets, that the token belongs to `RAILWAY_STAGING_PROJECT_ID`, and that the project's name contains "staging". Every Railway command names the project, environment and service explicitly;
2. typechecks and builds the API;
3. sets the variables above;
4. uploads the commit with `deploy/railway.staging.json` added as its `railway.json`. That config builds `deploy/Dockerfile.staging`, the same Node 22.22.2 and pnpm 10.33.0 as `mise.toml`, and runs the bundled API as a non-root user. There is no `railway.json` at the repository root, so production builds are unaffected;
5. waits until `/api/healthz` reports this commit and `/api/readyz` reports the database;
6. runs the whole mobile staging test suite against the hosted URL.

Check it yourself: `curl -i https://<staging-api>/api/readyz` → `{"status":"ok","database":"ok"}`.

## 4. The staging iPhone build (EAS)

**Needs:** an Expo account, and an Apple Developer Program membership (for installing on a physical iPhone).

**Doesn't need:** an App Store Connect record, TestFlight, or the final bundle id.

From `artifacts/mobile`:

```sh
npx eas-cli@latest login
npx eas-cli@latest init                      # creates the EAS project and prints its id
export EAS_PROJECT_ID=<the id it printed>     # keep it in your shell; not committed

# Staging build settings (EAS "preview" environment). All of them are public values.
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_SUPABASE_URL --value "https://<staging-ref>.supabase.co"
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value "sb_publishable_…"
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_API_URL --value "https://<staging-api>"
# A THROWAWAY bundle id for testing only. Staging adds ".staging".
npx eas-cli@latest env:create --environment preview --visibility plaintext --name APP_BUNDLE_ID --value "com.<yourname>.devtest"

npx eas-cli@latest device:create             # register your iPhone (open the link on the phone)
npx eas-cli@latest build --platform ios --profile staging
```

**How the build installs.** The `staging` profile is **internal distribution** (ad hoc): you install from the link or QR code EAS gives you. It does not go through the App Store or TestFlight.

**What gets registered with Apple.** EAS registers the throwaway id `com.<yourname>.devtest.staging` and an ad hoc provisioning profile. The throwaway id is never your shipping id, so the final name and bundle id remain fully open.

**Before signing in on the phone,** add `driveos-staging://auth/callback` to Supabase staging → Auth → URL configuration → Redirect URLs. This is needed for password-reset and confirmation links.

**No Apple membership yet?** Build `--profile staging-simulator` for the iOS Simulator on a Mac. That needs no Apple registration at all.

## What stays temporary
- Name `DriveOS`, scheme `driveos`, slug `driveos`: placeholders (`app.identity.js`).
- The EAS project id comes from `EAS_PROJECT_ID`, not from the repository. A new EAS project can be created under the final slug later.
- The throwaway bundle id only exists for testing. The final one is chosen and set with `APP_BUNDLE_ID` later (see `NAMING.md`).

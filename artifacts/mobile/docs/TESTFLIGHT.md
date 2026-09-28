# First TestFlight build (pre-launch)

The TestFlight app is the **staging variant** of the app. It talks only to the single pre-launch backend:

```
iPhone (TestFlight) ──▶ API https://api-production-1dafc.up.railway.app ──▶ Supabase nshffzncumvmmzgtqqph
```

| | TestFlight app (now) | App Store app (at launch, later) |
|---|---|---|
| Build profile | `testflight` | `production` |
| Bundle id | `<base>.staging` | `<base>` |
| Home-screen name | `<Name> Staging` | `<Name>` |
| Sign-in return link | `driveos-staging://auth/callback` (already allowed in Supabase) | `<scheme>://auth/callback` |
| Backend | pre-launch (EAS `preview` environment) | production (EAS `production` environment, created at launch) |
| App Store Connect record | its own record; never released | its own record |

Nothing here creates production infrastructure or publishes anything on the App Store.

## 1. Decisions (permanent once used)

Tell Claude these values; they go in `CHOSEN` in `app.identity.js`. They are public, so they are committed.

| Value | Example | Permanent? |
|---|---|---|
| Bundle id base | `com.yourcompany.appname` (a reverse domain you control) | **Yes.** TestFlight registers `<base>.staging` with Apple. |
| Display name | `Name` → home screen shows `Name Staging` | No |
| EAS slug and Expo account | `appname` under your Expo account | Effectively yes (fixed by `eas init`) |
| App Store Connect name / SKU / language | `Name Staging` / `appname-staging-ios` / English (UK) | Name: changeable. SKU: permanent. The name must be unique on the App Store. |
| Scheme | keep `driveos` (never shown to users) | Keeping it means no Supabase change |

## 2. Link the EAS project (once)

From `artifacts/mobile`, after `CHOSEN` is committed on `main`:

```sh
npx eas-cli@latest login
npx eas-cli@latest init
```

`eas init` creates the project and prints its id. It can't write it into `app.config.js` itself. Put the id in `CHOSEN.easProjectId` (or give it to Claude) and commit.

## 3. Build settings (EAS "preview" environment, public values only)

```sh
npx eas-cli@latest env:list --environment preview
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_SUPABASE_URL --value "https://nshffzncumvmmzgtqqph.supabase.co"
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value "sb_publishable_…"
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_API_URL --value "https://api-production-1dafc.up.railway.app"
```

- If `env:list` already shows a variable, use `env:update` instead of `env:create`.
- The publishable key is the same `sb_publishable_…` value as in your local `.env`.
- **Never** add `SUPABASE_SECRET_KEY`, `DATABASE_URL` or `DVLA_API_KEY` to EAS: they live on Railway only.

## 4. Apple: one check, then EAS does the rest

1. Check that **developer.apple.com → Account** and **App Store Connect → Business** show no agreement waiting to be accepted. A pending agreement makes builds and uploads fail.
2. On the first build, EAS asks you to sign in with your Apple ID and pick your team. Let it:
   - register the App ID `<base>.staging`, with the **Sign in with Apple** capability (from `usesAppleSignIn`);
   - create the **Apple Distribution certificate** and the **App Store provisioning profile**.

   EAS stores these; nothing is kept in the repository.

## 5. Build and upload to TestFlight

```sh
npx eas-cli@latest build --platform ios --profile testflight --auto-submit
```

- The build number goes up by itself (`autoIncrement`, stored by EAS). The version stays `1.0.0` until changed in `app.json`.
- `--auto-submit` uploads the build to App Store Connect. On the first run, it offers to create the App Store Connect record and an App Store Connect API key: use the name, SKU and language from step 1.
- The export-compliance question is already answered in the build (`ITSAppUsesNonExemptEncryption = false`).

## 6. Sign-in settings for the installed app

- **Email and password:** nothing to do.
- **Return link:** `driveos-staging://auth/callback` is already accepted by Supabase. Google, email confirmation and password-reset links all return through it. If you change the scheme, add `<scheme>-staging://auth/callback` in Supabase → Authentication → URL Configuration.
- **Google:** enabled in Supabase. In the Google Cloud console, for the Web OAuth client that Supabase uses:
  - **Clients → Authorized redirect URIs** includes `https://nshffzncumvmmzgtqqph.supabase.co/auth/v1/callback`.
  - **Audience → Publishing status:** while it says **Testing**, only the Google accounts listed under **Test users** can sign in. Add each tester, or publish the app (the email/profile scopes need no verification).
- **Sign in with Apple:** in Supabase → Authentication → Sign In / Providers → **Apple**:
  - turn it on;
  - set **Client IDs** to `<base>.staging`;
  - save.

  No secret key is needed for sign-in from the iOS app. Until this is done, the Apple button in the app says "This sign-in method is turned off on this server." Apple requires Sign in with Apple before App Store release, because the app offers Google sign-in.

## 7. Testers

- **App Store Connect → the app → TestFlight → Internal Testing:** add a group, then add yourself and your team. There's no review, and testers get it as soon as the build has processed (usually 5–30 minutes).
- **External testers** (anyone, by email or public link) need Beta App Review first. Fill in **Test Information**: a description, a feedback email, and **sign-in details for a demo account on this backend**.

## What can't get into the app

- The app receives exactly three backend values: the Supabase URL, the publishable key and the API URL.
- `app.config.js` **refuses to build** if any `EXPO_PUBLIC_*` value holds:
  - a Supabase secret or service-role key;
  - a database URL with a password;
  - DVLA credentials.
- The app itself refuses to start with a secret key.
- CI scans the source, and a built iOS bundle, for secrets and for the DVLA key.

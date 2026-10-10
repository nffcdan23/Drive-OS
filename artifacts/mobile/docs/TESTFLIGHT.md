# First TestFlight build (pre-launch)

The TestFlight app is the **staging variant** of the app. It talks only to the single pre-launch backend:

```
iPhone (TestFlight) ──▶ API https://api-production-1dafc.up.railway.app ──▶ Supabase nshffzncumvmmzgtqqph
```

| | TestFlight app (now) | App Store app (at launch, later) |
|---|---|---|
| Build profile | `testflight` | `production` |
| Home-screen name | `Derwent` | not chosen |
| Bundle id | `uk.co.starscale.drive.staging` | not chosen; nothing registered |
| URL scheme | `starscale-drive-staging` | not chosen |
| Sign-in return link | `starscale-drive-staging://auth/callback` | not chosen |
| EAS project slug | `starscale-drive-staging` | its own project, later |
| Backend | pre-launch (EAS `preview` environment) | production (EAS `production` environment, created at launch) |
| App Store Connect record | its own record; never released | its own record |

Nothing here creates production infrastructure or publishes anything on the App Store.

## 1. Identity (chosen)

These values are in `CHOSEN.staging` in `app.identity.js`, and they are used exactly as written. `CHOSEN.production` stays empty until the App Store identity is decided.

The bundle id, scheme and EAS slug keep the app's earlier name ("StarScale Drive"); they are permanent technical identifiers users never see. Everything users see says **Derwent**.

When App Store Connect asks, you still choose the record's **name** (unique on the App Store; it can change later), **SKU** (permanent, private, e.g. `starscale-drive-staging-ios`) and **primary language**.

## 2. EAS project (done)

The TestFlight app is linked to the EAS project **`@dancaw23/starscale-drive-staging`**, project id `a5ecd99b-322f-4531-b3d9-4bdd3ddb93cf`. The id and owner are recorded **only** in `CHOSEN.staging` in `app.identity.js`.

- `eas init` also writes the id into `app.json` (`extra.eas`). Don't commit that: discard it with `git restore artifacts/mobile/app.json`.
- A copy in `app.json` that differs from `app.identity.js` stops the build. So does any copy at all in a production (App Store) build, because it would tie that build to the staging project.
- Don't run `eas init` again for this app.

## 3. Build settings (EAS "preview" environment, public values only)

```sh
npx eas-cli@latest env:list --environment preview
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_SUPABASE_URL --value "https://nshffzncumvmmzgtqqph.supabase.co"
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value "sb_publishable_…"
npx eas-cli@latest env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_API_URL --value "https://api-production-1dafc.up.railway.app"
```

- If `env:list` already shows a variable, use `env:update` instead of `env:create`.
- Do **not** add `APP_DISPLAY_NAME`, `APP_SLUG`, `APP_SCHEME`, `APP_BUNDLE_ID` or `EAS_PROJECT_ID`: the identity is committed. The TestFlight build refuses `APP_*` overrides, so it can't register a different bundle id with Apple.
- `EXPO_PUBLIC_APP_ENV=staging` comes from the `testflight` profile in `eas.json`; don't add it to EAS either.
- The publishable key is the same `sb_publishable_…` value as in your local `.env`.
- **Never** add `SUPABASE_SECRET_KEY`, `DATABASE_URL` or `DVLA_API_KEY` to EAS: they live on Railway only.

## 4. Apple: one check, then EAS does the rest

1. Check that **developer.apple.com → Account** and **App Store Connect → Business** show no agreement waiting to be accepted. A pending agreement makes builds and uploads fail.
2. On the first build, EAS asks you to sign in with your Apple ID and pick your team. Let it:
   - register the App ID `uk.co.starscale.drive.staging`, with the **Sign in with Apple** capability (from `usesAppleSignIn`);
   - create the **Apple Distribution certificate** and the **App Store provisioning profile**.

   EAS stores these; nothing is kept in the repository.

## 5. Build and upload to TestFlight

```sh
npx eas-cli@latest build --platform ios --profile testflight --auto-submit
```

- The build number goes up by itself (`autoIncrement`, stored by EAS). The version stays `1.0.0` until changed in `app.json`.
- EAS ignores `ios.buildNumber` in `app.json` (that's for local Xcode builds, below). If you switch between the two, first make EAS's number match the last upload: `npx eas-cli@latest build:version:set --platform ios`.
- `--auto-submit` uploads the build to App Store Connect. On the first run, it offers to create the App Store Connect record and an App Store Connect API key: use the name, SKU and language from step 1.
- The export-compliance question is already answered in the build (`ITSAppUsesNonExemptEncryption = false`).

## 6. Sign-in settings for the installed app

- **Email and password:** nothing to do.
- **Return link:** the installed app uses `starscale-drive-staging://auth/callback` for Google, email confirmation and password-reset links. **Add it** in Supabase → Authentication → URL Configuration → Redirect URLs (the old `driveos-staging://auth/callback` entry can stay until nothing uses it). Until it is added, those sign-ins return to the Site URL instead of the app.
- **Google:** enabled in Supabase. In the Google Cloud console, for the Web OAuth client that Supabase uses:
  - **Clients → Authorized redirect URIs** includes `https://nshffzncumvmmzgtqqph.supabase.co/auth/v1/callback`.
  - **Audience → Publishing status:** while it says **Testing**, only the Google accounts listed under **Test users** can sign in. Add each tester, or publish the app (the email/profile scopes need no verification).
- **Sign in with Apple:** in Supabase → Authentication → Sign In / Providers → **Apple**:
  - turn it on;
  - set **Client IDs** to `uk.co.starscale.drive.staging`;
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

## Local Xcode build (the usual way)

TestFlight builds are made in Xcode on the Intel Mac (EAS above is the fallback). The build number has **one** source: `ios.buildNumber` in `artifacts/mobile/app.json`.

- **Before each build, raise it by one** and commit. It must be higher than the last build uploaded to App Store Connect. (Build 23 was uploaded by hand; the repo starts at `24`.)
- `expo prebuild` writes it into `ios/Derwent/Info.plist` (`CFBundleVersion`) and into the Xcode project (`CURRENT_PROJECT_VERSION`), so Xcode shows the same number and nothing needs editing by hand. The version (`CFBundleShortVersionString` / `MARKETING_VERSION`) comes from `version` in `app.json`.
- `ios/` is generated and never committed. Prebuild also adds `expo`, `react` and `react-native` to `package.json`: put it back with `git restore artifacts/mobile/package.json`.

```sh
cd ~/path/to/Drive-OS
git checkout main && git pull
pnpm install --frozen-lockfile        # also applies patches/ (the Xcode 26 fix for expo-modules-jsi)
cd artifacts/mobile
cat .env                              # unchanged from Build 23: Supabase URL + publishable key, API URL, Mapbox pk. token + style URL
npx expo prebuild -p ios --clean
git restore package.json
grep -A1 CFBundleVersion ios/Derwent/Info.plist   # the number from app.json
open ios/Derwent.xcworkspace
```

In Xcode: target **Derwent** → Signing & Capabilities: your team, bundle id `uk.co.starscale.drive.staging`. General shows the version and build. Then **Any iOS Device (arm64)** → Product → **Archive** → Organizer → **Distribute App** → **App Store Connect** → Upload.


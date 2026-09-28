# What depends on the final app name and bundle identifier

The name and bundle id are **not decided**. The current values (`DriveOS`, `driveos`, and candidate `com.driveos.app`) are placeholders in `app.identity.js`. No bundle id is applied to builds until `APP_BUNDLE_ID` is set, so nothing can be registered with Apple or Google by accident.

## Decide before the first TestFlight build

| # | Item | Where it's set | Reversible? |
|---|---|---|---|
| 1 | **Bundle id / Android package** (e.g. `com.<company>.<name>`) | `APP_BUNDLE_ID` (EAS environment) | **No, once used.** The App Store Connect app record, TestFlight and in-app purchases are tied to it permanently. The Android package is permanent on Google Play. |
| 2 | **App Store Connect app record** (App Store name, SKU, primary language) | App Store Connect | The name can change later; the SKU and bundle id can't |
| 3 | **Apple App ID** with the "Sign in with Apple" capability (staging id `<id>.staging` too, if you want installable staging builds) | Apple Developer → Identifiers | An App ID can be deleted if unused; the identifier string is effectively consumed |
| 4 | **Supabase → Auth → Apple → Client IDs** = the final bundle id(s) | Supabase dashboard (staging and, later, production) | Yes |
| 5 | **Deep-link scheme** (`<scheme>://auth/callback`) and the matching **Supabase redirect URLs** | `APP_SCHEME` + Supabase | Yes, but changing it after release breaks old password-reset and confirmation links |
| 6 | **Display name** on the home screen, sign-in screen, permission prompts and messages | `APP_DISPLAY_NAME` (the app reads it at build time) | Yes (needs a new build) |
| 7 | **Expo/EAS project slug**, fixed by `eas init` | `APP_SLUG` | Hard. Changing it after `eas init` means a new EAS project |
| 8 | **Google OAuth consent screen**: app name, logo, support email (what users see when choosing a Google account) | Google Cloud console | Yes |
| 9 | **Android Google Maps API key** restricted to the final package name + signing certificate | Google Cloud console + app config | Yes, but a map key is required for Android builds (see below) |
| 10 | App icon and splash screen, App Store listing, privacy policy and support URLs | assets / App Store Connect | Yes |

## Not tied to the name (no action needed)
- **Supabase projects, database, API and Storage bucket names:** these are internal. The staging project name is not user-visible.
- **Device storage keys (`@driveos/...`):** internal only. The old device-only keys keep that prefix so the future importer can find them. A bundle-id change also means a fresh install, so there's nothing to migrate.
- **Code identifiers (`DriveOSEvent`, `@workspace/...`, repository name):** internal; can be renamed at any time.

## Once the name is chosen, the change is configuration only
1. Set `APP_DISPLAY_NAME`, `APP_SCHEME`, `APP_BUNDLE_ID` (and `APP_SLUG` before `eas init`) as EAS environment variables.
2. Register the App ID(s) in Apple Developer, then create the App Store Connect record.
3. Update the Supabase redirect URLs and Apple Client IDs, and Google's consent screen.
4. Run `eas build --profile staging` (and later `production`).

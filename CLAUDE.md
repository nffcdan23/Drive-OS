# Derwent: notes for Claude

Derwent (StarScale Ltd) is the Expo SDK 57 / React Native iPhone app in `artifacts/mobile`, with its API in `artifacts/api-server`. TestFlight builds are made in **Xcode on the developer's Intel MacBook**: GitHub → Mac → `expo prebuild` → Xcode → TestFlight. Never introduce EAS Build or EAS Submit.

## iOS build numbers: Claude owns them

The developer never changes the build number. The full workflow is in `artifacts/mobile/docs/BUILD_NUMBERS.md`.

- **One source:** `artifacts/mobile/app.json` → `expo.ios.buildNumber`.
- **The record:** `artifacts/mobile/ios-build-numbers.json` holds the prepared build and the highest build confirmed in App Store Connect.
- **Never edit by hand:** not the generated `ios/` files, not Xcode settings, not the number itself. Use `node scripts/ios-build-number.js prepare` (run from `artifacts/mobile`).
- **When preparing a build the developer will upload to TestFlight** (a milestone or fix that's ready), make the build number part of that work:
  1. Run `node scripts/ios-build-number.js status`.
  2. If the highest upload isn't confirmed, or builds may have been uploaded since it was recorded, **ask the developer** for the highest build App Store Connect shows. Never assume a number is free.
  3. Run `node scripts/ios-build-number.js prepare --uploaded <n> --contents "<what's in it>"`, then commit `app.json` and `ios-build-numbers.json` with the work.
  4. Report the prepared build number.
- **When it doesn't change:** ordinary commits, dependency installs and prebuilds. An unuploaded prepared build keeps its number.
- **After an upload:** when the developer reports one, run `node scripts/ios-build-number.js record-upload <n>`.

## Native iOS code and configuration

- **`ios/` is generated.** It's never committed and is rebuilt by `npx expo prebuild -p ios --clean`. Native changes go in config plugins (`artifacts/mobile/plugins/`, `app.config.js`) or local Expo modules (`artifacts/mobile/modules/`).
- **After prebuild, check:** run `node scripts/check-ios-scene-lifecycle.js` (scene lifecycle, CarPlay scene, entitlements, build number). CI runs it after a Linux prebuild.
- **This environment can't compile Swift.** Say so; Xcode on the Mac is the first compile.
- **CarPlay:** see `artifacts/mobile/docs/CARPLAY.md`. Scene lifecycle: see `artifacts/mobile/docs/SCENE_LIFECYCLE.md`. Mac build steps: see `artifacts/mobile/docs/TESTFLIGHT.md`.

## Checks before pushing

From the repository root:

```sh
pnpm run typecheck:libs && pnpm --filter @workspace/mobile run typecheck
pnpm --filter @workspace/mobile run test
```

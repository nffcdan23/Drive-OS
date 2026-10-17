# iOS build numbers

**The developer never changes Derwent's build number.** Claude prepares it whenever a TestFlight build is being prepared, and commits it with the changes. The Mac only pulls, runs prebuild and archives.

## Where it lives

| What | Where |
|---|---|
| The build number (the one source) | `artifacts/mobile/app.json` → `expo.ios.buildNumber` (a string, e.g. `"33"`). Committed, so the same commit always builds the same number. |
| The version | `app.json` → `expo.version` (`1.0.0`). App Store Connect needs a higher build number for each upload of the same version. |
| The record | `artifacts/mobile/ios-build-numbers.json`. `prepared.build` is always app.json's number, with what it contains. `highestUploaded.build` is the highest build confirmed in App Store Connect for this version, or `null` while unconfirmed. |
| Into Xcode | `npx expo prebuild -p ios --clean` writes it into `ios/Derwent/Info.plist` (`CFBundleVersion`) and the Xcode project (`CURRENT_PROJECT_VERSION`, via `app.config.js`). The version goes into `CFBundleShortVersionString` / `MARKETING_VERSION`. |

Never edit the number in Xcode, Info.plist or the Xcode project. They are generated, and the next prebuild replaces them.

## When Claude prepares a build number

**Only when a TestFlight build is being prepared:** a milestone or fix that's ready to upload.

It doesn't change on ordinary commits, dependency installs or prebuilds. Changes made after a prepared build that hasn't been uploaded yet keep that same number.

```sh
cd artifacts/mobile
node scripts/ios-build-number.js status
node scripts/ios-build-number.js prepare --uploaded <highest build in App Store Connect> --contents "<what this build contains>"
```

How `prepare` picks the number:

- **Highest upload must be known.** If App Store Connect's highest build has never been confirmed (`highestUploaded.build` is `null`), and no `--uploaded` is given, it refuses. Claude then asks the developer for the number, and never guesses.
- **Unuploaded builds are reused.** If the prepared build is still higher than the highest upload, it's kept.
- **Otherwise the next number is taken:** highest upload + 1. That's always higher than App Store Connect, even if numbers were skipped.
- **Repeat runs are safe.** Running it again with the same facts gives the same number.
- **Edits are minimal.** It writes `app.json` (the build number only, nothing else changes) and `ios-build-numbers.json`.

When the developer reports an upload, run `node scripts/ios-build-number.js record-upload <n>`. It only ever raises the recorded number.

**Where the developer finds the highest build:** App Store Connect → Derwent → TestFlight → iOS builds, for version 1.0.0. Xcode's Distribute option "Manage Version and Build Number" can change the number at upload, so the number shown in App Store Connect is the one that counts.

## Safety net in Xcode

Prebuild adds a **"[Derwent] Check build number"** build phase (`plugins/withBuildNumberCheck.js`). It calls `node scripts/ios-build-number.js xcode-check` with Expo's Node, before anything is compiled: directly after CocoaPods' "[CP] Check Pods Manifest.lock" (which `pod install` always moves to the front of the target), and before Sources.

| Situation | Archive (Release) | Debug run |
|---|---|---|
| Xcode project out of date: `app.json` differs from Info.plist / `CURRENT_PROJECT_VERSION` (pulled without re-running prebuild) | **Error**: run `npx expo prebuild -p ios --clean` | Warning |
| Build already in App Store Connect (`≤ highestUploaded.build`) | **Error**: ask Claude to prepare the next build | Warning |
| Highest upload not confirmed yet | Warning: number not verified as unused | (none) |

So Xcode can't archive a stale project or a number that's already been uploaded.

## Checks

- **Unit tests** (`test/unit.test.ts`, run in CI):
  - the ledger matches `app.json`;
  - `prepare`'s rules and idempotency;
  - the Xcode check's errors and warnings;
  - the build phase is registered.
- **Native checks** (`scripts/check-ios-scene-lifecycle.js`, run after prebuild in CI and on the Mac):
  - Info.plist `CFBundleVersion` / `CFBundleShortVersionString` and Xcode's `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION` (Debug and Release) all come from `app.json`;
  - that number is the one the ledger records as prepared;
  - the build phase is present once, with nothing but CocoaPods' manifest check before it and Sources after it. CI checks this both straight after prebuild and after CocoaPods' own integration step (`test/cocoapods-integrate.rb`, as `pod install` does on the Mac).

## On the Mac (unchanged, nothing to edit)

```sh
git pull
pnpm install --frozen-lockfile
cd artifacts/mobile
npx expo prebuild -p ios --clean
git restore package.json
node scripts/check-ios-scene-lifecycle.js
node scripts/ios-build-number.js status     # "ready to archive and upload", or what's missing
open ios/Derwent.xcworkspace                # Archive → Distribute → App Store Connect
```

After an upload, tell Claude the build number App Store Connect shows. Claude records it, and the next prepared build will be higher.

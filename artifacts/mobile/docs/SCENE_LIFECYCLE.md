# iOS scene lifecycle (CarPlay Milestone 1)

The iPhone app uses UIKit's scene lifecycle, which CarPlay's own scene needs. It is Expo's official SDK 57 option, set in `app.config.js`:

```js
['expo-build-properties', { ios: { enableSceneSupport: true } }]
```

On `npx expo prebuild -p ios --clean` it:

- makes `AppDelegate` conform to `ExpoReactNativeFactoryProvider`, and removes the two lines that created the window and started React Native at launch;
- adds a scene manifest to `Info.plist` with one window scene, run by Expo's `EXExpoAppSceneDelegate` (in the `expo` package, 57.0.23 and newer). That delegate creates the window, starts React Native in it, and forwards links, universal links and lifecycle events to the `AppDelegate` as before.

Nothing else changes: bundle id, signing, entitlements, build number, background modes and pods are the same. `expo-build-properties` writes three keys to `Podfile.properties.json`, all with the Podfile's own default values.

Milestone 2 adds the CarPlay scene to this manifest, and the CarPlay entitlement: see `docs/CARPLAY.md`. Expo's iPhone scene stays exactly as above.

`node scripts/check-ios-scene-lifecycle.js` checks the generated project. CI runs it after a Linux prebuild; run it on the Mac after prebuild.

## Device checks before the first TestFlight build

Debug build from Xcode to the iPhone, then:

1. **Launch:** normal launch from the home screen, and a cold start (swipe the app away first). Splash, sign-in state and the Drive map as before.
2. **Links:** a password-reset or confirmation email link, with the app closed (cold) and with it open in the background (warm). Both land on `auth/callback`.
3. **Sign-in:** Sign in with Apple and Google (sign out first).
4. **Location:** on a fresh install, the first drive asks for "Always" access as before.
5. **Background:** navigation with voice, then lock the phone or switch apps. Guidance keeps speaking, and the drive keeps recording.
6. **Background relaunch** (the open question): see below.

### Background relaunch

Before this change, the app started React Native at process launch. Now React Native starts when iOS connects the app's scene. Apple says the system "might" connect the scene in the background to process a location event, but this isn't confirmed for Derwent. Until a physical iPhone shows it, recording after iOS has terminated the app mid-drive is **unverified**.

To test:

1. Start a drive on the iPhone (Debug build from Xcode, "Always" location).
2. Stop the app from Xcode (■).
3. Travel more than about 1 km.
4. Open the app → Settings → View & Share Diagnostics.
5. Expected: a `launch` entry with `appState: background` from while you travelled, and the drive's route continuing past the point where the app was stopped.
6. Compare with the same test on Build 31.

If no background launch shows up, report it before the TestFlight build. The fix is a small addition that starts React Native at launch when iOS relaunches the app in the background.

## Rollback

Roll back CarPlay first (`docs/CARPLAY.md`): its plugin stops prebuild without the scene lifecycle.

1. Revert the commit that added this: `git revert <commit>`. That removes the option, its unit test, the CI check and this script together. For a quick local experiment without committing, `enableSceneSupport: false` in `app.config.js` also restores the old AppDelegate and Info.plist. The unit test and the check script then fail, as they should.
2. Run `npx expo prebuild -p ios --clean`.
3. Raise `ios.buildNumber` in `app.json` and archive as usual. Earlier TestFlight builds stay installable while you do.

# WeatherKit (the drive screen's weather)

While a drive is being recorded, the top-right chip shows the current weather at the car's position: the condition's icon and the temperature in °C. The data comes from Apple WeatherKit.

## How it works

- **Native module:** `modules/derwent-weather` is a small local Expo module (Swift). It calls `WeatherService.shared.weather(for:including: .current)` and `WeatherService.shared.attribution`. Autolinking adds it as the `DerwentWeather` pod.
- **Entitlement:** `plugins/withWeatherKit.js` adds `com.apple.developer.weatherkit = true` to the generated entitlements, alongside Sign in with Apple and CarPlay.
- **No keys:** iOS signs WeatherKit requests for any app that has the entitlement. There is no WeatherKit key, `.p8` file, key ID or token in the app or in this repository, and none is needed. (Keys are only for the WeatherKit REST API, which the app doesn't use.)
- **When it asks** (`lib/weather/driveWeather.ts`):
  - once at the start of a drive, as soon as there is a position;
  - again every 15 minutes, or after about 10 km of movement;
  - after a failed request, it waits 2 minutes before trying again.

  The last good result stays in memory and is shown for up to an hour.
- **Failures:** none of this affects recording. If WeatherKit isn't enabled, the phone is offline, or there's no position yet, the chip is simply hidden.
- **Android, web, and builds without the module:** there is no weather, and the chip is hidden.
- **Attribution:** tapping the chip shows Apple's Weather mark and an **Other data sources** link to Apple's legal attribution page. Apple requires both wherever WeatherKit data appears.

## One-time setup (Apple Developer portal)

1. Go to [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, IDs & Profiles** → **Identifiers**, and open the App ID **`uk.co.starscale.drive.staging`**.
2. On the **Capabilities** tab, tick **WeatherKit**.
3. On the **App Services** tab, tick **WeatherKit** too.
4. Click **Save**, and confirm.
5. Wait about 30 minutes. WeatherKit can take that long to start answering for a newly enabled App ID.

You don't need to create a key, download anything, or add anything to `.env`.

## Building

This is a native change, so a new build is needed (an over-the-air JavaScript update won't add it):

1. `npx expo prebuild -p ios --clean`
2. `node scripts/check-ios-scene-lifecycle.js`. This confirms the WeatherKit entitlement and the `DerwentWeather` pod.
3. Run `pod install` in `ios/`, open the workspace in Xcode, then Archive as usual (docs/TESTFLIGHT.md).

   With automatic signing, Xcode fetches a new provisioning profile that includes WeatherKit.

**If Xcode says the profile doesn't include `com.apple.developer.weatherkit`:** WeatherKit isn't enabled on the App ID yet (step 2 above). Enable it and try again. If the error persists, go to Xcode → Settings → Accounts and click **Download Manual Profiles**.

**If the chip never appears on a device:**

- Check that the drive has a GPS fix (the GPS chip isn't **Lost**).
- Allow time for WeatherKit to start working after you enable it (up to 30 minutes).
- Check that the build includes the module, by doing a fresh prebuild.

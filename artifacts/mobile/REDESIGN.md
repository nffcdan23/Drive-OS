# Derwent iOS redesign

Run `pnpm --filter @workspace/mobile start` from the repository root. Use a
compatible Expo client or the existing development build for native maps and GPS.

- The five tabs are Drive, Drives, Garage, Social and Profile. Explore lives in
  Drive's nested stack so the same tab bar remains visible.
- Drive keeps the existing recording, camera and location logic. Destination
  search opens Apple Maps on iOS or Google Maps on other platforms.
- Explore offers duration, road preferences and loop/destination configuration.
  Build Route is unavailable until a route-generation service is connected.
- Garage shows one vehicle as a large hero; multiple vehicles reveal My Vehicles.
  Details, editing, primary selection and recorded history live on the vehicle page.
- Social uses existing friends, communities, events and convoy APIs. Empty live
  activity collapses; no location or presence is fabricated.
- Profile includes account, privacy, notifications, preferences, support and legal.
  Privacy and alert preferences use the existing account-settings API.
- Native iOS glass and SF Symbols use existing Expo packages, with native blur
  or opaque accessibility/platform fallbacks. Main screens use system typography.

No backend, schema, authentication or dependency changes were required.
WeatherKit, live friend presence and vehicle maintenance/document services are
not configured. Development-only demo weather is labelled. Legal links require
`EXPO_PUBLIC_TERMS_URL` and `EXPO_PUBLIC_PRIVACY_URL`.

Browser review covered 390x844 and 320x700 layouts, empty states and multiple
vehicles using temporary local fixtures. Native iPhone glass, GPS, permissions,
keyboard and accessibility settings still require device acceptance testing.
The Windows test-file path handling was corrected to allow the existing unit
suite to run. Production Expo exports validate JavaScript bundles, not an IPA.

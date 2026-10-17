# Apple WeatherKit for the Drive recording screen's weather card
# (docs/WEATHERKIT.md). A local Expo module: Expo autolinking finds it in
# artifacts/mobile/modules and adds this pod at `pod install`. WeatherKit
# needs the app's com.apple.developer.weatherkit entitlement
# (plugins/withWeatherKit.js) and WeatherKit enabled on the App ID; no keys.
Pod::Spec.new do |s|
  s.name             = 'DerwentWeather'
  s.version          = '0.1.0'
  s.summary          = "Derwent's WeatherKit bridge"
  s.description      = 'Current weather from Apple WeatherKit for the Derwent drive screen.'
  s.author           = 'StarScale Ltd'
  s.homepage         = 'https://github.com/nffcdan23/Drive-OS'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { git: '' }
  s.static_framework = true
  s.frameworks       = 'WeatherKit', 'CoreLocation'
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files     = '*.swift'
end

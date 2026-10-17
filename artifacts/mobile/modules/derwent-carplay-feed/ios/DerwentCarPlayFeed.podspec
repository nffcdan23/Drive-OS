# The navigation session's copy for the CarPlay screen (CarPlay Milestone 4,
# docs/CARPLAY.md). A local Expo module: Expo autolinking finds it in
# artifacts/mobile/modules and adds this pod at `pod install`. JavaScript
# (lib/navigation/carPlay.ts) hands it the iPhone's guidance; it passes that
# to the native-only CarPlay pod's store, one way.
Pod::Spec.new do |s|
  s.name             = 'DerwentCarPlayFeed'
  s.version          = '0.1.0'
  s.summary          = "Derwent's navigation feed for CarPlay"
  s.description      = "Hands the iPhone's navigation session to Derwent's native CarPlay screen."
  s.author           = 'StarScale Ltd'
  s.homepage         = 'https://github.com/nffcdan23/Drive-OS'
  s.platforms        = { :ios => '15.1' }
  s.swift_version    = '5.9'
  s.source           = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'DerwentCarPlay'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files     = '*.swift'
end

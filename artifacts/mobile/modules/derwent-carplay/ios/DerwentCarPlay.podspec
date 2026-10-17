# Derwent's CarPlay scene (docs/CARPLAY.md). A local module: Expo
# autolinking finds it in artifacts/mobile/modules and adds this pod at
# `pod install`. It has no Expo module and no JavaScript; UIKit creates its
# scene delegate by name, from the CarPlay scene that plugins/withCarPlay.js
# adds to Info.plist.
#
# The map is the Mapbox Maps SDK the app already has through @rnmapbox/maps:
# no version here, so CocoaPods resolves the same MapboxMaps that
# @rnmapbox/maps pins (one copy of the SDK).
Pod::Spec.new do |s|
  s.name             = 'DerwentCarPlay'
  s.version          = '0.2.0'
  s.summary          = "Derwent's native CarPlay scene"
  s.description      = 'The CarPlay scene delegate and its Mapbox map window for Derwent (CarPlay navigation app).'
  s.author           = 'StarScale Ltd'
  s.homepage         = 'https://github.com/nffcdan23/Drive-OS'
  s.platforms        = { :ios => '15.1' }
  s.swift_version    = '5.9'
  s.source           = { git: '' }
  s.static_framework = true
  s.frameworks       = 'CarPlay', 'CoreLocation'
  s.dependency 'MapboxMaps'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files     = '*.swift'
end

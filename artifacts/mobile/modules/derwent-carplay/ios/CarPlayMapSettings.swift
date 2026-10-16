import Foundation

/**
 The CarPlay map's Mapbox settings, from Info.plist (written at prebuild by
 plugins/withCarPlay.js from the app's public EXPO_PUBLIC_MAPBOX_TOKEN and
 EXPO_PUBLIC_MAPBOX_STYLE_URL). nil without a public token and a style URL:
 CarPlay then shows its placeholder instead of a map. React Native isn't
 needed for any of it.
 */
struct CarPlayMapSettings {
  /// Public token (pk.…); never a secret token
  let accessToken: String
  /// The Derwent style, mapbox://styles/<account>/<style id>
  let styleURL: String

  static func fromInfoPlist(_ bundle: Bundle = .main) -> CarPlayMapSettings? {
    let token = (bundle.object(forInfoDictionaryKey: "MBXAccessToken") as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let style = (bundle.object(forInfoDictionaryKey: "DerwentCarPlayMapStyleURL") as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard token.hasPrefix("pk."), style.hasPrefix("mapbox://styles/") || style.hasPrefix("https://") else {
      return nil
    }
    return CarPlayMapSettings(accessToken: token, styleURL: style)
  }
}

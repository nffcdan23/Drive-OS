/**
 * CarPlay (navigation app) for the iOS build: docs/CARPLAY.md.
 *
 * - Info.plist: adds the CarPlay scene to the scene manifest that
 *   expo-build-properties' `ios.enableSceneSupport` creates (Milestone 1).
 *   The iPhone's own scene (Expo's EXExpoAppSceneDelegate) is kept exactly
 *   as it is; the CarPlay scene is run by DerwentCarPlaySceneDelegate, in
 *   the local module modules/derwent-carplay. Multiple scenes are switched
 *   on, as Apple's CarPlay scene manifest has them (iPhone and CarPlay at
 *   once).
 * - Entitlements: com.apple.developer.carplay-maps (Apple granted it for the
 *   App ID), added to the existing ones.
 * - The CarPlay map (Milestone 3): the app's PUBLIC Mapbox token and the
 *   Derwent style URL (EXPO_PUBLIC_MAPBOX_TOKEN / EXPO_PUBLIC_MAPBOX_STYLE_URL,
 *   the same values the iPhone's Drive map uses, already in the app's
 *   JavaScript) go into Info.plist as MBXAccessToken (Mapbox's own key) and
 *   DerwentCarPlayMapStyleURL, so the CarPlay map loads without React Native.
 *   Only a public pk. token is ever written; a secret sk. token stops
 *   prebuild. Without both values neither key is written, and CarPlay shows
 *   its placeholder instead of the map.
 *
 * ORDER: config plugins' Info.plist steps run in reverse order of the
 * plugins list, and the scene manifest only exists once expo-build-properties
 * has added it. So this plugin is listed BEFORE expo-build-properties in
 * app.config.js. Prebuild stops with an explanation if the manifest isn't
 * Expo's iPhone scene (scene support off, or the order changed): CarPlay
 * never replaces or guesses at the iPhone's scene.
 */
const { withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

const CARPLAY_ENTITLEMENT = 'com.apple.developer.carplay-maps';
const PHONE_ROLE = 'UIWindowSceneSessionRoleApplication';
const CARPLAY_ROLE = 'CPTemplateApplicationSceneSessionRoleApplication';
const EXPO_SCENE_DELEGATE = 'EXExpoAppSceneDelegate';
/** The class name in modules/derwent-carplay/ios/CarPlaySceneDelegate.swift (@objc) */
const CARPLAY_SCENE_DELEGATE = 'DerwentCarPlaySceneDelegate';

/** Info.plist keys read by modules/derwent-carplay/ios/CarPlayMapSettings.swift */
const MAPBOX_TOKEN_KEY = 'MBXAccessToken';
const MAPBOX_STYLE_KEY = 'DerwentCarPlayMapStyleURL';

const CARPLAY_SCENE = {
  UISceneClassName: 'CPTemplateApplicationScene',
  UISceneConfigurationName: 'CarPlay',
  UISceneDelegateClassName: CARPLAY_SCENE_DELEGATE,
};

/** The scene manifest with the CarPlay scene added; the iPhone's scene unchanged */
function withCarPlayScene(manifest) {
  const configurations = manifest && manifest.UISceneConfigurations;
  const phone = configurations && configurations[PHONE_ROLE];
  const isExpoPhoneScene = Array.isArray(phone)
    && phone.length === 1
    && phone[0].UISceneDelegateClassName === EXPO_SCENE_DELEGATE;
  if (!isExpoPhoneScene) {
    throw new Error(
      "withCarPlay: CarPlay needs the iOS scene lifecycle, but Info.plist doesn't have Expo's iPhone scene "
      + `(${EXPO_SCENE_DELEGATE}). Keep ['expo-build-properties', { ios: { enableSceneSupport: true } }] in `
      + "app.config.js, listed AFTER './plugins/withCarPlay' (plugins' Info.plist steps run in reverse order).",
    );
  }
  const others = Object.keys(configurations).filter((role) => role !== PHONE_ROLE && role !== CARPLAY_ROLE);
  if (others.length) {
    throw new Error(`withCarPlay: unexpected scene roles in Info.plist (${others.join(', ')}); not changing the scene manifest.`);
  }
  return {
    ...manifest,
    UIApplicationSupportsMultipleScenes: true,
    UISceneConfigurations: {
      [PHONE_ROLE]: phone,
      [CARPLAY_ROLE]: [{ ...CARPLAY_SCENE }],
    },
  };
}

/**
 * The map settings to write, or null without a usable public token and style
 * (the same rules as lib/mapbox.ts mapboxSettings). A secret token throws.
 */
function carPlayMapSettings({ mapboxToken, mapboxStyleUrl } = {}) {
  const token = String(mapboxToken ?? '').trim();
  const styleUrl = String(mapboxStyleUrl ?? '').trim();
  if (token.startsWith('sk.')) {
    throw new Error('withCarPlay: the Mapbox token is a secret (sk.) token. Only the public pk. token may be in the app.');
  }
  if (!token.startsWith('pk.')) return null;
  if (!/^mapbox:\/\/styles\/[^/\s]+\/[^/\s]+(\/draft)?$/.test(styleUrl) && !/^https:\/\/\S+$/.test(styleUrl)) return null;
  return { token, styleUrl };
}

function withCarPlay(config, props = {}) {
  const map = carPlayMapSettings(props);
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = withCarPlayScene(cfg.modResults.UIApplicationSceneManifest);
    if (map) {
      cfg.modResults[MAPBOX_TOKEN_KEY] = map.token;
      cfg.modResults[MAPBOX_STYLE_KEY] = map.styleUrl;
    } else {
      delete cfg.modResults[MAPBOX_TOKEN_KEY];
      delete cfg.modResults[MAPBOX_STYLE_KEY];
    }
    return cfg;
  });
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults[CARPLAY_ENTITLEMENT] = true;
    return cfg;
  });
}

module.exports = withCarPlay;
module.exports.withCarPlayScene = withCarPlayScene;
module.exports.carPlayMapSettings = carPlayMapSettings;
module.exports.MAPBOX_TOKEN_KEY = MAPBOX_TOKEN_KEY;
module.exports.MAPBOX_STYLE_KEY = MAPBOX_STYLE_KEY;
module.exports.CARPLAY_ENTITLEMENT = CARPLAY_ENTITLEMENT;
module.exports.CARPLAY_SCENE = CARPLAY_SCENE;

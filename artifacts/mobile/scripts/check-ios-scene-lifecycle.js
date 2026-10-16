#!/usr/bin/env node
/**
 * Checks the generated iOS project after `npx expo prebuild -p ios --clean`:
 * the app uses the UIKit scene lifecycle (Expo's SDK 57 option,
 * expo-build-properties `ios.enableSceneSupport`; see app.config.js) with
 * the CarPlay scene beside the iPhone's (plugins/withCarPlay.js,
 * docs/CARPLAY.md), and nothing else those changes could touch has moved.
 *
 * Run from artifacts/mobile, after prebuild:  node scripts/check-ios-scene-lifecycle.js
 * Exits 1, naming every problem, if a check fails. CI runs it on Linux; on
 * the Mac, run it before opening Xcode.
 *
 *  - AppDelegate: provides the React Native factory to Expo's scene delegate
 *    and no longer creates the window or starts React Native itself; the
 *    deep-link handlers (custom scheme, universal links) are still there.
 *  - Info.plist: Expo's iPhone scene exactly as Expo writes it, plus the
 *    CarPlay scene (DerwentCarPlaySceneDelegate), and nothing else (in any
 *    key order: `pod install` sorts the keys); background modes location and
 *    audio still present.
 *  - Entitlements: Sign in with Apple, and CarPlay navigation.
 *  - CarPlay module: autolinked (pod DerwentCarPlay from modules/derwent-carplay),
 *    its scene delegate has the class name Info.plist uses, and it stays
 *    native-only (no React Native or Expo imports).
 *  - CarPlay map: the module uses the Mapbox Maps SDK @rnmapbox/maps already
 *    brings (v11, no second copy); Info.plist has either both the public
 *    token (MBXAccessToken, pk.) and the Derwent style, or neither (then
 *    CarPlay shows its placeholder), and never a secret (sk.) token.
 *  - Podfile.properties.json: the keys expo-build-properties writes hold the
 *    Podfile's own defaults, so pods are linked exactly as before.
 *  - The installed expo package has the scene delegate (57.0.23 or newer, SDK 57).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');

const projectRoot = path.resolve(__dirname, '..');
const iosDir = path.join(projectRoot, 'ios');
const expoPackage = require.resolve('expo/package.json', { paths: [projectRoot] });
const configPlugins = require.resolve('@expo/config-plugins', { paths: [expoPackage] });
const plist = require(require.resolve('@expo/plist', { paths: [configPlugins] })).default;
const autolinkingPackage = require.resolve('expo-modules-autolinking/package.json', { paths: [expoPackage] });

const CARPLAY_MODULE = path.join(projectRoot, 'modules', 'derwent-carplay');
const CARPLAY_SCENE_DELEGATE = 'DerwentCarPlaySceneDelegate';

const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: true,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
    ],
    CPTemplateApplicationSceneSessionRoleApplication: [
      {
        UISceneClassName: 'CPTemplateApplicationScene',
        UISceneConfigurationName: 'CarPlay',
        UISceneDelegateClassName: CARPLAY_SCENE_DELEGATE,
      },
    ],
  },
};

/**
 * Whether the parsed scene manifest is exactly SCENE_MANIFEST: the same keys
 * and values, with nothing missing or added and arrays in the same order.
 * Key order is ignored, because plist dictionaries are unordered and
 * `pod install` rewrites Info.plist with its keys sorted (React Native's
 * RCTNewArchEnabled step): CPTemplate... then comes before UIWindow....
 */
function sceneManifestMatches(manifest) {
  const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  return isDeepStrictEqual(plain(manifest), SCENE_MANIFEST);
}

module.exports = { SCENE_MANIFEST, sceneManifestMatches };
if (require.main !== module) return;

const problems = [];
const passed = [];
const check = (ok, message) => (ok ? passed : problems).push(message);

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

if (!fs.existsSync(iosDir)) {
  console.error('No ios/ folder: run `npx expo prebuild -p ios --clean` first.');
  process.exit(1);
}

// The app target's folder: the one holding AppDelegate.swift (Pods excluded)
const appDir = fs.readdirSync(iosDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'Pods' && fs.existsSync(path.join(iosDir, e.name, 'AppDelegate.swift')))
  .map((e) => path.join(iosDir, e.name))[0];
if (!appDir) {
  console.error('No ios/<app>/AppDelegate.swift found.');
  process.exit(1);
}

const [major, minor, patch] = require(expoPackage).version.split('.').map(Number);
check(major === 57 && (minor > 0 || patch >= 23), `expo ${require(expoPackage).version} is SDK 57, 57.0.23 or newer (has ExpoAppSceneDelegate)`);

const appDelegate = read(path.join(appDir, 'AppDelegate.swift')) ?? '';
check(appDelegate.includes('class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'), 'AppDelegate provides the React Native factory to the scene delegate');
check(/^\s*reactNativeFactory = factory$/m.test(appDelegate), 'AppDelegate still creates the React Native factory at launch');
check(!appDelegate.includes('startReactNative('), 'AppDelegate no longer starts React Native (the scene delegate does)');
check(!appDelegate.includes('UIWindow(frame:'), 'AppDelegate no longer creates the window (the scene delegate does)');
check(appDelegate.includes('RCTLinkingManager.application(app, open: url, options: options)'), 'AppDelegate still hands custom-scheme links to React Native');
check(appDelegate.includes('RCTLinkingManager.application(application, continue: userActivity'), 'AppDelegate still hands universal links to React Native');

const info = plist.parse(read(path.join(appDir, 'Info.plist')) ?? '');
check(sceneManifestMatches(info.UIApplicationSceneManifest), "Info.plist scene manifest: Expo's iPhone scene unchanged, plus the CarPlay scene (DerwentCarPlaySceneDelegate), nothing else");
const modes = Array.isArray(info.UIBackgroundModes) ? info.UIBackgroundModes : [];
check(modes.includes('location') && modes.includes('audio'), `Info.plist background modes still include location and audio (${modes.join(', ')})`);

const entitlementsFile = fs.readdirSync(appDir).find((f) => f.endsWith('.entitlements'));
const entitlements = entitlementsFile ? plist.parse(read(path.join(appDir, entitlementsFile)) ?? '') : {};
check(Array.isArray(entitlements['com.apple.developer.applesignin']), 'Entitlements still include Sign in with Apple');
check(entitlements['com.apple.developer.carplay-maps'] === true, 'Entitlements include CarPlay navigation (com.apple.developer.carplay-maps = true)');

// The CarPlay module: linked, and the class Info.plist names is the one it defines
const resolved = spawnSync(process.execPath, [path.join(path.dirname(autolinkingPackage), 'bin', 'expo-modules-autolinking.js'), 'resolve', '--platform', 'apple', '--json'], { cwd: projectRoot, encoding: 'utf8' });
let carPlayPods = [];
try {
  const mod = JSON.parse(resolved.stdout).modules.find((m) => m.packageName === 'derwent-carplay');
  carPlayPods = mod ? mod.pods : [];
} catch {
  // Reported below
}
check(carPlayPods.length === 1 && carPlayPods[0].podName === 'DerwentCarPlay' && path.resolve(carPlayPods[0].podspecDir) === path.join(CARPLAY_MODULE, 'ios'), 'Autolinking adds the DerwentCarPlay pod from modules/derwent-carplay');
const swift = fs.readdirSync(path.join(CARPLAY_MODULE, 'ios')).filter((f) => f.endsWith('.swift')).map((f) => read(path.join(CARPLAY_MODULE, 'ios', f)) ?? '').join('\n');
check(swift.includes(`@objc(${CARPLAY_SCENE_DELEGATE})`) && /:\s*UIResponder,\s*CPTemplateApplicationSceneDelegate/.test(swift), `The CarPlay module defines ${CARPLAY_SCENE_DELEGATE} (a CPTemplateApplicationSceneDelegate)`);
check(/didConnect interfaceController: CPInterfaceController,\s*to window: CPWindow/.test(swift) && /didDisconnect interfaceController: CPInterfaceController,\s*from window: CPWindow/.test(swift), 'It handles the navigation app connect (with window) and disconnect');
check(!/^\s*(@_implementationOnly\s+|internal\s+)?import\s+(React|Expo|ExpoModulesCore|RNMBX)/m.test(swift), 'It stays native-only: no React Native or Expo imports');

// The CarPlay map: the Mapbox SDK @rnmapbox/maps already links, and the public token and style
const podspec = read(path.join(CARPLAY_MODULE, 'ios', 'DerwentCarPlay.podspec')) ?? '';
let rnmapboxMapbox = null;
try {
  rnmapboxMapbox = require(require.resolve('@rnmapbox/maps/package.json', { paths: [projectRoot] })).mapbox.ios;
} catch {
  // Reported below
}
check(/^\s*s\.dependency\s+'MapboxMaps'\s*$/m.test(podspec) && /\b11\./.test(String(rnmapboxMapbox)), `The CarPlay pod depends on MapboxMaps, the Mapbox SDK @rnmapbox/maps links (${rnmapboxMapbox ?? 'not found'}), with no version of its own`);
check(/^\s*import\s+MapboxMaps\s*$/m.test(swift), 'The CarPlay map is drawn with the Mapbox Maps SDK');
const mapToken = info.MBXAccessToken;
const mapStyle = info.DerwentCarPlayMapStyleURL;
const mapConfigured = typeof mapToken === 'string' && mapToken.startsWith('pk.') && typeof mapStyle === 'string' && /^(mapbox:\/\/styles\/|https:\/\/)/.test(mapStyle);
check(mapConfigured || (mapToken === undefined && mapStyle === undefined), mapConfigured
  ? 'Info.plist has the public Mapbox token (pk.) and the Derwent style: CarPlay shows the map'
  : 'Info.plist has no Mapbox token or style (EXPO_PUBLIC_MAPBOX_TOKEN / _STYLE_URL unset): CarPlay shows its placeholder');
check(!/\bsk\.eyJ/.test(read(path.join(appDir, 'Info.plist')) ?? ''), 'Info.plist holds no secret Mapbox token (sk.)');

const podProps = JSON.parse(read(path.join(iosDir, 'Podfile.properties.json')) ?? '{}');
const defaults = { 'EXPO_USE_PRECOMPILED_MODULES': 'true', 'apple.privacyManifestAggregationEnabled': 'true', 'ios.forceStaticLinking': '[]' };
for (const [key, value] of Object.entries(defaults)) {
  check(podProps[key] === undefined || podProps[key] === value, `Podfile.properties.json ${key} is the Podfile default (${value})`);
}

for (const p of passed) console.log(`✓ ${p}`);
for (const p of problems) console.error(`✗ ${p}`);
if (problems.length) {
  console.error(`\n${problems.length} iOS scene check(s) failed.`);
  process.exit(1);
}
console.log('\niOS scene lifecycle and CarPlay scene: all checks passed.');

#!/usr/bin/env node
/**
 * Checks the generated iOS project after `npx expo prebuild -p ios --clean`:
 * the app uses the UIKit scene lifecycle (Expo's SDK 57 option,
 * expo-build-properties `ios.enableSceneSupport`; see app.config.js), and
 * nothing else that change could touch has moved.
 *
 * Run from artifacts/mobile, after prebuild:  node scripts/check-ios-scene-lifecycle.js
 * Exits 1, naming every problem, if a check fails. CI runs it on Linux; on
 * the Mac, run it before opening Xcode.
 *
 *  - AppDelegate: provides the React Native factory to Expo's scene delegate
 *    and no longer creates the window or starts React Native itself; the
 *    deep-link handlers (custom scheme, universal links) are still there.
 *  - Info.plist: exactly Expo's one-window scene manifest (no CarPlay scene
 *    yet); background modes location and audio still present.
 *  - Entitlements: Sign in with Apple only (no CarPlay entitlement yet).
 *  - Podfile.properties.json: the keys expo-build-properties writes hold the
 *    Podfile's own defaults, so pods are linked exactly as before.
 *  - The installed expo package has the scene delegate (57.0.23 or newer, SDK 57).
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const iosDir = path.join(projectRoot, 'ios');
const expoPackage = require.resolve('expo/package.json', { paths: [projectRoot] });
const configPlugins = require.resolve('@expo/config-plugins', { paths: [expoPackage] });
const plist = require(require.resolve('@expo/plist', { paths: [configPlugins] })).default;

const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
    ],
  },
};

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
check(JSON.stringify(info.UIApplicationSceneManifest) === JSON.stringify(SCENE_MANIFEST), "Info.plist has exactly Expo's scene manifest (one window scene, EXExpoAppSceneDelegate; no CarPlay scene)");
const modes = Array.isArray(info.UIBackgroundModes) ? info.UIBackgroundModes : [];
check(modes.includes('location') && modes.includes('audio'), `Info.plist background modes still include location and audio (${modes.join(', ')})`);

const entitlementsFile = fs.readdirSync(appDir).find((f) => f.endsWith('.entitlements'));
const entitlements = entitlementsFile ? plist.parse(read(path.join(appDir, entitlementsFile)) ?? '') : {};
check(Array.isArray(entitlements['com.apple.developer.applesignin']), 'Entitlements still include Sign in with Apple');
check(!('com.apple.developer.carplay-maps' in entitlements), 'Entitlements have no CarPlay key yet');

const podProps = JSON.parse(read(path.join(iosDir, 'Podfile.properties.json')) ?? '{}');
const defaults = { 'EXPO_USE_PRECOMPILED_MODULES': 'true', 'apple.privacyManifestAggregationEnabled': 'true', 'ios.forceStaticLinking': '[]' };
for (const [key, value] of Object.entries(defaults)) {
  check(podProps[key] === undefined || podProps[key] === value, `Podfile.properties.json ${key} is the Podfile default (${value})`);
}

for (const p of passed) console.log(`✓ ${p}`);
for (const p of problems) console.error(`✗ ${p}`);
if (problems.length) {
  console.error(`\n${problems.length} iOS scene lifecycle check(s) failed.`);
  process.exit(1);
}
console.log('\niOS scene lifecycle: all checks passed.');

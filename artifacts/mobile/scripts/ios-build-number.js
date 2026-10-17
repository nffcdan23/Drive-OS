#!/usr/bin/env node
/**
 * iOS build numbers (docs/BUILD_NUMBERS.md). The developer never changes the
 * build number: Claude prepares it with this script when a TestFlight build
 * is being prepared, and commits it.
 *
 * The build number lives in one place, app.json `ios.buildNumber` (committed:
 * the same revision always builds the same number). `expo prebuild` writes it
 * into Info.plist (CFBundleVersion) and Xcode's CURRENT_PROJECT_VERSION
 * (app.config.js). ios-build-numbers.json records the build prepared (always
 * app.json's) and the highest build confirmed in App Store Connect.
 *
 * Run from artifacts/mobile:
 *   node scripts/ios-build-number.js status
 *       The prepared build and whether it can be uploaded.
 *   node scripts/ios-build-number.js prepare [--uploaded <n>] [--contents "<what>"]
 *       For Claude, when a TestFlight build is being prepared. --uploaded: the
 *       highest build App Store Connect shows for this version (recorded).
 *       Keeps the prepared build if it hasn't been uploaded yet, else takes the
 *       next one (highest uploaded + 1). Refuses without a confirmed highest
 *       upload. Idempotent: run again, same result.
 *   node scripts/ios-build-number.js record-upload <n>
 *       Records a build the developer uploaded (raises highestUploaded).
 *   node scripts/ios-build-number.js xcode-check
 *       Run by the "[Derwent] Check build number" build phase (added at
 *       prebuild by plugins/withBuildNumberCheck.js). An Archive (Release) stops
 *       if the Xcode project is out of date (pulled without re-running
 *       prebuild) or the build is already in App Store Connect; a Debug build
 *       only warns.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const APP_JSON = 'app.json';
const LEDGER = 'ios-build-numbers.json';

const readJson = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const writeJson = (root, file, value) => fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
const isBuild = (n) => Number.isInteger(n) && n > 0;

function readState(root = PROJECT_ROOT) {
  const app = readJson(root, APP_JSON);
  const ledger = readJson(root, LEDGER);
  return { app, ledger, appBuild: Number(app.expo.ios.buildNumber), appVersion: app.expo.version };
}

/** The build to prepare: the prepared one while it isn't uploaded, else the next */
function nextBuild(prepared, highestUploaded) {
  if (!isBuild(highestUploaded)) {
    throw new Error(
      'The highest build in App Store Connect is not confirmed. Ask the developer for it '
      + '(App Store Connect > the app > TestFlight > iOS builds, for the version in app.json), '
      + 'then run: node scripts/ios-build-number.js prepare --uploaded <n>',
    );
  }
  return prepared > highestUploaded ? prepared : highestUploaded + 1;
}

/** Problems with the build about to be made in Xcode: { errors, warnings } */
function xcodeCheck({ appBuild, highestUploaded, currentProjectVersion, infoPlistBuild, configuration }) {
  const release = !/debug/i.test(configuration || '');
  const errors = [];
  const warnings = [];
  const stale = [];
  if (String(currentProjectVersion) !== String(appBuild)) stale.push(`CURRENT_PROJECT_VERSION is ${currentProjectVersion}`);
  if (String(infoPlistBuild) !== String(appBuild)) stale.push(`Info.plist CFBundleVersion is ${infoPlistBuild}`);
  if (stale.length) {
    (release ? errors : warnings).push(
      `The Xcode project is out of date: app.json has build ${appBuild}, but ${stale.join(' and ')}. `
      + 'Run `npx expo prebuild -p ios --clean` in artifacts/mobile (after git pull), then build again.',
    );
  }
  if (isBuild(highestUploaded) && appBuild <= highestUploaded) {
    (release ? errors : warnings).push(
      `Build ${appBuild} is already in App Store Connect (highest uploaded: ${highestUploaded}). `
      + 'Ask Claude to prepare the next build number, pull, and run prebuild again.',
    );
  } else if (!isBuild(highestUploaded) && release) {
    warnings.push(`Build ${appBuild}: the highest build in App Store Connect isn't recorded yet, so this number isn't verified as unused.`);
  }
  return { errors, warnings };
}

function status(root = PROJECT_ROOT) {
  const { appBuild, appVersion, ledger } = readState(root);
  const uploaded = ledger.highestUploaded.build;
  const lines = [
    `Version ${appVersion}, prepared build ${appBuild} (${ledger.prepared.contents})`,
    `Highest build in App Store Connect: ${isBuild(uploaded) ? `${uploaded} (confirmed ${ledger.highestUploaded.confirmed})` : 'not confirmed'}`,
  ];
  if (!isBuild(uploaded)) lines.push(`Build ${appBuild} is NOT verified as unused: confirm the highest build in App Store Connect.`);
  else if (appBuild > uploaded) lines.push(`Build ${appBuild} is ready to archive and upload.`);
  else lines.push(`Build ${appBuild} is already uploaded: the next TestFlight build needs prepare.`);
  return lines.join('\n');
}

function prepare(root = PROJECT_ROOT, { uploaded, contents, today = new Date().toISOString().slice(0, 10) } = {}) {
  const { app, ledger, appBuild, appVersion } = readState(root);
  if (ledger.version !== appVersion) {
    throw new Error(`app.json version ${appVersion} differs from ios-build-numbers.json version ${ledger.version}: update the ledger for the new version first.`);
  }
  if (uploaded !== undefined) {
    if (!isBuild(uploaded)) throw new Error(`--uploaded must be a whole build number (got ${uploaded}).`);
    const known = ledger.highestUploaded.build;
    if (isBuild(known) && uploaded < known) throw new Error(`--uploaded ${uploaded} is lower than the recorded highest upload ${known}.`);
    ledger.highestUploaded = { build: uploaded, confirmed: today, source: 'Confirmed by the developer from App Store Connect' };
  }
  const build = nextBuild(appBuild, ledger.highestUploaded.build);
  app.expo.ios.buildNumber = String(build);
  ledger.prepared = { build, contents: contents || (build === appBuild ? ledger.prepared.contents : 'Next TestFlight build') };
  writeJson(root, APP_JSON, app);
  writeJson(root, LEDGER, ledger);
  return build;
}

function recordUpload(root = PROJECT_ROOT, build, today = new Date().toISOString().slice(0, 10)) {
  if (!isBuild(build)) throw new Error(`record-upload needs a whole build number (got ${build}).`);
  const ledger = readJson(root, LEDGER);
  const known = ledger.highestUploaded.build;
  if (!isBuild(known) || build > known) {
    ledger.highestUploaded = { build, confirmed: today, source: 'Confirmed by the developer from App Store Connect' };
    writeJson(root, LEDGER, ledger);
  }
  return ledger.highestUploaded.build;
}

/** CFBundleVersion from the Info.plist Xcode is building (null if unreadable) */
function infoPlistBuild(file) {
  try {
    const expo = require.resolve('expo/package.json', { paths: [PROJECT_ROOT] });
    const configPlugins = require.resolve('@expo/config-plugins', { paths: [expo] });
    const plist = require(require.resolve('@expo/plist', { paths: [configPlugins] })).default;
    return plist.parse(fs.readFileSync(file, 'utf8')).CFBundleVersion ?? null;
  } catch {
    return null;
  }
}

module.exports = { nextBuild, xcodeCheck, status, prepare, recordUpload, readState };

if (require.main === module) {
  const [command = 'status', ...args] = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    if (command === 'status') {
      console.log(status());
    } else if (command === 'prepare') {
      const uploaded = option('--uploaded');
      const build = prepare(PROJECT_ROOT, { uploaded: uploaded === undefined ? undefined : Number(uploaded), contents: option('--contents') });
      console.log(`Prepared build ${build}.\n${status()}`);
    } else if (command === 'record-upload') {
      console.log(`Highest uploaded build: ${recordUpload(PROJECT_ROOT, Number(args[0]))}.\n${status()}`);
    } else if (command === 'xcode-check') {
      const { appBuild, ledger } = readState();
      const env = process.env;
      const { errors, warnings } = xcodeCheck({
        appBuild,
        highestUploaded: ledger.highestUploaded.build,
        currentProjectVersion: env.CURRENT_PROJECT_VERSION,
        infoPlistBuild: infoPlistBuild(path.join(env.SRCROOT || path.join(PROJECT_ROOT, 'ios'), env.INFOPLIST_FILE || '')),
        configuration: env.CONFIGURATION,
      });
      for (const w of warnings) console.log(`warning: ${w}`);
      for (const e of errors) console.log(`error: ${e}`);
      if (errors.length) process.exit(1);
      console.log(`Build ${appBuild}: checked.`);
    } else {
      throw new Error(`Unknown command "${command}" (status, prepare, record-upload, xcode-check).`);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

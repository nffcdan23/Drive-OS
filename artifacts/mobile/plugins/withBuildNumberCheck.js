/**
 * Adds the "[Derwent] Check build number" build phase to the app target
 * (docs/BUILD_NUMBERS.md). It runs scripts/ios-build-number.js xcode-check
 * with Expo's Node (ios/.xcode.env, as Expo's own bundling phase does), before
 * anything is compiled, so an Archive stops early when:
 *  - the Xcode project is out of date: app.json's build number isn't the one
 *    in Info.plist / CURRENT_PROJECT_VERSION (pulled without re-running
 *    `npx expo prebuild -p ios --clean`);
 *  - the build is already in App Store Connect (ios-build-numbers.json).
 * Debug builds only warn. Added once (prebuild without --clean doesn't
 * duplicate it).
 *
 * Position: directly after CocoaPods' "[CP] Check Pods Manifest.lock", else
 * first. `pod install` always moves that phase to the front of the target
 * (CocoaPods' TargetIntegrator), so this is the order the project keeps after
 * pod install too: nothing is moved again, and the check still runs before
 * Sources (compiling) and every other phase.
 */
const { withXcodeProject } = require('expo/config-plugins');

const PHASE_NAME = '[Derwent] Check build number';
/** The phase `pod install` puts first in the app target */
const PODS_MANIFEST_PHASE = '[CP] Check Pods Manifest.lock';

// Plain POSIX sh (runs the same under any /bin/sh)
const SHELL_SCRIPT = [
  'if [ -f "$PODS_ROOT/../.xcode.env" ]; then',
  '  . "$PODS_ROOT/../.xcode.env"',
  'fi',
  'if [ -f "$PODS_ROOT/../.xcode.env.local" ]; then',
  '  . "$PODS_ROOT/../.xcode.env.local"',
  'fi',
  '"${NODE_BINARY:-node}" "$PROJECT_DIR/../scripts/ios-build-number.js" xcode-check',
  '',
// pbxproj strings carry newlines escaped, as Expo's own build phases do
].join('\\n');

function hasPhase(project) {
  const phases = project.hash.project.objects.PBXShellScriptBuildPhase || {};
  return Object.values(phases).some((p) => p && typeof p === 'object' && String(p.name).replace(/"/g, '') === PHASE_NAME);
}

/**
 * The target's build phase list (entries { value, comment }, in place) with
 * this phase directly after CocoaPods' manifest check, else first
 */
function orderBuildPhases(phases) {
  const index = phases.findIndex((p) => p.comment === PHASE_NAME);
  if (index === -1) return phases;
  const [phase] = phases.splice(index, 1);
  const manifest = phases.findIndex((p) => p.comment === PODS_MANIFEST_PHASE);
  phases.splice(manifest === 0 ? 1 : 0, 0, phase);
  return phases;
}

function withBuildNumberCheck(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = project.getFirstTarget();
    if (!hasPhase(project)) {
      const { buildPhase } = project.addBuildPhase([], 'PBXShellScriptBuildPhase', PHASE_NAME, target.uuid, {
        shellPath: '/bin/sh',
        shellScript: SHELL_SCRIPT,
        inputPaths: ['"$(SRCROOT)/../app.json"', '"$(SRCROOT)/../ios-build-numbers.json"', '"$(SRCROOT)/$(INFOPLIST_FILE)"'],
        outputPaths: [],
      });
      buildPhase.alwaysOutOfDate = 1;
    }
    orderBuildPhases(target.firstTarget.buildPhases);
    return cfg;
  });
}

module.exports = withBuildNumberCheck;
module.exports.PHASE_NAME = PHASE_NAME;
module.exports.PODS_MANIFEST_PHASE = PODS_MANIFEST_PHASE;
module.exports.orderBuildPhases = orderBuildPhases;
module.exports.SHELL_SCRIPT = SHELL_SCRIPT;

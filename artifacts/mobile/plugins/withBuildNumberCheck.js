/**
 * Adds the "[Derwent] Check build number" build phase to the app target
 * (docs/BUILD_NUMBERS.md). It runs scripts/ios-build-number.js xcode-check
 * with Expo's Node (ios/.xcode.env, as Expo's own bundling phase does), first
 * in the target, so an Archive stops before compiling when:
 *  - the Xcode project is out of date: app.json's build number isn't the one
 *    in Info.plist / CURRENT_PROJECT_VERSION (pulled without re-running
 *    `npx expo prebuild -p ios --clean`);
 *  - the build is already in App Store Connect (ios-build-numbers.json).
 * Debug builds only warn. Added once (prebuild without --clean doesn't
 * duplicate it).
 */
const { withXcodeProject } = require('expo/config-plugins');

const PHASE_NAME = '[Derwent] Check build number';

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

function withBuildNumberCheck(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    if (hasPhase(project)) return cfg;
    const target = project.getFirstTarget();
    const { buildPhase } = project.addBuildPhase([], 'PBXShellScriptBuildPhase', PHASE_NAME, target.uuid, {
      shellPath: '/bin/sh',
      shellScript: SHELL_SCRIPT,
      inputPaths: ['"$(SRCROOT)/../app.json"', '"$(SRCROOT)/../ios-build-numbers.json"', '"$(SRCROOT)/$(INFOPLIST_FILE)"'],
      outputPaths: [],
    });
    buildPhase.alwaysOutOfDate = 1;
    // First in the target, so a stale project stops the build before compiling
    const phases = target.firstTarget.buildPhases;
    const index = phases.findIndex((p) => p.comment === PHASE_NAME);
    if (index > 0) phases.unshift(...phases.splice(index, 1));
    return cfg;
  });
}

module.exports = withBuildNumberCheck;
module.exports.PHASE_NAME = PHASE_NAME;
module.exports.SHELL_SCRIPT = SHELL_SCRIPT;

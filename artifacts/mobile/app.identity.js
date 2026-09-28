/**
 * App identity — everything that depends on the final app name.
 *
 * ⚠️  Until CHOSEN is filled in, these are PLACEHOLDERS. Nothing here may be
 * registered with Apple/Google or used for an App Store / TestFlight
 * identifier until the final name and bundle identifier are decided.
 *
 * Once chosen, the values go in CHOSEN below (they are public, so they are
 * committed). An environment variable overrides each one:
 *
 *   APP_DISPLAY_NAME  name on the home screen and in the app's own text
 *   APP_SLUG          Expo/EAS project slug (fixed once `eas init` is run)
 *   APP_SCHEME        deep-link scheme used for sign-in links (<scheme>://)
 *   APP_BUNDLE_ID     iOS bundle id / Android package — NO DEFAULT.
 *                     Without it the native identifiers are left unset, so
 *                     `eas build` stops and asks rather than registering a
 *                     placeholder with Apple.
 *   EAS_PROJECT_ID    printed by `eas init`
 */
const PLACEHOLDER = {
  displayName: 'DriveOS',
  slug: 'driveos',
  scheme: 'driveos',
  /** Candidate only — never applied automatically. */
  bundleIdCandidate: 'com.driveos.app',
};

/**
 * The final identity. null = not chosen yet: the placeholder is used and no
 * bundle id is set. See docs/TESTFLIGHT.md before filling these in; the
 * bundle id can't be changed once Apple has it.
 */
const CHOSEN = {
  displayName: null,
  slug: null,
  scheme: null,
  bundleId: null,
  easProjectId: null,
};

/** Resolves the identity for a build variant ('development' | 'staging' | 'production'). */
function identity(appEnv, env = process.env, chosen = CHOSEN) {
  const production = appEnv === 'production';
  const chosenName = env.APP_DISPLAY_NAME || chosen.displayName;
  const displayName = chosenName || PLACEHOLDER.displayName;
  const scheme = env.APP_SCHEME || chosen.scheme || PLACEHOLDER.scheme;
  const bundleIdBase = env.APP_BUNDLE_ID || chosen.bundleId || null;
  return {
    displayName,
    /** Staging installs side by side with the store app and is labelled as such. */
    appName: production ? displayName : `${displayName} Staging`,
    slug: env.APP_SLUG || chosen.slug || PLACEHOLDER.slug,
    scheme: production ? scheme : `${scheme}-staging`,
    bundleId: bundleIdBase ? (production ? bundleIdBase : `${bundleIdBase}.staging`) : null,
    easProjectId: env.EAS_PROJECT_ID || chosen.easProjectId || null,
    usingPlaceholders: !chosenName || !bundleIdBase,
  };
}

module.exports = { PLACEHOLDER, CHOSEN, identity };

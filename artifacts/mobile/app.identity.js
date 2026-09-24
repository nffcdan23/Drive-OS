/**
 * App identity — everything that depends on the final app name.
 *
 * ⚠️  PLACEHOLDERS. The final name and bundle identifier have NOT been
 * decided. Nothing here may be registered with Apple/Google or used for an
 * App Store / TestFlight identifier until they are.
 *
 * Every value can be overridden with an environment variable, so choosing
 * the final identity later is a configuration change, not a code change.
 *
 *   APP_DISPLAY_NAME  name on the home screen and in the app's own text
 *   APP_SLUG          Expo/EAS project slug (fixed once `eas init` is run)
 *   APP_SCHEME        deep-link scheme used for sign-in links (<scheme>://)
 *   APP_BUNDLE_ID     iOS bundle id / Android package — NO DEFAULT.
 *                     Without it the native identifiers are left unset, so
 *                     `eas build` stops and asks rather than registering a
 *                     placeholder with Apple.
 */
const PLACEHOLDER = {
  displayName: 'DriveOS',
  slug: 'driveos',
  scheme: 'driveos',
  /** Candidate only — never applied automatically. */
  bundleIdCandidate: 'com.driveos.app',
};

/** Resolves the identity for a build variant ('development' | 'staging' | 'production'). */
function identity(appEnv, env = process.env) {
  const production = appEnv === 'production';
  const displayName = env.APP_DISPLAY_NAME || PLACEHOLDER.displayName;
  const scheme = env.APP_SCHEME || PLACEHOLDER.scheme;
  const bundleIdBase = env.APP_BUNDLE_ID || null;
  return {
    displayName,
    /** Staging installs side by side with the store app and is labelled as such. */
    appName: production ? displayName : `${displayName} Staging`,
    slug: env.APP_SLUG || PLACEHOLDER.slug,
    scheme: production ? scheme : `${scheme}-staging`,
    bundleId: bundleIdBase ? (production ? bundleIdBase : `${bundleIdBase}.staging`) : null,
    usingPlaceholders: !env.APP_DISPLAY_NAME || !env.APP_BUNDLE_ID,
  };
}

module.exports = { PLACEHOLDER, identity };

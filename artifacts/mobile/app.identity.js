/**
 * App identity — everything that depends on the final app name.
 *
 * The staging (TestFlight) identity is chosen; see CHOSEN. The public App
 * Store (production) identity is NOT: until it is, production builds use
 * placeholders and set no bundle id, so nothing can be registered for it.
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
 *
 * The EAS project (id and owning Expo account) is recorded ONLY in CHOSEN:
 * not in app.json, not in an environment variable.
 */
const PLACEHOLDER = {
  displayName: 'DriveOS',
  slug: 'driveos',
  scheme: 'driveos',
  /** Candidate only — never applied automatically. */
  bundleIdCandidate: 'com.driveos.app',
};

/**
 * The chosen identity, per build variant. Values here are used exactly as
 * written (no suffixes). null = not chosen: the placeholder is used and no
 * bundle id is set, so nothing can be registered with Apple by accident.
 *
 * staging    = TestFlight / pre-launch app (profiles testflight and staging;
 *              local development uses it too). Talks to the pre-launch backend.
 * production = the public App Store app. NOT chosen: nothing is registered.
 */
const CHOSEN = {
  staging: {
    displayName: 'StarScale Drive',
    slug: 'starscale-drive-staging',
    scheme: 'starscale-drive-staging',
    bundleId: 'uk.co.starscale.drive.staging',
    /** EAS project @dancaw23/starscale-drive-staging (from `eas init`). */
    easProjectId: 'a5ecd99b-322f-4531-b3d9-4bdd3ddb93cf',
    owner: 'dancaw23',
  },
  production: {
    displayName: null,
    slug: null,
    scheme: null,
    bundleId: null,
    easProjectId: null,
    owner: null,
  },
};

/**
 * Resolves the identity for a build variant ('development' | 'staging' | 'production').
 * Order: environment variable (APP_* are base values: staging adds its
 * suffixes) > CHOSEN for the variant (exact) > placeholder.
 */
function identity(appEnv, env = process.env, chosen = CHOSEN) {
  const production = appEnv === 'production';
  const c = (production ? chosen.production : chosen.staging) || {};
  const suffix = (base, s) => (production ? base : `${base}${s}`);
  const displayName = env.APP_DISPLAY_NAME || c.displayName || PLACEHOLDER.displayName;
  const bundleId = env.APP_BUNDLE_ID ? suffix(env.APP_BUNDLE_ID, '.staging') : c.bundleId || null;
  return {
    displayName,
    /** Staging is labelled as such unless its name was chosen explicitly. */
    appName: env.APP_DISPLAY_NAME || !c.displayName ? suffix(displayName, ' Staging') : c.displayName,
    slug: env.APP_SLUG || c.slug || PLACEHOLDER.slug,
    scheme: env.APP_SCHEME ? suffix(env.APP_SCHEME, '-staging') : c.scheme || suffix(PLACEHOLDER.scheme, '-staging'),
    bundleId,
    easProjectId: c.easProjectId || null,
    owner: c.owner || null,
    /** True when this variant's identity is committed in CHOSEN. */
    committed: Boolean(c.bundleId),
    usingPlaceholders: !(env.APP_DISPLAY_NAME || c.displayName) || !bundleId,
  };
}

module.exports = { PLACEHOLDER, CHOSEN, identity };

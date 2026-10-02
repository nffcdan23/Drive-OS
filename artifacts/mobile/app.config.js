/**
 * Build-time app configuration layered on app.json.
 *
 * EXPO_PUBLIC_APP_ENV picks the variant (development | staging | production).
 * The app's name, scheme and bundle identifier come from app.identity.js,
 * which holds PLACEHOLDERS until the final name is chosen — see that file.
 */
const { identity } = require('./app.identity');

/**
 * True for values that must only ever live on a server: a Supabase secret or
 * service-role key, or a database URL with a password.
 */
function isServerSecret(value) {
  const v = String(value ?? '');
  if (v.includes('sb_secret_')) return true;
  // A Mapbox secret token (sk.…): only the public pk.… token belongs in the app
  if (/(^|[^A-Za-z0-9])sk\.eyJ/.test(v)) return true;
  if (/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i.test(v)) return true;
  for (const jwt of v.match(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g) || []) {
    try {
      if (JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).role === 'service_role') return true;
    } catch {
      // Not a JWT.
    }
  }
  return false;
}

/**
 * True while `eas build` reads this file on your computer before uploading.
 * That read has no .env files and not the EAS environment's values, so the
 * backend settings can legitimately be absent. EAS CLI evaluates the config
 * either through `expo config` with EXPO_NO_DOTENV=1, or (when `expo` is a
 * devDependency, as here) in its own process.
 */
function isEasCliConfigRead() {
  if (process.env.EXPO_NO_DOTENV === '1') return true;
  return [require.main && require.main.filename, process.argv[1]]
    .some((entry) => /[\\/]eas-cli[\\/]/.test(String(entry || '')));
}

module.exports = ({ config }) => {
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV || 'development';
  const id = identity(appEnv);
  const name = id.displayName;

  // The DVLA key belongs on the API server only. EXPO_PUBLIC_* values are
  // compiled into the app, where anyone can extract them.
  const publicNames = Object.keys(process.env).filter((k) => k.startsWith('EXPO_PUBLIC_'));
  const dvlaKey = (process.env.DVLA_API_KEY || '').trim();
  const leaks = publicNames.filter((k) => /DVLA|VES_/i.test(k) || (dvlaKey && String(process.env[k]).includes(dvlaKey)));
  if (leaks.length) {
    throw new Error(`Refusing to build: ${leaks.join(', ')} would put DVLA credentials in the app. The DVLA key belongs on the API server only.`);
  }
  // Likewise the Supabase secret key and the database password: only the
  // project URL and the publishable key may be public.
  const secrets = publicNames.filter((k) => isServerSecret(process.env[k]));
  if (secrets.length) {
    throw new Error(`Refusing to build: ${secrets.join(', ')} holds a server secret (a Supabase secret or service-role key, a database URL with a password, or a Mapbox secret token). Only public values may be EXPO_PUBLIC_*.`);
  }

  // Store builds use the committed identity only. An APP_* override (e.g. a
  // leftover EAS environment variable) would otherwise register a different
  // bundle id with Apple, which can't be undone.
  if ((appEnv === 'staging' || appEnv === 'production') && id.committed) {
    const overrides = ['APP_DISPLAY_NAME', 'APP_SLUG', 'APP_SCHEME', 'APP_BUNDLE_ID'].filter((k) => process.env[k]);
    if (overrides.length) {
      throw new Error(`Refusing to build: ${overrides.join(', ')} would override the ${appEnv} identity committed in app.identity.js. Remove them (check \`eas env:list\`).`);
    }
  }

  // The EAS project id lives only in app.identity.js. A copy in app.json (as
  // `eas init` writes) would also reach builds of the other variant.
  const staticProjectId = config.extra?.eas?.projectId;
  if (staticProjectId && staticProjectId !== id.easProjectId) {
    throw new Error(`app.json has extra.eas.projectId "${staticProjectId}", but the ${appEnv} identity in app.identity.js has ${id.easProjectId ? `"${id.easProjectId}"` : 'none'}. Keep the EAS project id only in app.identity.js: remove "extra.eas" from app.json.`);
  }

  // A staging or production build without its backend settings would install
  // but never connect; fail the build instead. (The values are public.)
  if (appEnv === 'staging' || appEnv === 'production') {
    const missing = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_API_URL']
      .filter((k) => !process.env[k]);
    if (missing.length) {
      const message = `${appEnv} build is missing ${missing.join(', ')} (set them in the EAS "${appEnv === 'staging' ? 'preview' : 'production'}" environment)`;
      if (!isEasCliConfigRead()) throw new Error(message);
      // stderr only: EAS CLI parses this command's stdout as JSON.
      console.warn(`${message}. Not visible to EAS CLI locally; the EAS build server checks again.`);
    }
  }

  return {
    ...config,
    ...(id.owner ? { owner: id.owner } : {}),
    name: id.appName,
    slug: id.slug,
    scheme: id.scheme,
    ios: {
      ...config.ios,
      // Left unset without APP_BUNDLE_ID so nothing is registered by accident.
      ...(id.bundleId ? { bundleIdentifier: id.bundleId } : {}),
      usesAppleSignIn: true,
      infoPlist: {
        ...config.ios.infoPlist,
        NSLocationWhenInUseUsageDescription: `${name} uses your location to show your position on the map and record your drives while the app is open.`,
        NSPhotoLibraryUsageDescription: `${name} needs access to your photos to set your vehicle and profile pictures.`,
        NSPhotoLibraryAddUsageDescription: `${name} needs to save journey photos to your library.`,
        // Required, but never shown: expo-location compiles Core Motion
        // activity code (CMMotionActivityManager) into every iOS app, and App
        // Store Connect rejects a binary that references it without this key.
        // The prompt only appears if the app calls expo-location's motion
        // activity functions, which it doesn't (a unit test keeps it that way).
        NSMotionUsageDescription: `${name} doesn't use your motion and fitness activity. Its location component includes this capability, but the app never requests it.`,
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      ...config.android,
      ...(id.bundleId ? { package: id.bundleId.replace(/-/g, '_') } : {}),
    },
    // Permission prompts: only the ones above. app.json turns off the camera,
    // microphone and "Always" location prompts the plugins would add by
    // default (nothing in the app uses them); Face ID is turned off here.
    plugins: [
      ...config.plugins,
      'expo-apple-authentication',
      ['expo-secure-store', { faceIDPermission: false }],
      // Mapbox Maps SDK for the Drive map (no download token needed)
      '@rnmapbox/maps',
    ],
    extra: {
      ...(config.extra || {}),
      // From `eas init`, recorded only in app.identity.js (per variant).
      eas: id.easProjectId ? { projectId: id.easProjectId } : undefined,
      appEnv,
      displayName: name,
      identityIsPlaceholder: id.usingPlaceholders,
    },
  };
};

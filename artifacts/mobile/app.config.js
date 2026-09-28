/**
 * Build-time app configuration layered on app.json.
 *
 * EXPO_PUBLIC_APP_ENV picks the variant (development | staging | production).
 * The app's name, scheme and bundle identifier come from app.identity.js,
 * which holds PLACEHOLDERS until the final name is chosen — see that file.
 */
const { identity } = require('./app.identity');

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

  // A staging or production build without its backend settings would install
  // but never connect; fail the build instead. (The values are public.)
  if (appEnv === 'staging' || appEnv === 'production') {
    const missing = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_API_URL']
      .filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(`${appEnv} build is missing ${missing.join(', ')} (set them in the EAS "${appEnv === 'staging' ? 'preview' : 'production'}" environment)`);
    }
  }

  return {
    ...config,
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
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      ...config.android,
      ...(id.bundleId ? { package: id.bundleId.replace(/-/g, '_') } : {}),
    },
    plugins: [
      ...config.plugins,
      'expo-apple-authentication',
      'expo-secure-store',
    ],
    extra: {
      ...(config.extra || {}),
      // Set after `eas init` (EAS_PROJECT_ID), so no EAS project is tied to the
      // placeholder name in the repository.
      ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
      appEnv,
      displayName: name,
      identityIsPlaceholder: id.usingPlaceholders,
    },
  };
};

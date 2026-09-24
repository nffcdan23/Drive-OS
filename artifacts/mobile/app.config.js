/**
 * Build-time app configuration layered on app.json.
 *
 * EXPO_PUBLIC_APP_ENV picks the variant:
 *   staging     "DriveOS Staging", bundle id <base>.staging, scheme driveos-staging
 *   production  "DriveOS", bundle id <base>, scheme driveos
 * so a staging build and the App Store build can be installed side by side
 * and their sign-in links never open the wrong app.
 *
 * DRIVEOS_BUNDLE_ID overrides the base identifier (default com.driveos.app).
 * The bundle id must match the App ID registered with Apple, and each
 * variant's id must be listed in Supabase → Auth → Apple → Client IDs.
 */
module.exports = ({ config }) => {
  const env = process.env.EXPO_PUBLIC_APP_ENV || 'development';
  const production = env === 'production';
  const baseId = process.env.DRIVEOS_BUNDLE_ID || 'com.driveos.app';
  const id = production ? baseId : `${baseId}.staging`;
  const scheme = production ? 'driveos' : 'driveos-staging';

  return {
    ...config,
    name: production ? 'DriveOS' : 'DriveOS Staging',
    slug: 'driveos',
    scheme,
    ios: {
      ...config.ios,
      bundleIdentifier: id,
      usesAppleSignIn: true,
      infoPlist: {
        ...config.ios.infoPlist,
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      ...config.android,
      package: id.replace(/-/g, '_'),
    },
    plugins: [
      ...config.plugins,
      'expo-apple-authentication',
      'expo-secure-store',
    ],
    extra: {
      ...(config.extra || {}),
      appEnv: env,
    },
  };
};

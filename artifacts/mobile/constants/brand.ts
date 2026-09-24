/**
 * The app's display name, from app.identity.js via the Expo config. It is a
 * placeholder until the final name is chosen — never hard-code the name in
 * screens; use APP_NAME.
 */
import Constants from 'expo-constants';

export const APP_NAME: string = (Constants.expoConfig?.extra?.displayName as string | undefined) ?? 'DriveOS';

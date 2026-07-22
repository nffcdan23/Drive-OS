import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const DEVICE_ID_KEY = '@driveos:deviceId';

let cachedDeviceId: string | null = null;

/**
 * Returns the stable device UUID, generating and persisting one on first call.
 * Caches in-memory after the first AsyncStorage read for instant subsequent access.
 */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      cachedDeviceId = stored;
      return stored;
    }
  } catch {
    // AsyncStorage unavailable — fall through to generate
  }

  const id = Crypto.randomUUID();
  cachedDeviceId = id;
  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Best-effort — will regenerate on next cold start if storage fails
  }
  return id;
}

/** Returns the device ID synchronously if already loaded, or null. */
export function getCachedDeviceId(): string | null {
  return cachedDeviceId;
}

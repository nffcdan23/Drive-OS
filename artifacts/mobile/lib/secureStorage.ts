/**
 * Where the Supabase session lives on the device.
 *
 * Native: the iOS Keychain / Android Keystore via expo-secure-store. A
 * session (access + refresh token) can exceed SecureStore's recommended
 * 2 KB per value, so values are split into chunks.
 * Web (development only): localStorage.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KeyValueStore } from '@/lib/backend/storage';

const CHUNK = 1800;
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

// SecureStore keys may only contain letters, digits, ".", "-" and "_".
const safe = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

const secureStore: KeyValueStore = {
  async getItem(key) {
    const k = safe(key);
    const count = await SecureStore.getItemAsync(`${k}.n`, OPTIONS);
    if (count === null) return SecureStore.getItemAsync(k, OPTIONS);
    const parts: string[] = [];
    for (let i = 0; i < Number(count); i++) {
      const part = await SecureStore.getItemAsync(`${k}.${i}`, OPTIONS);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  },
  async setItem(key, value) {
    const k = safe(key);
    await this.removeItem(key);
    const chunks = Math.ceil(value.length / CHUNK) || 1;
    for (let i = 0; i < chunks; i++) {
      await SecureStore.setItemAsync(`${k}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK), OPTIONS);
    }
    await SecureStore.setItemAsync(`${k}.n`, String(chunks), OPTIONS);
  },
  async removeItem(key) {
    const k = safe(key);
    const count = await SecureStore.getItemAsync(`${k}.n`, OPTIONS);
    if (count !== null) {
      for (let i = 0; i < Number(count); i++) await SecureStore.deleteItemAsync(`${k}.${i}`, OPTIONS);
      await SecureStore.deleteItemAsync(`${k}.n`, OPTIONS);
    }
    await SecureStore.deleteItemAsync(k, OPTIONS);
  },
};

const webStore: KeyValueStore = {
  async getItem(key) { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); },
  async setItem(key, value) { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); },
  async removeItem(key) { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); },
};

/** Secure storage for the auth session. */
export const authStorage: KeyValueStore = Platform.OS === 'web' ? webStore : secureStore;

/** Ordinary device storage for the per-user cache, outbox and drives. */
export const deviceStorage: KeyValueStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

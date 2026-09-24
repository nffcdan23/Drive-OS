/** Minimal async key-value storage (AsyncStorage, SecureStore or an in-memory map). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async getItem(key: string) { return this.data.get(key) ?? null; }
  async setItem(key: string, value: string) { this.data.set(key, value); }
  async removeItem(key: string) { this.data.delete(key); }
}

/**
 * Keys for data cached on this device. Everything is namespaced by the
 * signed-in user's id so two accounts on one phone never see each other's
 * cache. The pre-Supabase keys (`@driveos/vehicles`, …) are left untouched
 * for the future importer and are never read as current data.
 */
export const userKey = (userId: string, name: string) => `@driveos/u/${userId}/${name}`;

export const LEGACY_KEYS = [
  '@driveos/vehicles', '@driveos/journeys', '@driveos/profile', '@driveos/passengerMode',
  '@driveos/categories', '@driveos/convoys', '@driveos/friends', '@driveos/friendRequests',
  '@driveos/blocked', '@driveos/groups', '@driveos/events', '@driveos/conversations',
  '@driveos/messages', '@driveos/notifications', '@driveos/unitSystem',
  '@driveos:deviceId', '@driveos:journeyDraft',
] as const;

export async function readJson<T>(store: KeyValueStore, key: string, fallback: T): Promise<T> {
  try {
    const raw = await store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJson(store: KeyValueStore, key: string, value: unknown): Promise<void> {
  await store.setItem(key, JSON.stringify(value));
}

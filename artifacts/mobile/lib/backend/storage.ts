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

/**
 * A read that tells "nothing saved" apart from "couldn't read it".
 * readJson treats both as the fallback, which is fine for caches but not for
 * a drive: an unreadable drive must never be taken for no drive (and then
 * overwritten).  `io` is a failed read (worth retrying); `corrupt` read
 * something that isn't the expected value (`raw` is kept to preserve it).
 */
export type CheckedRead<T> =
  | { ok: true; value: T | null }
  | { ok: false; reason: 'io' | 'corrupt'; raw: string | null; error: string };

export async function readJsonChecked<T>(
  store: KeyValueStore,
  key: string,
  isValid: (v: unknown) => boolean = () => true,
): Promise<CheckedRead<T>> {
  let raw: string | null;
  try {
    raw = await store.getItem(key);
  } catch (err) {
    return { ok: false, reason: 'io', raw: null, error: errorText(err) };
  }
  if (raw == null || raw === '') return { ok: true, value: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'corrupt', raw, error: errorText(err) };
  }
  if (value === null) return { ok: true, value: null };
  if (!isValid(value)) return { ok: false, reason: 'corrupt', raw, error: 'unexpected contents' };
  return { ok: true, value: value as T };
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

export async function writeJson(store: KeyValueStore, key: string, value: unknown): Promise<void> {
  await store.setItem(key, JSON.stringify(value));
}

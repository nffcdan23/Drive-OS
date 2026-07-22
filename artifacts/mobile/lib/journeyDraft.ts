/**
 * Journey draft persistence.
 *
 * On web: IndexedDB via a minimal Promise wrapper.
 * On native (React Native): AsyncStorage.
 *
 * The draft records the in-progress journey so an accidental reload
 * can restore the active drive state.
 */
import { Platform } from 'react-native';

export interface DraftRoutePoint {
  latitude: number;
  longitude: number;
  speedKmh: number;
  accuracyM?: number;
  recordedAt: string; // ISO timestamp
}

export interface JourneyDraft {
  draftId: string;         // local UUID (not the server journey ID)
  journeyId: string;       // server-assigned UUID from POST /api/journeys
  vehicleId: string | null;
  vehicleSnapshot: unknown | null;
  startTime: number;       // Date.now() when drive started
  routePoints: DraftRoutePoint[];   // all accumulated GPS points
  pendingPoints: DraftRoutePoint[]; // not yet flushed to server
  stats: {
    distanceKm: number;
    topSpeedKmh: number;
    speedSamples: number[];
  };
}

// ─── Web: IndexedDB ───────────────────────────────────────────────────────────

const IDB_NAME    = 'driveos';
const IDB_VERSION = 1;
const STORE_NAME  = 'journey_draft';
const DRAFT_KEY   = 'active';

let idbPromise: Promise<IDBDatabase> | null = null;

function openIDB(): Promise<IDBDatabase> {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror   = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
  return idbPromise;
}

function idbGet(db: IDBDatabase, key: string): Promise<JourneyDraft | null> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as JourneyDraft) ?? null);
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: JourneyDraft): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ─── Native: AsyncStorage ─────────────────────────────────────────────────────

const ASYNC_STORAGE_KEY = '@driveos:journeyDraft';

async function asyncStorageGet(): Promise<JourneyDraft | null> {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  const raw = await AsyncStorage.getItem(ASYNC_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as JourneyDraft) : null;
}

async function asyncStoragePut(draft: JourneyDraft): Promise<void> {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  await AsyncStorage.setItem(ASYNC_STORAGE_KEY, JSON.stringify(draft));
}

async function asyncStorageDelete(): Promise<void> {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  await AsyncStorage.removeItem(ASYNC_STORAGE_KEY);
}

// ─── Platform-unified API ────────────────────────────────────────────────────

const isWeb = Platform.OS === 'web' && typeof indexedDB !== 'undefined';

export async function loadDraft(): Promise<JourneyDraft | null> {
  try {
    if (isWeb) {
      const db = await openIDB();
      return await idbGet(db, DRAFT_KEY);
    } else {
      return await asyncStorageGet();
    }
  } catch {
    return null;
  }
}

export async function saveDraft(draft: JourneyDraft): Promise<void> {
  try {
    if (isWeb) {
      const db = await openIDB();
      await idbPut(db, DRAFT_KEY, draft);
    } else {
      await asyncStoragePut(draft);
    }
  } catch {
    // Best-effort — in-memory state is still valid even if persistence fails
  }
}

export async function clearDraft(): Promise<void> {
  try {
    if (isWeb) {
      const db = await openIDB();
      await idbDelete(db, DRAFT_KEY);
    } else {
      await asyncStorageDelete();
    }
  } catch {
    // Ignore
  }
}

/** Append new GPS points to the draft (both routePoints and pendingPoints). */
export async function appendRoutePoints(
  current: JourneyDraft,
  points: DraftRoutePoint[],
): Promise<JourneyDraft> {
  const updated: JourneyDraft = {
    ...current,
    routePoints:  [...current.routePoints, ...points],
    pendingPoints: [...current.pendingPoints, ...points],
  };
  await saveDraft(updated);
  return updated;
}

/** Clear pending points after a successful server flush. */
export async function clearPendingPoints(current: JourneyDraft): Promise<JourneyDraft> {
  const updated: JourneyDraft = { ...current, pendingPoints: [] };
  await saveDraft(updated);
  return updated;
}

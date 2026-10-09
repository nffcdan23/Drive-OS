// Recent destinations: the places the user actually went to a preview for,
// newest first. On this device only, per signed-in user (cleared with the
// rest of their device data at sign-out), at most RECENTS.max of them, and
// only the destination itself: no route, no search text, nothing from the
// server.
//
// Search Box results are never kept here: Mapbox's terms allow them for
// temporary use only (canStoreDestination). The user's own places, typed
// coordinates and map pins are.
//
// No React Native imports, so it is unit-tested under node.

import { distanceM } from '../backend/geo';
import { readJson, userKey, writeJson, type KeyValueStore } from '../backend/storage';
import { canStoreDestination, type Destination } from './model';

export const RECENTS = {
  max: 12,
  /** Two recents this close together are the same place (m) */
  sameWithinM: 25,
  name: 'nav/recents/v1',
} as const;

export interface RecentDestination extends Destination {
  usedAt: number;
}

export const recentsKey = (userId: string) => userKey(userId, RECENTS.name);

const clean = (d: Destination, usedAt: number): RecentDestination => ({
  // Exactly these fields: nothing else a caller passes in is kept
  id: d.id,
  name: d.name.slice(0, 120),
  subtitle: d.subtitle ? d.subtitle.slice(0, 200) : null,
  coordinate: { latitude: d.coordinate.latitude, longitude: d.coordinate.longitude },
  source: d.source,
  usedAt,
});

const valid = (r: unknown): r is RecentDestination => {
  const x = r as RecentDestination;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string'
    && typeof x.coordinate?.latitude === 'number' && typeof x.coordinate?.longitude === 'number'
    && typeof x.usedAt === 'number' && canStoreDestination(x);
};

export class RecentDestinations {
  private list: RecentDestination[] = [];
  private listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly store: KeyValueStore,
    private readonly userId: string,
    private readonly now: () => number = Date.now,
  ) {}

  get items(): readonly RecentDestination[] {
    return this.list;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }

  load(): Promise<void> {
    this.loaded ??= readJson<unknown>(this.store, recentsKey(this.userId), []).then((raw) => {
      this.list = (Array.isArray(raw) ? raw.filter(valid) : []).slice(0, RECENTS.max).map((r) => clean(r, r.usedAt));
      this.emit();
    });
    return this.loaded;
  }

  /** The user went to a preview for `d`. Search Box results are not kept. */
  async record(d: Destination): Promise<void> {
    if (!canStoreDestination(d)) return;
    await this.load();
    const entry = clean(d, this.now());
    const rest = this.list.filter((r) => r.id !== d.id && distanceM(r.coordinate, d.coordinate) > RECENTS.sameWithinM);
    this.list = [entry, ...rest].slice(0, RECENTS.max);
    this.emit();
    await writeJson(this.store, recentsKey(this.userId), this.list).catch(() => {});
  }

  async remove(id: string): Promise<void> {
    await this.load();
    this.list = this.list.filter((r) => r.id !== id);
    this.emit();
    await writeJson(this.store, recentsKey(this.userId), this.list).catch(() => {});
  }

  async clear(): Promise<void> {
    this.list = [];
    this.loaded = Promise.resolve();
    this.emit();
    await this.store.removeItem(recentsKey(this.userId)).catch(() => {});
  }
}

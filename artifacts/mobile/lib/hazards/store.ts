// The road hazards near the driver, in memory only (never stored on the
// phone: they are minutes old and anonymous, and the next snapshot replaces
// them). Read by the map layer and the detail card through subscribe/list,
// so a change re-renders only those, never the Drive screen.
//
// No React Native imports, so it is unit-tested under node.

import { inArea, type Area, type HazardEvent, type RoadHazard } from './model';

export class HazardStore {
  private byId = new Map<string, RoadHazard>();
  private snapshot: RoadHazard[] = [];
  private listeners = new Set<() => void>();
  /** Where the current set was loaded for; live updates outside it are ignored */
  private area: Area | null = null;
  /** The hazard whose card is open, if any */
  private selectedId: string | null = null;

  get list(): readonly RoadHazard[] {
    return this.snapshot;
  }

  get selected(): RoadHazard | null {
    return this.selectedId ? this.byId.get(this.selectedId) ?? null : null;
  }

  get loadedArea(): Area | null {
    return this.area;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    this.snapshot = [...this.byId.values()];
    if (this.selectedId && !this.byId.has(this.selectedId)) this.selectedId = null;
    for (const fn of [...this.listeners]) fn();
  }

  /** A fresh snapshot for an area: replaces everything (what isn't in it has gone) */
  replace(area: Area, hazards: readonly RoadHazard[], now: number) {
    this.area = area;
    this.byId = new Map(hazards.filter((h) => h.expiresAt > now).map((h) => [h.id, h]));
    this.changed();
  }

  /** A live update. The driver's own vote is kept: broadcasts never carry it. */
  apply(event: HazardEvent, now: number) {
    if (event.type === 'hazard_removed') {
      if (this.byId.delete(event.id)) this.changed();
      return;
    }
    const h = event.hazard;
    const known = this.byId.get(h.id);
    if (!known && (!this.area || !inArea(this.area, h.latitude, h.longitude))) return;
    if (h.expiresAt <= now) {
      if (known) {
        this.byId.delete(h.id);
        this.changed();
      }
      return;
    }
    this.byId.set(h.id, { ...h, myVote: known?.myVote ?? h.myVote });
    this.changed();
  }

  /** The server's answer to this driver's own report or vote (null: it has gone) */
  upsertOwn(id: string, hazard: RoadHazard | null) {
    if (!hazard) {
      if (this.byId.delete(id)) this.changed();
      return;
    }
    this.byId.set(hazard.id, hazard);
    this.changed();
  }

  /** Drops what has expired (by the server's clock, as received) */
  prune(now: number) {
    let any = false;
    for (const [id, h] of this.byId) {
      if (h.expiresAt <= now) {
        this.byId.delete(id);
        any = true;
      }
    }
    if (any) this.changed();
  }

  select(id: string | null) {
    const next = id && this.byId.has(id) ? id : null;
    if (next === this.selectedId) return;
    this.selectedId = next;
    for (const fn of [...this.listeners]) fn();
  }

  /** Signed out, or the app left the screen for long: nothing is kept */
  clear() {
    this.area = null;
    this.selectedId = null;
    if (this.byId.size === 0) return;
    this.byId.clear();
    this.changed();
  }
}

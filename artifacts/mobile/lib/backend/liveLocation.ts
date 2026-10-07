/**
 * Private live location (migration 0018), on the device.
 *
 * Two halves, both free of React Native imports so they are unit-tested
 * under node:
 *
 *  - LiveLocationPublisher sends this user's position while their sharing
 *    setting applies. It never starts GPS of its own: during a drive it
 *    reuses the drive's accepted fixes (screen or background), and outside a
 *    drive only the Drive screen's foreground fixes, and only while the app is
 *    on screen. The server decides again on every update (sharing mode,
 *    driving, on screen) and refuses anything that no longer applies, so this
 *    side failing open can't share more than the user chose.
 *
 *  - LiveLocationStore holds the positions shared WITH this user, in memory
 *    only (never written to the device), from the snapshot plus the Realtime
 *    inbox. A position disappears when the sharer revokes it, when it
 *    expires, and whenever the app leaves the screen.
 *
 * Coordinates are never logged.
 */
import { ApiError } from './http';
import type { GpsFix } from './journeyRecorder';

// ─── Shared types ────────────────────────────────────────────────────────────

export type LocationSharingMode = 'off' | 'while_driving' | 'while_using';
export type LocationFriendAudience = 'none' | 'selected' | 'all';

/** A position shared with this user, as the API and the inbox send it. */
export interface LiveLocation {
  userId: string;
  latitude: number;
  longitude: number;
  headingDeg: number | null;
  speedKmh: number | null;
  accuracyM: number | null;
  driving: boolean;
  recordedAt: string;
  expiresAt: string;
}

/**
 * `sentAt` is the server's time of sending: an update sent before a removal
 * the app already has is ignored, whatever order they arrive in.
 */
export type LiveLocationEvent =
  | ({ type: 'live_location'; sentAt?: string } & LiveLocation)
  | { type: 'live_location_hidden'; userId: string; sentAt?: string };

/** A snapshot entry may also say how long it has left, by the server's clock. */
type Received = LiveLocation & { expiresInMs?: number };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optionalNumber = (v: unknown, min: number, max: number): number | null | undefined =>
  v == null ? null : finite(v) && v >= min && v <= max ? v : undefined;

/** Validates one position from the API or the inbox; anything malformed is null (ignored). */
export function parseLiveLocation(p: unknown): Received | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (typeof o.userId !== 'string' || !o.userId) return null;
  if (!finite(o.latitude) || o.latitude < -90 || o.latitude > 90) return null;
  if (!finite(o.longitude) || o.longitude < -180 || o.longitude > 180) return null;
  if (typeof o.recordedAt !== 'string' || typeof o.expiresAt !== 'string') return null;
  const recorded = Date.parse(o.recordedAt);
  const expires = Date.parse(o.expiresAt);
  if (Number.isNaN(recorded) || Number.isNaN(expires) || expires <= recorded) return null;
  const headingDeg = optionalNumber(o.headingDeg, 0, 360);
  const speedKmh = optionalNumber(o.speedKmh, 0, 400);
  const accuracyM = optionalNumber(o.accuracyM, 0, 100_000);
  if (headingDeg === undefined || speedKmh === undefined || accuracyM === undefined) return null;
  const loc: Received = {
    userId: o.userId, latitude: o.latitude, longitude: o.longitude, headingDeg, speedKmh, accuracyM,
    driving: o.driving === true, recordedAt: o.recordedAt, expiresAt: o.expiresAt,
  };
  if (finite(o.expiresInMs) && o.expiresInMs >= 0) loc.expiresInMs = o.expiresInMs;
  return loc;
}

const sentAtOf = (v: unknown): string | undefined =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined;

/** Validates an inbox payload (event 'live_location'); anything unexpected is null. */
export function parseLiveLocationEvent(payload: unknown): LiveLocationEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const sentAt = sentAtOf(p.sentAt);
  if (p.type === 'live_location_hidden') {
    if (typeof p.userId !== 'string' || !p.userId) return null;
    return sentAt ? { type: 'live_location_hidden', userId: p.userId, sentAt } : { type: 'live_location_hidden', userId: p.userId };
  }
  if (p.type !== 'live_location') return null;
  const parsed = parseLiveLocation(p);
  if (!parsed) return null;
  const { expiresInMs: _ignored, ...loc } = parsed;
  return sentAt ? { type: 'live_location', ...loc, sentAt } : { type: 'live_location', ...loc };
}

// ─── Positions shared with this user ─────────────────────────────────────────

/** Never keep a position longer than this, whatever it says. */
const MAX_TTL_MS = 10 * 60_000;

interface Held {
  loc: LiveLocation;
  /** Local time after which it is dropped (timed from receipt, so phone clocks don't matter). */
  dropAt: number;
}

export interface LiveLocationStoreDeps {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class LiveLocationStore {
  private items = new Map<string, Held>();
  /** When each sharer's position was last removed (server time, ms). */
  private removedAt = new Map<string, number>();
  private listeners = new Set<() => void>();
  private cached: LiveLocation[] | null = [];
  private timer: unknown = null;

  constructor(private readonly deps: LiveLocationStoreDeps = {}) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }

  /** The current positions (a stable array between changes, for React). */
  get list(): LiveLocation[] {
    if (!this.cached) this.cached = [...this.items.values()].map((h) => h.loc);
    return this.cached;
  }

  get(userId: string): LiveLocation | null {
    const h = this.items.get(userId);
    return h && h.dropAt > this.now() ? h.loc : null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** The snapshot from GET /live-locations: anyone not in it is dropped. */
  replaceAll(locations: readonly unknown[]): void {
    const next = new Map<string, Held>();
    for (const raw of locations) {
      const parsed = parseLiveLocation(raw);
      if (!parsed) continue;
      const { expiresInMs, ...loc } = parsed;
      next.set(loc.userId, this.hold(loc, expiresInMs));
    }
    this.items = next;
    this.changed();
  }

  apply(event: LiveLocationEvent): void {
    const sent = event.sentAt ? Date.parse(event.sentAt) : null;
    if (event.type === 'live_location_hidden') {
      if (sent != null) this.removedAt.set(event.userId, Math.max(sent, this.removedAt.get(event.userId) ?? -Infinity));
      this.remove(event.userId);
      return;
    }
    const { type: _type, sentAt: _sentAt, ...loc } = event;
    // Sent before a removal we already have (delivered late): ignored.
    const removed = this.removedAt.get(loc.userId);
    if (removed != null && (sent == null || sent <= removed)) return;
    const current = this.items.get(loc.userId);
    // An older update arriving late never replaces a newer one.
    if (current && Date.parse(current.loc.recordedAt) > Date.parse(loc.recordedAt)) return;
    this.items.set(loc.userId, this.hold(loc));
    this.changed();
  }

  /** Drop one person's position (revoked, unfriended, blocked). */
  remove(userId: string): void {
    if (this.items.delete(userId)) this.changed();
  }

  /** Drop positions that have expired. */
  prune(): void {
    const now = this.now();
    let removed = false;
    for (const [id, h] of this.items) {
      if (h.dropAt <= now) { this.items.delete(id); removed = true; }
    }
    if (removed) this.changed();
  }

  /** Drop everything (app left the screen, sign-out). */
  clear(): void {
    this.removedAt.clear();
    if (!this.items.size) return;
    this.items.clear();
    this.changed();
  }

  /** Held for what's left of its life: the server's remaining time when known (snapshot), else its full lifetime (just sent). */
  private hold(loc: LiveLocation, remainingMs?: number): Held {
    const lifetime = Math.max(Date.parse(loc.expiresAt) - Date.parse(loc.recordedAt), 0);
    const ttl = Math.min(remainingMs ?? lifetime, lifetime, MAX_TTL_MS);
    return { loc, dropAt: this.now() + ttl };
  }

  private changed() {
    this.cached = null;
    this.schedulePrune();
    for (const fn of this.listeners) fn();
  }

  /** Each position is dropped the moment it expires, not at the next check. */
  private schedulePrune() {
    if (this.timer != null) {
      (this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
    if (!this.items.size) return;
    const next = Math.min(...[...this.items.values()].map((h) => h.dropAt));
    const later = this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = later(() => { this.timer = null; this.prune(); }, Math.max(0, next - this.now()) + 50);
  }
}

// ─── Publishing this user's position ─────────────────────────────────────────

/** During a drive: at most every 5 s; every 10 s, or sooner after 50 m. */
export const DRIVE_MIN_INTERVAL_MS = 5_000;
export const DRIVE_INTERVAL_MS = 10_000;
export const DRIVE_DISTANCE_M = 50;
/** On screen, not driving: at most every 30 s; every 60 s, or sooner after 100 m. */
export const USING_MIN_INTERVAL_MS = 30_000;
export const USING_INTERVAL_MS = 60_000;
export const USING_DISTANCE_M = 100;
/** Fixes worse than this, or older than this, are not worth sharing. */
export const MAX_ACCURACY_M = 100;
export const MAX_FIX_AGE_MS = 60_000;
/** After the server says sharing doesn't apply right now, wait before trying again. */
export const REFUSED_BACKOFF_MS = 30_000;
/** After a network or server failure. */
export const FAILURE_BACKOFF_MS = 15_000;

export interface LiveLocationUpdate {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  capturedAt?: string;
}

/** Why a fix was or wasn't sent (development diagnostics; never coordinates). */
export type PublishOutcome = 'sent' | 'refused' | 'failed' | 'removed';

export interface LiveLocationPublisherDeps {
  send(update: LiveLocationUpdate): Promise<unknown>;
  remove(): Promise<unknown>;
  now?: () => number;
  /** The server turned sharing off (another device, or it was changed elsewhere). */
  onSharingOff?: () => void;
  log?: (message: string) => void;
}

function metresBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A fix worth sharing, cleaned: unknown (negative) speed and heading become null. */
export function toUpdate(fix: GpsFix, now: number): LiveLocationUpdate | null {
  if (!finite(fix.latitude) || !finite(fix.longitude)) return null;
  if (Math.abs(fix.latitude) > 90 || Math.abs(fix.longitude) > 180) return null;
  if (fix.accuracyM != null && (!finite(fix.accuracyM) || fix.accuracyM < 0 || fix.accuracyM > MAX_ACCURACY_M)) return null;
  if (!finite(fix.timestamp) || now - fix.timestamp > MAX_FIX_AGE_MS) return null;
  const speed = finite(fix.speedMs) && fix.speedMs >= 0 ? fix.speedMs : null;
  const heading = finite(fix.headingDeg) && fix.headingDeg >= 0 ? fix.headingDeg % 360 : null;
  return {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyM: fix.accuracyM ?? null,
    speedMps: speed,
    headingDeg: heading,
    // Never claim a fix is from the future.
    capturedAt: new Date(Math.min(fix.timestamp, now)).toISOString(),
  };
}

export class LiveLocationPublisher {
  private mode: LocationSharingMode = 'off';
  private onScreen = true;
  private driving = false;
  private running = false;
  private lastSentAt = -Infinity;
  private lastSent: { latitude: number; longitude: number } | null = null;
  private holdUntil = -Infinity;
  private inFlight = false;
  private pending: { update: LiveLocationUpdate; fromDrive: boolean } | null = null;
  /** Whether the server may currently hold a position from us. */
  private published = false;

  constructor(private readonly deps: LiveLocationPublisherDeps) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }

  get sharingMode() { return this.mode; }

  start(state: { mode: LocationSharingMode; onScreen: boolean; driving: boolean }): void {
    this.running = true;
    this.mode = state.mode;
    this.onScreen = state.onScreen;
    this.driving = state.driving;
  }

  /** The user changed WHEN (the server already removed the position if it was turned off). */
  setMode(mode: LocationSharingMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.holdUntil = -Infinity;
    this.lastSentAt = -Infinity;
    if (mode === 'off') { this.published = false; this.pending = null; }
  }

  setOnScreen(onScreen: boolean): void {
    if (onScreen === this.onScreen) return;
    this.onScreen = onScreen;
    // Leaving the screen outside a drive ends "while using" sharing at once
    // (the server also removes it when presence reports the background).
    if (!onScreen && !this.driving) this.withdraw('background');
    if (onScreen) this.lastSentAt = -Infinity;
  }

  setDriving(driving: boolean): void {
    if (driving === this.driving) return;
    this.driving = driving;
    this.holdUntil = -Infinity;
    this.lastSentAt = -Infinity;
    if (!driving && (this.mode === 'while_driving' || !this.onScreen)) this.withdraw('drive ended');
  }

  /** A fix the drive accepted (screen or background). */
  noteDriveFix(fix: GpsFix): void {
    if (!this.running || !this.driving || this.mode === 'off') return;
    this.consider(fix, true);
  }

  /** A fix from the Drive screen's foreground stream, outside a drive. */
  noteForegroundFix(fix: GpsFix): void {
    if (!this.running || this.driving || this.mode !== 'while_using' || !this.onScreen) return;
    this.consider(fix, false);
  }

  /** Stops for good; removes the position (best effort) if one may be showing. */
  async stop(): Promise<void> {
    const had = this.running && this.published;
    this.running = false;
    this.pending = null;
    if (had) {
      this.published = false;
      await this.deps.remove().catch(() => {});
    }
  }

  private due(update: LiveLocationUpdate, fromDrive: boolean, now: number): boolean {
    if (now < this.holdUntil) return false;
    const elapsed = now - this.lastSentAt;
    const [min, every, far] = fromDrive
      ? [DRIVE_MIN_INTERVAL_MS, DRIVE_INTERVAL_MS, DRIVE_DISTANCE_M]
      : [USING_MIN_INTERVAL_MS, USING_INTERVAL_MS, USING_DISTANCE_M];
    if (elapsed < min) return false;
    if (elapsed >= every || !this.lastSent) return true;
    return metresBetween(this.lastSent, update) >= far;
  }

  private consider(fix: GpsFix, fromDrive: boolean): void {
    const now = this.now();
    const update = toUpdate(fix, now);
    if (!update || !this.due(update, fromDrive, now)) return;
    if (this.inFlight) {
      // One request at a time; the newest fix goes next.
      this.pending = { update, fromDrive };
      return;
    }
    void this.send(update);
  }

  private async send(update: LiveLocationUpdate): Promise<void> {
    this.inFlight = true;
    this.lastSentAt = this.now();
    try {
      await this.deps.send(update);
      this.lastSent = { latitude: update.latitude, longitude: update.longitude };
      this.published = true;
      this.deps.log?.('sent');
    } catch (err) {
      this.onFailure(err);
    } finally {
      this.inFlight = false;
      const next = this.pending;
      this.pending = null;
      if (next && this.running && this.mode !== 'off' && this.due(next.update, next.fromDrive, this.now())) {
        void this.send(next.update);
      }
    }
  }

  private onFailure(err: unknown) {
    const code = err instanceof ApiError ? err.code : null;
    if (code === 'sharing_off') {
      this.deps.log?.('refused: sharing is off');
      this.setMode('off');
      this.deps.onSharingOff?.();
      return;
    }
    if (code === 'not_driving' || code === 'not_in_use') {
      // Presence hasn't caught up yet (a drive just started), or it no longer applies.
      this.deps.log?.(`refused: ${code}`);
      this.holdUntil = this.now() + REFUSED_BACKOFF_MS;
      return;
    }
    if (code === 'stale_fix' || code === 'invalid_input') {
      this.deps.log?.(`refused: ${code}`);
      return;
    }
    this.deps.log?.(`failed: ${err instanceof ApiError ? `${err.status} ${err.code}` : err instanceof Error ? err.name : 'error'}`);
    this.holdUntil = this.now() + FAILURE_BACKOFF_MS;
  }

  private withdraw(reason: string) {
    this.pending = null;
    if (!this.published) return;
    this.published = false;
    this.deps.log?.(`removed (${reason})`);
    void this.deps.remove().catch(() => {});
  }
}

/**
 * Friends' live positions on the Drive map (Phase 4B): what each marker
 * shows, computed from the positions already shared with this user
 * (LiveLocationStore, Phase 4A) and nothing else.
 *
 * The map is a renderer, not an authorisation layer: it never asks the server
 * for anyone's location. Every marker comes from a shared position the server
 * has already authorised; when that position is revoked or expires, the store
 * drops it and so does the map.
 *
 * No React Native imports, so it is unit-tested under node.
 */
import type { LiveLocation } from './backend/liveLocation';
import { formatSpeed as formatUnitSpeed } from './units';

/** Who a sharer is, from data the app already holds (friends, Convoy members). */
export interface SharerIdentity {
  name: string;
  initials: string;
  avatarUrl?: string | null;
}

export type FriendMarkerMode = 'driving' | 'stationary';

export interface FriendMarkerModel {
  userId: string;
  name: string;
  initials: string;
  avatarUrl: string | null;
  latitude: number;
  longitude: number;
  mode: FriendMarkerMode;
  /** Degrees clockwise from north; only for a driving marker that is moving with a valid heading. */
  headingDeg: number | null;
  speedKmh: number | null;
  /** When the position was recorded (server time, ms). */
  recordedAt: number;
  /** Older than STALE_AFTER_MS: drawn faded, still current until it expires. */
  stale: boolean;
}

/** A position older than this is shown faded (it expires, and is removed, at 3 minutes). */
export const STALE_AFTER_MS = 2 * 60_000;
/** Below this a heading means nothing (GPS course is noise when crawling). */
export const MIN_HEADING_SPEED_KMH = 5;

const UNKNOWN: SharerIdentity = { name: 'Convoy member', initials: '·' };

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}

/** A heading worth drawing, normalised into [0, 360); null when missing, invalid or meaningless. */
export function usableHeading(loc: Pick<LiveLocation, 'driving' | 'headingDeg' | 'speedKmh'>): number | null {
  if (!loc.driving) return null;
  const h = loc.headingDeg;
  if (h == null || !Number.isFinite(h) || h < 0) return null;
  if (loc.speedKmh != null && loc.speedKmh < MIN_HEADING_SPEED_KMH) return null;
  return ((h % 360) + 360) % 360;
}

/**
 * One marker per shared position. The store already holds at most one per
 * person; anything malformed is skipped rather than drawn somewhere wrong.
 */
export function buildMarkerModels(
  locations: readonly LiveLocation[],
  identities: ReadonlyMap<string, SharerIdentity>,
  now: number,
): FriendMarkerModel[] {
  const seen = new Set<string>();
  const out: FriendMarkerModel[] = [];
  for (const loc of locations) {
    if (!loc || seen.has(loc.userId)) continue;
    if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) continue;
    const recordedAt = Date.parse(loc.recordedAt);
    if (Number.isNaN(recordedAt)) continue;
    seen.add(loc.userId);
    const who = identities.get(loc.userId) ?? UNKNOWN;
    const speed = loc.speedKmh != null && Number.isFinite(loc.speedKmh) && loc.speedKmh >= 0 ? loc.speedKmh : null;
    out.push({
      userId: loc.userId,
      name: who.name,
      initials: who.initials || initialsOf(who.name),
      avatarUrl: who.avatarUrl ?? null,
      latitude: loc.latitude,
      longitude: loc.longitude,
      mode: loc.driving ? 'driving' : 'stationary',
      headingDeg: usableHeading(loc),
      speedKmh: speed,
      recordedAt,
      stale: now - recordedAt > STALE_AFTER_MS,
    });
  }
  return out;
}

/** "42 mph" / "68 km/h"; null when the speed is unknown (never a made-up 0). */
export function formatSpeed(speedKmh: number | null, units: 'imperial' | 'metric'): string | null {
  if (speedKmh == null || !Number.isFinite(speedKmh) || speedKmh < 0) return null;
  // The app's one speed conversion (lib/units)
  return formatUnitSpeed(speedKmh, units);
}

/** "Driving · 42 mph", "Driving", or "Stationary". */
export function statusLine(m: Pick<FriendMarkerModel, 'mode' | 'speedKmh'>, units: 'imperial' | 'metric'): string {
  if (m.mode !== 'driving') return 'Stationary';
  const speed = formatSpeed(m.speedKmh, units);
  return speed ? `Driving · ${speed}` : 'Driving';
}

/** "Updated 4s ago" / "Updated 2 min ago" (a phone clock slightly behind never shows the future). */
export function updatedAgo(recordedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - recordedAt) / 1000));
  if (s < 60) return `Updated ${s}s ago`;
  return `Updated ${Math.floor(s / 60)} min ago`;
}

// ─── Movement between updates ────────────────────────────────────────────────

export interface LatLngPoint {
  latitude: number;
  longitude: number;
}

/** Updates arrive about every 10 s while driving: glide over a short, fixed time. */
export const MOVE_TWEEN_MS = 900;
/** A jump this far (a gap in updates, a fresh snapshot) is drawn at once, not glided. */
export const SNAP_DISTANCE_M = 2_000;

function metres(a: LatLngPoint, b: LatLngPoint): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whether to glide from `from` to `to` (false: place it at once). */
export function shouldTween(from: LatLngPoint | null, to: LatLngPoint): boolean {
  if (!from) return false;
  const d = metres(from, to);
  return d > 0.5 && d < SNAP_DISTANCE_M;
}

/** Ease-out position `t` (0–1) of the way from `from` to `to`. */
export function tweenPoint(from: LatLngPoint, to: LatLngPoint, t: number): LatLngPoint {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) ** 3;
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * k,
    longitude: from.longitude + (to.longitude - from.longitude) * k,
  };
}

// ─── Which friend's card is open ─────────────────────────────────────────────

/**
 * The selected marker, outside React state of the Drive screen: opening or
 * updating the card re-renders only the card, never the screen or the map.
 */
export class FriendSelection {
  private selected: string | null = null;
  private listeners = new Set<() => void>();

  get current(): string | null { return this.selected; }

  select(userId: string | null): void {
    if (userId === this.selected) return;
    this.selected = userId;
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

/** The Drive map's selection (one map, one card). */
export const friendMapSelection = new FriendSelection();

/** Whether two models draw the same marker (so a rebuilt list doesn't redraw unchanged ones). */
export function sameMarker(a: FriendMarkerModel, b: FriendMarkerModel): boolean {
  return a.userId === b.userId && a.latitude === b.latitude && a.longitude === b.longitude
    && a.mode === b.mode && a.headingDeg === b.headingDeg && a.stale === b.stale
    && a.name === b.name && a.initials === b.initials && a.avatarUrl === b.avatarUrl;
}

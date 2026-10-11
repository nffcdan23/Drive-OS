// Upcoming hazard warnings during navigation: which reported hazard, if any,
// the driver is genuinely approaching on their route, and how far ahead.
//
// Conservative by design: a wrong warning while driving is worse than a
// missed one. A hazard warns only when all of these hold:
//
//  - it lies on the route: within a narrow corridor of the route line, which
//    is wider on the driver's own side (30 m) than towards oncoming traffic
//    (15 m). On a dual carriageway or motorway the route line follows the
//    driver's own carriageway, so a report from the opposite one usually
//    falls outside; on a single carriageway both lanes are inside;
//  - it is ahead by route progress (metres along the route, never straight-
//    line distance), and within a warning distance that grows with speed and
//    road class (HAZARD_WARNING.bands), with hysteresis so it doesn't flicker;
//  - guidance is sure where the car is: navigating (not off route or
//    rerouting), GPS good, a recent fix accurate to 30 m, and (when moving)
//    the car heading the way the route goes there.
//
// Hazards carry no direction of travel (reports store only a position), so
// a report from the opposite carriageway close to the route, or from a road
// crossing over or under it right at the crossing, can still match. That is
// a known limitation, not something this pretends to know.
//
// Matching a hazard to the route is done once per route (and once per new
// hazard): the prepared route's segments are grouped into chunks with
// bounding boxes, so only the few segments near a hazard are examined. Each
// GPS fix then only compares positions along the route.
//
// Once passed (progress beyond it), a hazard never warns again in this
// navigation, whatever GPS jitter or a reroute does. Nothing here is stored;
// nothing changes a hazard record.
//
// No React Native imports, so it is unit-tested under node.

import { turnDeg } from '../backend/geo';
import { segmentAt, type PreparedRoute, type RouteProgress } from '../navigation/routeProgress';
import type { GpsStatus, NavPhase } from '../navigation/session';
import { msToKmh } from '../units';
import type { RoadHazard } from './model';

export const HAZARD_WARNING = {
  /** Corridor either side of the route line (m): the driver's own side, and towards oncoming traffic */
  corridorNearSideM: 30,
  corridorFarSideM: 15,
  /** Matches closer than this along the route (m) are the same stretch (one pass of the route) */
  sameStretchM: 100,
  /**
   * How far ahead a hazard starts warning (m), by band. A band applies from
   * the driver's speed (up to `upToKmh`) or from the road (motorway refs; A
   * roads at least `road`), whichever is higher.
   */
  bands: [
    { name: 'urban', upToKmh: 55, warnM: 400 },
    { name: 'road', upToKmh: 95, warnM: 900 },
    { name: 'motorway', upToKmh: Infinity, warnM: 1_600 },
  ],
  /** A band drops only once speed is this far below its start, for this long */
  bandDropKmh: 10,
  bandDropAfterMs: 20_000,
  /** Progress this far past a hazard (m) means passed */
  passedAfterM: 25,
  /** Confidence: fixes no less accurate than this (m), no older than this (ms) */
  maxAccuracyM: 30,
  maxFixAgeMs: 10_000,
  /** Moving at least this fast (m/s), the car must head within this of the route's direction */
  headingCheckMinSpeedMs: 5,
  maxHeadingDiffDeg: 60,
  /** Hazards this close to the nearest one (m) are ranked by severity instead */
  tieWithinM: 50,
  /** Segments per chunk of the route index */
  chunk: 32,
} as const;

/** Most severe first (only a tie-breaker between hazards at about the same distance) */
const SEVERITY: Record<string, number> = { accident: 0, hazard: 1, broken_down: 2, flooding: 3, roadworks: 4, police: 5 };
const severityOf = (kind: string) => SEVERITY[kind] ?? 1;

/** The warning the driver sees (and that voice could use later): one at a time */
export interface HazardWarning {
  hazardId: string;
  kind: string;
  /** Along the route from the car to the hazard (m), never below 0 */
  distanceAheadM: number;
  /** Where the hazard is along the route (m) */
  routeAlongM: number;
  /** Severity rank (0 most severe) */
  priority: number;
}

export type HazardWarningEvent = 'active' | 'passed' | 'removed' | 'rerouted';

/** Distance buckets for diagnostics (never an exact distance or a place) */
export function distanceBucket(m: number): string {
  if (m < 250) return '<250m';
  if (m < 500) return '250-500m';
  if (m < 1_000) return '500m-1km';
  if (m < 2_000) return '1-2km';
  return '>2km';
}

// ─── Matching a hazard to the route ──────────────────────────────────────────

const M_PER_DEG = (6_371_000 * Math.PI) / 180;
const D2R = Math.PI / 180;

interface RouteIndex {
  minLat: Float64Array;
  maxLat: Float64Array;
  minLng: Float64Array;
  maxLng: Float64Array;
}
const indexes = new WeakMap<PreparedRoute, RouteIndex>();

/** Bounding boxes of the route's segments, HAZARD_WARNING.chunk at a time (built once per route) */
function routeIndex(p: PreparedRoute): RouteIndex {
  const cached = indexes.get(p);
  if (cached) return cached;
  const segs = p.n - 1;
  const chunks = Math.ceil(segs / HAZARD_WARNING.chunk);
  const idx: RouteIndex = {
    minLat: new Float64Array(chunks).fill(Infinity), maxLat: new Float64Array(chunks).fill(-Infinity),
    minLng: new Float64Array(chunks).fill(Infinity), maxLng: new Float64Array(chunks).fill(-Infinity),
  };
  for (let i = 0; i < p.n; i++) {
    // Point i ends segment i-1 and starts segment i
    for (const s of [i - 1, i]) {
      if (s < 0 || s >= segs) continue;
      const c = Math.floor(s / HAZARD_WARNING.chunk);
      idx.minLat[c] = Math.min(idx.minLat[c]!, p.lat[i]!);
      idx.maxLat[c] = Math.max(idx.maxLat[c]!, p.lat[i]!);
      idx.minLng[c] = Math.min(idx.minLng[c]!, p.lng[i]!);
      idx.maxLng[c] = Math.max(idx.maxLng[c]!, p.lng[i]!);
    }
  }
  indexes.set(p, idx);
  return idx;
}

/** The driving side at `along` (from the manoeuvre whose step it's in) */
function drivingSideAt(p: PreparedRoute, along: number): 'left' | 'right' {
  let lo = 0;
  let hi = p.steps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.stepStart[mid]! <= along) lo = mid;
    else hi = mid - 1;
  }
  return p.maneuvers[lo]?.drivingSide ?? 'left';
}

/** Segments examined by the last matchToRoute (for tests) */
export let lastMatchScan = 0;

/**
 * Where a position lies on the route: the distance along it (m) of each
 * stretch of the route it is within the corridor of, nearest point per
 * stretch, in route order. Empty when it isn't on the route.
 */
export function matchToRoute(p: PreparedRoute, latitude: number, longitude: number): number[] {
  const idx = routeIndex(p);
  const W = HAZARD_WARNING;
  const marginLat = W.corridorNearSideM / M_PER_DEG;
  const marginLng = W.corridorNearSideM / (M_PER_DEG * Math.max(Math.cos(latitude * D2R), 0.1));
  const hits: Array<{ along: number; lateral: number }> = [];
  lastMatchScan = 0;
  for (let c = 0; c < idx.minLat.length; c++) {
    if (latitude < idx.minLat[c]! - marginLat || latitude > idx.maxLat[c]! + marginLat
      || longitude < idx.minLng[c]! - marginLng || longitude > idx.maxLng[c]! + marginLng) continue;
    const end = Math.min((c + 1) * W.chunk, p.n - 1);
    for (let i = c * W.chunk; i < end; i++) {
      lastMatchScan++;
      // The same flat projection the route tracker uses
      const cs = p.segCos[i]!;
      const px = (longitude - p.lng[i]!) * cs * M_PER_DEG;
      const py = (latitude - p.lat[i]!) * M_PER_DEG;
      const dx = p.segDx[i]!;
      const dy = p.segDy[i]!;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const lateral = Math.hypot(px - t * dx, py - t * dy);
      if (lateral > W.corridorNearSideM) continue;
      const along = p.cum[i]! + t * p.segLen[i]!;
      // Which side of the direction of travel: left when the cross product is positive
      const left = dx * py - dy * px > 0;
      const nearSide = drivingSideAt(p, along) === 'left' ? left : !left;
      if (lateral > (nearSide ? W.corridorNearSideM : W.corridorFarSideM)) continue;
      hits.push({ along, lateral });
    }
  }
  hits.sort((a, b) => a.along - b.along);
  // One per stretch of the route (a route can pass the same place twice)
  const out: number[] = [];
  let best: { along: number; lateral: number } | null = null;
  let lastAlong = -Infinity;
  for (const h of hits) {
    if (best && h.along - lastAlong > W.sameStretchM) {
      out.push(best.along);
      best = null;
    }
    if (!best || h.lateral < best.lateral) best = h;
    lastAlong = h.along;
  }
  if (best) out.push(best.along);
  return out;
}

// ─── Warning distance ────────────────────────────────────────────────────────

const MOTORWAY_REF = /^M\d|\(M\)$/i;
const A_ROAD_REF = /^A\d/i;

/** The band a road's number calls for at least (motorway 2, A road 1, else 0) */
export function roadBand(roadRef: string | null | undefined): number {
  if (!roadRef) return 0;
  const refs = roadRef.split(/[;/,]\s*/);
  if (refs.some((r) => MOTORWAY_REF.test(r.trim()))) return 2;
  if (refs.some((r) => A_ROAD_REF.test(r.trim()))) return 1;
  return 0;
}

/** The band a speed calls for, given the band now (dropping needs speed well below the band's start) */
export function speedBand(kmh: number, current: number): number {
  const bands = HAZARD_WARNING.bands;
  let b = bands.findIndex((x) => kmh <= x.upToKmh);
  if (b < 0) b = bands.length - 1;
  if (b < current) {
    const start = bands[current - 1]!.upToKmh;
    if (kmh > start - HAZARD_WARNING.bandDropKmh) return current;
  }
  return b;
}

export const warnDistanceM = (band: number) => HAZARD_WARNING.bands[Math.min(Math.max(band, 0), HAZARD_WARNING.bands.length - 1)]!.warnM;

// ─── The tracker ─────────────────────────────────────────────────────────────

export interface HazardWarningInput {
  /** The navigation session (a new one starts over); null when not navigating */
  sessionId: number | null;
  phase: NavPhase;
  gps: GpsStatus | null;
  /** The prepared route being followed, and progress along it */
  prepared: PreparedRoute | null;
  progress: RouteProgress | null;
  /** The newest raw fix */
  fix: { speedMs: number | null; headingDeg?: number | null; accuracyM?: number | null; timestamp: number } | null;
  /** Hazards near the driver (the hazard store's list) */
  hazards: readonly RoadHazard[];
  now: number;
}

export interface HazardWarningsDeps {
  /** Diagnostics: the event, the hazard kind and a distance bucket only */
  log?: (event: HazardWarningEvent, data: { kind: string; distance: string }) => void;
}

export class HazardWarnings {
  private sessionId: number | null = null;
  private matchedFor: PreparedRoute | null = null;
  /** Hazard id → where it is along the current route (one entry per stretch); empty: not on it */
  private matches = new Map<string, number[]>();
  /** Passed in this navigation: never again */
  private passed = new Set<string>();
  /** Warned in this navigation (logged once) */
  private announced = new Set<string>();
  private band = 0;
  private lowerSince: number | null = null;
  private current: HazardWarning | null = null;
  /** The last warning shown and not yet passed, removed or rerouted away (for diagnostics) */
  private shown: HazardWarning | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: HazardWarningsDeps = {}) {}

  get warning(): HazardWarning | null {
    return this.current;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Recomputes from the latest navigation state, fix and hazards */
  update(input: HazardWarningInput): HazardWarning | null {
    const W = HAZARD_WARNING;
    if (input.sessionId !== this.sessionId) {
      // A new navigation (or none): nothing carries over
      this.sessionId = input.sessionId;
      this.matchedFor = null;
      this.matches.clear();
      this.passed.clear();
      this.announced.clear();
      this.band = 0;
      this.lowerSince = null;
      this.shown = null;
      if (input.sessionId == null) return this.publish(null);
    }
    const p = input.prepared;
    let rerouted = false;
    if (p !== this.matchedFor) {
      // A new route (a reroute): every hazard is matched against it afresh
      rerouted = this.matchedFor != null && p != null;
      this.matchedFor = p;
      this.matches.clear();
    }
    const live = input.hazards.filter((h) => h.expiresAt > input.now);
    const liveIds = new Set(live.map((h) => h.id));
    for (const id of [...this.matches.keys()]) if (!liveIds.has(id)) this.matches.delete(id);
    if (p) for (const h of live) if (!this.matches.has(h.id)) this.matches.set(h.id, matchToRoute(p, h.latitude, h.longitude));

    const progress = input.progress;
    if (!p || !progress || input.phase === 'idle') return this.finish(null, liveIds, rerouted);

    // Passed: progress beyond every stretch of the route it's on
    const ahead = new Map<string, number>();
    for (const h of live) {
      const at = this.matches.get(h.id);
      if (!at?.length || this.passed.has(h.id)) continue;
      const next = at.find((a) => a >= progress.along - W.passedAfterM);
      if (next == null) this.passed.add(h.id);
      else ahead.set(h.id, next);
    }

    // Confidence: otherwise no warning at all (it may come back)
    const fix = input.fix;
    const confident = input.phase === 'navigating' && input.gps === 'ok' && fix != null
      && input.now - fix.timestamp <= W.maxFixAgeMs
      && (fix.accuracyM == null || (fix.accuracyM >= 0 && fix.accuracyM <= W.maxAccuracyM))
      && this.headingAgrees(p, progress, fix);
    if (fix && confident) this.updateBand(p, progress, fix.speedMs, input.now);

    let next: HazardWarning | null = null;
    if (confident) {
      const reach = warnDistanceM(this.band);
      const candidates = live
        .filter((h) => ahead.has(h.id))
        .map((h) => ({ h, distance: ahead.get(h.id)! - progress.along }))
        // An active warning stays until passed, even if the band shrinks
        .filter((c) => c.distance <= reach || c.h.id === this.current?.hazardId)
        .sort((a, b) => a.distance - b.distance);
      if (candidates.length) {
        const nearest = candidates[0]!.distance;
        const pick = candidates
          .filter((c) => c.distance - nearest <= W.tieWithinM)
          .sort((a, b) => severityOf(a.h.kind) - severityOf(b.h.kind) || a.distance - b.distance)[0]!;
        next = {
          hazardId: pick.h.id,
          kind: pick.h.kind,
          distanceAheadM: Math.max(0, Math.round(pick.distance)),
          routeAlongM: Math.round(ahead.get(pick.h.id)!),
          priority: severityOf(pick.h.kind),
        };
      }
    }

    return this.finish(next, liveIds, rerouted);
  }

  /**
   * Logs what became of the last warning shown (passed, removed, or off the
   * new route), even if it was hidden meanwhile (off route, poor GPS), and a
   * new warning the first time it shows; then publishes.
   */
  private finish(next: HazardWarning | null, liveIds: ReadonlySet<string>, rerouted: boolean): HazardWarning | null {
    const shown = this.shown;
    if (shown) {
      const event: HazardWarningEvent | null =
        this.passed.has(shown.hazardId) ? 'passed'
          : !liveIds.has(shown.hazardId) ? 'removed'
            : rerouted && !this.matches.get(shown.hazardId)?.length ? 'rerouted'
              : null;
      if (event) {
        this.deps.log?.(event, { kind: shown.kind, distance: distanceBucket(shown.distanceAheadM) });
        this.shown = null;
      }
    }
    if (next) {
      if (!this.announced.has(next.hazardId)) {
        this.announced.add(next.hazardId);
        this.deps.log?.('active', { kind: next.kind, distance: distanceBucket(next.distanceAheadM) });
      }
      this.shown = next;
    }
    return this.publish(next);
  }

  private headingAgrees(p: PreparedRoute, progress: RouteProgress, fix: NonNullable<HazardWarningInput['fix']>): boolean {
    const W = HAZARD_WARNING;
    if (fix.speedMs == null || fix.speedMs < W.headingCheckMinSpeedMs) return true;
    if (fix.headingDeg == null || fix.headingDeg < 0) return true;
    return turnDeg(fix.headingDeg, p.segBearing[segmentAt(p, progress.along)]!) <= W.maxHeadingDiffDeg;
  }

  private updateBand(p: PreparedRoute, progress: RouteProgress, speedMs: number | null, now: number) {
    const kmh = speedMs != null && speedMs >= 0 ? msToKmh(speedMs) : 0;
    const road = roadBand(p.steps[progress.stepIndex]?.roadRef);
    const target = Math.max(speedBand(kmh, this.band), road);
    if (target > this.band) {
      this.band = target;
      this.lowerSince = null;
    } else if (target < this.band) {
      this.lowerSince ??= now;
      if (now - this.lowerSince >= HAZARD_WARNING.bandDropAfterMs) {
        this.band = target;
        this.lowerSince = null;
      }
    } else {
      this.lowerSince = null;
    }
  }

  private publish(next: HazardWarning | null): HazardWarning | null {
    const prev = this.current;
    // Listeners hear of a new hazard, or a distance change of 10 m or more
    const same = prev === next || (prev && next && prev.hazardId === next.hazardId
      && Math.round(prev.distanceAheadM / 10) === Math.round(next.distanceAheadM / 10));
    if (same) return prev;
    this.current = next;
    for (const fn of [...this.listeners]) fn();
    return next;
  }
}

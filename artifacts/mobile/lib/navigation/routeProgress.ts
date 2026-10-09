// Route progress (Navigation Phase 3): where along the route the car is, from
// GPS fixes, and so which step it's on, how far to the next manoeuvre, and
// what's left of the journey.
//
// The route is prepared once (and again only on a new route): cumulative
// distance at every point, each segment's length, bearing and metric offset,
// each step's start located on the line, and the remaining duration after
// each step. A fix is then matched against only the stretch of route near
// the last known progress, never the whole line:
//
//  - candidates are the segments within a window around the expected
//    position (behind a little, ahead by what the car could have covered);
//  - each is scored on how far the fix is from it, how far its direction
//    disagrees with the car's course (when moving), and how far it would
//    move progress from where it should be. So a fix near a junction, a
//    hairpin or a road that runs back alongside the route stays on the part
//    of the route the car is actually following;
//  - progress only moves forwards; a few metres backwards is GPS noise and
//    is held, and a real jump back is accepted only after repeated fixes;
//  - a step counts as done only once the car is past its manoeuvre, so
//    going straight on past a turn never advances the instructions.
//
// After a gap in fixes (the app was away, or GPS dropped out), or when the
// car first starts, the search widens. A fix that's too poor (accuracy) is
// not used at all: guidance never advances on a guess.
//
// The matched (snapped) position is for guidance only: the map's arrow,
// drive recording and location sharing keep using the raw position.
//
// No React Native imports, so it is unit-tested under node.

import { distanceM, bearingDeg, turnDeg } from '../backend/geo';
import type { LatLng, NavRoute, RouteStep } from './model';
import { isRoundabout, maneuversFor, roadLabel, type Maneuver } from './maneuver';

const R = 6_371_000;
const M_PER_DEG = (R * Math.PI) / 180;
const D2R = Math.PI / 180;

export const PROGRESS = {
  /** Past a manoeuvre by this much (m) before its step begins */
  advanceM: 3,
  /** Backwards movement this small (m) is noise: progress holds */
  holdBackM: 25,
  /** ...a bigger jump back is believed after this many fixes in a row */
  backConfirmFixes: 3,
  /** A manoeuvre this soon after the next one (m) is shown as "then" */
  thenWithinM: 150,
  /** No fix for this long (ms): the next one is searched for more widely */
  relocalizeAfterMs: 15_000,
  /** Fixes less accurate than this (m) are not used (as off-route detection) */
  maxUsableAccuracyM: 50,
  /** One fix moves progress forwards at most what the car could have covered (and this) */
  minAdvanceM: 15,
  /** A match farther than this (m) from the line is checked against a wider stretch */
  rematchLateralM: 30,
  /** The search window around the expected position (m) */
  windowBackM: 60,
  windowAheadMinM: 80,
  windowAheadMaxM: 2_500,
  /** Wider, after a gap or while off the route (m) */
  wideBackM: 300,
  wideAheadM: 4_000,
  /** Heading is only trusted above this speed (m/s, ~11 km/h) */
  headingMinSpeedMs: 3,
  headingFreeDeg: 35,
  headingPenaltyPerDeg: 0.6,
  headingPenaltyMaxM: 60,
  /** Cost of each metre a candidate would move progress from where it should be */
  continuityPerM: 0.15,
  /** ...and of each metre it would move it backwards (beyond holdBackM) */
  backwardsPerM: 0.6,
  /** A step's manoeuvre point must be this close (m) to a route point to be placed there */
  stepMatchM: 20,
  /** Roundabouts: how far after entering (m) the exit can be */
  roundaboutMaxM: 400,
} as const;

export interface GpsFix {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy (m), when known */
  accuracyM: number | null;
  speedMs: number | null;
  /** Course over ground (degrees), when known */
  headingDeg: number | null;
  /** When it was taken (ms) */
  time: number;
}

export interface PreparedRoute {
  route: NavRoute;
  /** Route points */
  n: number;
  lat: Float64Array;
  lng: Float64Array;
  /** Distance along the route to each point (m) */
  cum: Float64Array;
  /** Per segment (point i to i+1): length (m), bearing, metric offset and the scale at its start */
  segLen: Float64Array;
  segBearing: Float64Array;
  segDx: Float64Array;
  segDy: Float64Array;
  segCos: Float64Array;
  total: number;
  /** Every step of every leg, in order */
  steps: RouteStep[];
  maneuvers: Maneuver[];
  /** Where each step's manoeuvre is, along the route (m) */
  stepStart: Float64Array;
  stepDuration: Float64Array;
  /** Duration of all the steps after each one (s) */
  durationAfter: Float64Array;
  /** Roundabouts: where the exit is (m along); otherwise the step start */
  holdUntil: Float64Array;
}

export class UnusableRouteError extends Error {}

const stepsOf = (route: NavRoute) => route.legs.flatMap((l) => l.steps);

/**
 * Everything the tracker needs, computed once per route. Throws
 * UnusableRouteError for a route that can't be followed (no line or steps).
 */
export function prepareRoute(route: NavRoute): PreparedRoute {
  // Repeated points add nothing but zero-length segments
  const pts: LatLng[] = [];
  for (const p of route.geometry) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    const last = pts[pts.length - 1];
    if (!last || last.latitude !== p.latitude || last.longitude !== p.longitude) pts.push(p);
  }
  const steps = stepsOf(route);
  if (pts.length < 2 || steps.length < 2) throw new UnusableRouteError('This route has no turn-by-turn directions.');
  const n = pts.length;
  const lat = new Float64Array(n);
  const lng = new Float64Array(n);
  const cum = new Float64Array(n);
  const segLen = new Float64Array(n - 1);
  const segBearing = new Float64Array(n - 1);
  const segDx = new Float64Array(n - 1);
  const segDy = new Float64Array(n - 1);
  const segCos = new Float64Array(n - 1);
  for (let i = 0; i < n; i++) {
    lat[i] = pts[i]!.latitude;
    lng[i] = pts[i]!.longitude;
  }
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = distanceM(a, b);
    segLen[i] = len;
    segBearing[i] = bearingDeg(a, b);
    const c = Math.cos(a.latitude * D2R);
    segCos[i] = c;
    segDx[i] = (b.longitude - a.longitude) * c * M_PER_DEG;
    segDy[i] = (b.latitude - a.latitude) * M_PER_DEG;
    cum[i + 1] = cum[i]! + len;
  }
  const total = cum[n - 1]!;

  // Each step starts where its manoeuvre is. Mapbox's manoeuvre points are
  // points of the full route line; each is looked for near where the steps'
  // own distances put it, moving only forwards.
  const stepStart = new Float64Array(steps.length);
  const reported = steps.reduce((sum, s) => sum + (Number.isFinite(s.distanceM) ? s.distanceM : 0), 0);
  const scale = reported > 0 ? total / reported : 1;
  let fromVertex = 0;
  let expected = 0;
  for (let k = 0; k < steps.length; k++) {
    if (k > 0) expected += Math.max(0, steps[k - 1]!.distanceM) * scale;
    if (k === 0) {
      stepStart[0] = 0;
      continue;
    }
    const loc = steps[k]!.maneuver.location;
    const slack = 100 + 0.02 * expected;
    let best = -1;
    let bestD = Infinity;
    for (let i = fromVertex; i < n; i++) {
      if (cum[i]! > expected + slack) break;
      if (cum[i]! < expected - slack) continue;
      const d = distanceM(pts[i]!, loc);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let at: number;
    if (best >= 0 && bestD <= PROGRESS.stepMatchM) {
      at = cum[best]!;
      fromVertex = best;
    } else {
      at = Math.min(Math.max(expected, stepStart[k - 1]!), total);
    }
    stepStart[k] = Math.max(at, stepStart[k - 1]!);
  }
  // The last step (arrive) is the end of the line
  if (steps[steps.length - 1]!.maneuver.type === 'arrive') stepStart[steps.length - 1] = total;

  const stepDuration = new Float64Array(steps.length);
  const durationAfter = new Float64Array(steps.length);
  for (let k = 0; k < steps.length; k++) stepDuration[k] = Math.max(0, steps[k]!.durationS || 0);
  for (let k = steps.length - 2; k >= 0; k--) durationAfter[k] = durationAfter[k + 1]! + stepDuration[k + 1]!;

  const maneuvers = maneuversFor(steps);
  const prepared: PreparedRoute = {
    route, n, lat, lng, cum, segLen, segBearing, segDx, segDy, segCos, total,
    steps, maneuvers, stepStart, stepDuration, durationAfter,
    holdUntil: new Float64Array(stepStart),
  };
  for (let k = 0; k < steps.length; k++) {
    if (isRoundabout(maneuvers[k]!.kind)) prepared.holdUntil[k] = roundaboutExitAlong(prepared, k);
  }
  return prepared;
}

/** The segment the route is on at `along` (m): the last one starting at or before it */
export function segmentAt(p: PreparedRoute, along: number): number {
  let lo = 0;
  let hi = p.n - 2;
  if (along <= 0) return 0;
  if (along >= p.cum[hi]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.cum[mid]! <= along) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The point `along` metres into the route */
export function pointAt(p: PreparedRoute, along: number): LatLng {
  const i = segmentAt(p, along);
  const len = p.segLen[i]!;
  const t = len > 0 ? Math.min(Math.max((along - p.cum[i]!) / len, 0), 1) : 0;
  return {
    latitude: p.lat[i]! + (p.lat[i + 1]! - p.lat[i]!) * t,
    longitude: p.lng[i]! + (p.lng[i + 1]! - p.lng[i]!) * t,
  };
}

const vertexAt = (p: PreparedRoute, along: number) => {
  // The first point at or after `along`
  const i = segmentAt(p, along);
  return p.cum[i]! >= along ? i : Math.min(i + 1, p.n - 1);
};

/**
 * Where a roundabout's exit is, along the route: the car circulates
 * (clockwise where traffic drives on the left, so turning right) from the
 * entry, and the exit is where that circulating turn peaks before the route
 * straightens or bends away. Without a clear circulation (a mini
 * roundabout), there's nothing to hold: the step start.
 */
function roundaboutExitAlong(p: PreparedRoute, k: number): number {
  const start = p.stepStart[k]!;
  const end = k + 1 < p.steps.length ? p.stepStart[k + 1]! : p.total;
  const sign = p.maneuvers[k]!.drivingSide === 'right' ? -1 : 1;
  const v0 = vertexAt(p, start);
  let cumTurn = 0;
  let best = 0;
  let bestAlong = start;
  for (let v = v0 + 1; v < p.n - 1; v++) {
    if (p.cum[v]! > end || p.cum[v]! - start > PROGRESS.roundaboutMaxM) break;
    let turn = p.segBearing[v]! - p.segBearing[v - 1]!;
    turn = ((turn + 540) % 360) - 180;
    cumTurn += turn * sign;
    if (cumTurn > best) {
      best = cumTurn;
      bestAlong = p.cum[v]!;
    }
    if (best - cumTurn > 45) break;
  }
  return best >= 30 ? Math.min(bestAlong, end) : start;
}

export interface RouteMatch {
  /** Distance along the route of the matched point (m) */
  along: number;
  /** How far the fix is from the route there (m) */
  lateralM: number;
  segment: number;
  /** The route's direction there */
  bearing: number;
  /** How far the car's course is from it, when the course is usable */
  headingDiff: number | null;
}

export interface RouteProgress {
  /** Distance along the route (m) */
  along: number;
  /** The route position the car is matched to (for guidance only) */
  snapped: LatLng;
  /** The step the car is on */
  stepIndex: number;
  /** The manoeuvre coming up (on a roundabout: the roundabout itself until its exit) */
  next: Maneuver;
  distanceToNextM: number;
  /** True while circulating a roundabout, before its exit */
  onRoundabout: boolean;
  /** A manoeuvre straight after the next one */
  then: Maneuver | null;
  distanceRemainingM: number;
  durationRemainingS: number;
  /** The road the car is on, e.g. "A591 Lake Road" */
  currentRoad: string | null;
}

/** Progress at `along` metres into the route */
export function progressAt(p: PreparedRoute, along: number): RouteProgress {
  const a = Math.min(Math.max(along, 0), p.total);
  const last = p.steps.length - 1;
  // The step whose manoeuvre is (just) behind the car
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.stepStart[mid]! + PROGRESS.advanceM < a) lo = mid;
    else hi = mid - 1;
  }
  const k = lo;
  const holding = isRoundabout(p.maneuvers[k]!.kind) && k > 0 && a < p.holdUntil[k]!;
  const m = holding ? k : Math.min(k + 1, last);
  const nextAt = holding ? p.holdUntil[k]! : p.stepStart[m]!;
  const after = m + 1 <= last ? p.stepStart[m + 1]! - nextAt : Infinity;
  const stepEnd = k + 1 <= last ? p.stepStart[k + 1]! : p.total;
  const stepLen = stepEnd - p.stepStart[k]!;
  const frac = stepLen > 0 ? Math.min(Math.max((stepEnd - a) / stepLen, 0), 1) : 0;
  return {
    along: a,
    snapped: pointAt(p, a),
    stepIndex: k,
    next: p.maneuvers[m]!,
    distanceToNextM: Math.max(0, nextAt - a),
    onRoundabout: holding,
    then: m < last && after <= PROGRESS.thenWithinM ? p.maneuvers[m + 1]! : null,
    distanceRemainingM: Math.max(0, p.total - a),
    durationRemainingS: p.stepDuration[k]! * frac + p.durationAfter[k]!,
    currentRoad: roadLabel(p.steps[k]!),
  };
}

/**
 * Follows one route through GPS fixes. Holds only the matched progress and
 * the last fix; the prepared route never changes.
 */
export class RouteTracker {
  private along = 0;
  private located = false;
  private lastFix: GpsFix | null = null;
  private backwards = 0;
  /** Segments examined by the last update (for tests and diagnostics) */
  lastScan = 0;

  constructor(readonly route: PreparedRoute) {}

  get progress(): RouteProgress | null {
    return this.located ? progressAt(this.route, this.along) : null;
  }

  get isLocated(): boolean {
    return this.located;
  }

  /** The next fix is searched for widely (after the app was away, or after leaving the route) */
  widen(): void {
    this.lastFix = this.lastFix ? { ...this.lastFix, time: -Infinity } : null;
  }

  /**
   * The best match for `fix` on the route, without moving progress. `wide`
   * searches a larger stretch (off route, rejoining). A match that looks off
   * the line is checked against a wider stretch too, so a car that's really
   * on the route, just not where progress expected, is found there.
   */
  match(fix: GpsFix, wide = false): RouteMatch | null {
    const p = this.route;
    const prev = this.lastFix;
    const dtMs = prev ? fix.time - prev.time : Infinity;
    const speed = Math.max(0, fix.speedMs ?? 0);
    this.lastScan = 0;
    if (!this.located) return this.scan(fix, 0, p.total, dtMs);
    const wideRange = (): [number, number] => {
      const gapS = Number.isFinite(dtMs) ? dtMs / 1000 : 120;
      return [this.along - PROGRESS.wideBackM, this.along + Math.max(PROGRESS.wideAheadM, Math.min(gapS, 600) * 45)];
    };
    if (wide || !(dtMs <= PROGRESS.relocalizeAfterMs)) return this.scan(fix, ...wideRange(), dtMs);
    const dt = Math.max(dtMs, 0) / 1000;
    const best = this.scan(
      fix,
      this.along - PROGRESS.windowBackM,
      this.along + Math.min(Math.max(PROGRESS.windowAheadMinM, speed * dt * 2 + 50 + (fix.accuracyM ?? 20)), PROGRESS.windowAheadMaxM),
      dtMs,
    );
    if (best && best.lateralM > PROGRESS.rematchLateralM) {
      // Judged on the line and the heading only: where progress expected
      // the car is exactly what's in doubt
      const alt = this.scan(fix, ...wideRange(), dtMs, true);
      if (alt && alt.lateralM + 10 < best.lateralM) return alt;
    }
    return best;
  }

  private scan(fix: GpsFix, from: number, to: number, dtMs: number, free = false): RouteMatch | null {
    const p = this.route;
    const speed = Math.max(0, fix.speedMs ?? 0);
    const usableHeading =
      fix.headingDeg != null && fix.headingDeg >= 0 && speed >= PROGRESS.headingMinSpeedMs
      && (fix.accuracyM == null || fix.accuracyM <= 30);
    const expected = this.located ? this.along + speed * Math.min(Number.isFinite(dtMs) ? dtMs / 1000 : 0, 60) : 0;
    // Continuity counts for less the longer it's been since the last fix
    const continuity = this.located
      ? PROGRESS.continuityPerM * Math.min(Math.max(2000 / Math.max(dtMs, 1), 0.05), 1)
      : 0.002;

    let best: RouteMatch | null = null;
    let bestCost = Infinity;
    let scanned = 0;
    const flat = fix.latitude;
    const flng = fix.longitude;
    for (let i = segmentAt(p, Math.max(from, 0)); i < p.n - 1; i++) {
      if (p.cum[i]! > to) break;
      scanned++;
      const c = p.segCos[i]!;
      const px = (flng - p.lng[i]!) * c * M_PER_DEG;
      const py = (flat - p.lat[i]!) * M_PER_DEG;
      const dx = p.segDx[i]!;
      const dy = p.segDy[i]!;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const lateral = Math.hypot(px - t * dx, py - t * dy);
      const along = p.cum[i]! + t * p.segLen[i]!;
      let cost = lateral;
      let headingDiff: number | null = null;
      if (usableHeading) {
        headingDiff = turnDeg(fix.headingDeg!, p.segBearing[i]!);
        if (headingDiff > PROGRESS.headingFreeDeg) {
          const pen = Math.min((headingDiff - PROGRESS.headingFreeDeg) * PROGRESS.headingPenaltyPerDeg, PROGRESS.headingPenaltyMaxM);
          // At a corner the course is between the two directions: half weight
          cost += t <= 0 || t >= 1 ? pen / 2 : pen;
        }
      }
      if (free) {
        // No preference for where along the route
      } else if (this.located) {
        cost += Math.abs(along - expected) * continuity;
        const behind = this.along - PROGRESS.holdBackM - along;
        if (behind > 0) cost += behind * PROGRESS.backwardsPerM;
      } else {
        // First fix: the start of the route is the likelier place
        cost += along * continuity;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = { along, lateralM: lateral, segment: i, bearing: p.segBearing[i]!, headingDiff };
      }
    }
    this.lastScan += scanned;
    return best;
  }

  /**
   * Moves progress to `m` (a match for `fix`), forwards only: a little
   * backwards is held as noise, a lot only after repeated fixes.
   */
  commit(fix: GpsFix, m: RouteMatch): RouteProgress {
    if (!this.located) {
      this.along = m.along;
      this.located = true;
    } else if (m.along >= this.along) {
      // Never further than the car could have gone since the last fix
      const prev = this.lastFix;
      const dt = prev && Number.isFinite(prev.time) ? Math.max(0, (fix.time - prev.time) / 1000) : Infinity;
      const v = fix.speedMs != null && fix.speedMs >= 0 ? fix.speedMs : 45;
      const maxStep = Number.isFinite(dt) ? Math.max(PROGRESS.minAdvanceM, (v * 1.5 + 5) * dt) : Infinity;
      this.along = Math.min(m.along, this.along + maxStep);
      this.backwards = 0;
    } else if (this.along - m.along > PROGRESS.holdBackM) {
      this.backwards++;
      if (this.backwards >= PROGRESS.backConfirmFixes) {
        this.along = m.along;
        this.backwards = 0;
      }
    } else {
      this.backwards = 0;
    }
    this.lastFix = fix;
    return progressAt(this.route, this.along);
  }

  /** A fix that wasn't committed still counts as the latest (for timing) */
  noteFix(fix: GpsFix): void {
    this.lastFix = fix;
  }
}

/** Whether a fix is good enough to guide by */
export function usableFix(fix: GpsFix): boolean {
  return Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)
    && (fix.accuracyM == null || fix.accuracyM <= PROGRESS.maxUsableAccuracyM);
}

// The posted speed limit of the road the car is on, while navigating: from
// the route itself, never guessed.
//
// Where it comes from: the API asks Mapbox Directions for the `maxspeed`
// annotation (api-server lib/mapboxDirections.ts), Mapbox's posted-limit
// data for each segment of the route line (in the UK given in mph; the API
// carries it as whole km/h, exact enough to give the mph back), null where
// Mapbox has no limit for a segment. It arrives with every route and
// reroute; nothing else is asked for.
//
// Placed along the route two ways, the first that is usable:
//  1. by distance (newer servers): the API turns the limits into stretches
//     of the route in metres, from Mapbox's own per-segment distances, so
//     nothing depends on the line's points lining up one for one with the
//     annotation; checked against the line's length (within
//     SPEED_LIMIT.maxLengthMismatch);
//  2. by segment (older servers): one value per segment of the line, legs
//     together, exactly; anything else, no limit at all.
//
// Only shown when it can be trusted to be for this road:
//  - navigating on the route with good GPS (not starting, off route,
//    rerouting or arrived);
//  - Mapbox knows the limit where the car is (unknown or "no limit" shows
//    nothing);
//  - it reads as a real sign: a whole multiple of 5 in the units shown.
// Not covered by the data: temporary limits (roadworks), variable limits on
// smart motorways, and changes since Mapbox's data was last updated.
//
// No React Native imports, so it is unit-tested under node.

import { convertSpeed, type ResolvedUnitSystem } from '../units';
import type { SpeedLimitRange } from './model';
import { segmentAt, type PreparedRoute } from './routeProgress';

export const SPEED_LIMIT = {
  /** The limit of the road this far behind the car (m): a new limit shows once it is passed, without flicker at the sign */
  lagM: 5,
  /** Placed by distance only while Mapbox's distances and the line's length agree this closely (share) */
  maxLengthMismatch: 0.03,
} as const;

/** How a route's limits are placed, or why it has none (diagnostics) */
export type SpeedLimitSource =
  | { kind: 'distance'; ranges: SpeedLimitRange[]; scale: number }
  | { kind: 'segments'; limits: Float64Array }
  | { kind: 'none'; reason: 'no_annotation' | 'no_known_limits' | 'count_mismatch' | 'points_mismatch' | 'length_mismatch' | 'bad_ranges' };

const cache = new WeakMap<PreparedRoute, SpeedLimitSource>();

/** How this route's limits are placed (worked out once per route) */
export function speedLimitSource(p: PreparedRoute): SpeedLimitSource {
  let v = cache.get(p);
  if (!v) cache.set(p, (v = placeLimits(p)));
  return v;
}

function placeLimits(p: PreparedRoute): SpeedLimitSource {
  const legs = p.route.legs;
  if (legs.length && legs.every((l) => Array.isArray(l.speedLimits) && l.annotatedM != null)) {
    const byDistance = byDistanceSource(p);
    if (byDistance.kind === 'distance') return byDistance;
    // Unusable by distance: by segment, if that lines up; else say why by distance
    const bySegment = bySegmentSource(p);
    return bySegment.kind === 'segments' ? bySegment : byDistance;
  }
  return bySegmentSource(p);
}

function byDistanceSource(p: PreparedRoute): SpeedLimitSource {
  const legs = p.route.legs;
  const ranges = legs.flatMap((l) => l.speedLimits!);
  const annotated = legs.reduce((sum, l) => sum + (l.annotatedM ?? 0), 0);
  if (!(annotated > 0) || !(p.total > 0)) return { kind: 'none', reason: 'bad_ranges' };
  const scale = p.total / annotated;
  if (Math.abs(scale - 1) > SPEED_LIMIT.maxLengthMismatch) return { kind: 'none', reason: 'length_mismatch' };
  let end = -Infinity;
  for (const r of ranges) {
    const ok = Number.isFinite(r.fromM) && Number.isFinite(r.toM) && r.toM > r.fromM && r.fromM >= end - 0.5
      && Number.isFinite(r.kmh) && r.kmh > 0;
    if (!ok) return { kind: 'none', reason: 'bad_ranges' };
    end = r.toM;
  }
  if (!ranges.length) return { kind: 'none', reason: 'no_known_limits' };
  return { kind: 'distance', ranges, scale };
}

/**
 * The limit (km/h, NaN where unknown) for each segment of the prepared
 * route, or null when the route has no usable per-segment annotation.
 */
export function segmentLimits(p: PreparedRoute): Float64Array | null {
  const s = speedLimitSource(p);
  return s.kind === 'segments' ? s.limits : null;
}

function bySegmentSource(p: PreparedRoute): SpeedLimitSource {
  const legs = p.route.legs;
  if (!legs.length || legs.some((l) => !Array.isArray(l.maxspeedKmh))) return { kind: 'none', reason: 'no_annotation' };
  const values = legs.flatMap((l) => l.maxspeedKmh!);
  const g = p.route.geometry;
  // One value per segment of the line, or it can't be placed
  if (values.length !== g.length - 1) return { kind: 'none', reason: 'count_mismatch' };
  // The points prepareRoute kept (finite, not a repeat of the one before)
  const kept: number[] = [];
  for (let i = 0; i < g.length; i++) {
    const pt = g[i]!;
    if (!Number.isFinite(pt.latitude) || !Number.isFinite(pt.longitude)) continue;
    const last = kept.length ? g[kept[kept.length - 1]!]! : null;
    if (!last || last.latitude !== pt.latitude || last.longitude !== pt.longitude) kept.push(i);
  }
  if (kept.length !== p.n) return { kind: 'none', reason: 'points_mismatch' };
  const out = new Float64Array(p.n - 1).fill(Number.NaN);
  for (let j = 0; j < p.n - 1; j++) {
    // The raw segments between two kept points are one piece of road (any
    // others are zero-length repeats): the last one with a value
    for (let r = kept[j + 1]! - 1; r >= kept[j]!; r--) {
      const v = values[r];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out[j] = v;
        break;
      }
    }
  }
  if (!out.some((v) => Number.isFinite(v))) return { kind: 'none', reason: 'no_known_limits' };
  return { kind: 'segments', limits: out };
}

/** The limit (km/h) where the car is, `along` metres into the route; null when unknown */
export function limitAt(p: PreparedRoute, along: number): number | null {
  if (!Number.isFinite(along)) return null;
  const s = speedLimitSource(p);
  const at = Math.max(0, along - SPEED_LIMIT.lagM);
  if (s.kind === 'segments') {
    const v = s.limits[segmentAt(p, at)]!;
    return Number.isFinite(v) ? v : null;
  }
  if (s.kind !== 'distance') return null;
  // Into Mapbox's own metres, then the stretch containing it (binary search)
  const m = at / s.scale;
  const r = s.ranges;
  let lo = 0;
  let hi = r.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (r[mid]!.toM <= m) lo = mid + 1;
    else if (r[mid]!.fromM > m) hi = mid - 1;
    else return r[mid]!.kmh;
  }
  return null;
}

/** The number for the sign in the user's units, or null if it wouldn't read as a real limit */
export function limitSign(kmh: number | null, system: ResolvedUnitSystem): number | null {
  if (kmh == null || !Number.isFinite(kmh) || kmh <= 0) return null;
  const n = Math.round(convertSpeed(kmh, system));
  return n > 0 && n % 5 === 0 ? n : null;
}

/** Why the HUD shows no limit right now (diagnostics), or 'shown' */
export type HudLimitGate = 'shown' | 'not_navigating' | 'gps' | 'no_progress' | 'stale_route' | 'no_data' | 'unknown_here' | 'not_a_sign';

export interface HudLimitInput {
  phase: string;
  gps: string | null;
  along: number | null;
  /** Whether the prepared route is the one being followed */
  current: boolean;
}

/** The limit (km/h) the HUD would show, or which gate hides it (any units) */
export function limitGate(p: PreparedRoute | null, input: HudLimitInput): { kmh: number | null; gate: HudLimitGate } {
  if (input.phase !== 'navigating') return { kmh: null, gate: 'not_navigating' };
  if (input.gps !== 'ok') return { kmh: null, gate: 'gps' };
  if (input.along == null) return { kmh: null, gate: 'no_progress' };
  if (!p || !input.current) return { kmh: null, gate: 'stale_route' };
  if (speedLimitSource(p).kind === 'none') return { kmh: null, gate: 'no_data' };
  const kmh = limitAt(p, input.along);
  return kmh == null ? { kmh: null, gate: 'unknown_here' } : { kmh, gate: 'shown' };
}

/** The number for the HUD's sign, and which gate decided it (the one rule the HUD uses) */
export function hudSpeedLimit(p: PreparedRoute | null, input: HudLimitInput, system: ResolvedUnitSystem): { value: number | null; gate: HudLimitGate } {
  const { kmh, gate } = limitGate(p, input);
  if (kmh == null) return { value: null, gate };
  const value = limitSign(kmh, system);
  return value == null ? { value: null, gate: 'not_a_sign' } : { value, gate: 'shown' };
}

/** What a route carries for speed limits (counts only: never a place) */
export function speedLimitDiagnostics(p: PreparedRoute): Record<string, string | number | null> {
  const s = speedLimitSource(p);
  const legs = p.route.legs;
  const values = legs.reduce((n, l) => n + (Array.isArray(l.maxspeedKmh) ? l.maxspeedKmh.length : 0), 0);
  const known = legs.reduce((n, l) => n + (Array.isArray(l.maxspeedKmh) ? l.maxspeedKmh.filter((v) => v != null).length : 0), 0);
  return {
    source: s.kind,
    reason: s.kind === 'none' ? s.reason : null,
    points: p.route.geometry.length,
    values,
    known,
    ranges: legs.reduce((n, l) => n + (Array.isArray(l.speedLimits) ? l.speedLimits.length : 0), 0),
    lengthPct: s.kind === 'distance' ? Math.round((s.scale - 1) * 1000) / 10 : null,
  };
}

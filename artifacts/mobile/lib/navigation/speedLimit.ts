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
// Only shown when it can be trusted to be for this road:
//  - the annotation lines up with the route's points exactly (one value per
//    segment of the line, legs together); anything else, no limit at all;
//  - navigating on the route with good GPS (not starting, off route,
//    rerouting or arrived);
//  - Mapbox knows the limit for the segment the car is on (null or "no
//    limit" segments show nothing);
//  - it reads as a real sign: a whole multiple of 5 in the units shown.
// Not covered by the data: temporary limits (roadworks), variable limits on
// smart motorways, and changes since Mapbox's data was last updated.
//
// No React Native imports, so it is unit-tested under node.

import { convertSpeed, type ResolvedUnitSystem } from '../units';
import { segmentAt, type PreparedRoute } from './routeProgress';

export const SPEED_LIMIT = {
  /** The limit of the road this far behind the car (m): a new limit shows once it is passed, without flicker at the sign */
  lagM: 5,
} as const;

const cache = new WeakMap<PreparedRoute, Float64Array | null>();

/**
 * The limit (km/h, NaN where unknown) for each segment of the prepared
 * route, or null when the route has no usable annotation. Worked out once
 * per route.
 */
export function segmentLimits(p: PreparedRoute): Float64Array | null {
  if (cache.has(p)) return cache.get(p)!;
  const result = build(p);
  cache.set(p, result);
  return result;
}

function build(p: PreparedRoute): Float64Array | null {
  const legs = p.route.legs;
  if (!legs.length || legs.some((l) => !Array.isArray(l.maxspeedKmh))) return null;
  const values = legs.flatMap((l) => l.maxspeedKmh!);
  const g = p.route.geometry;
  // One value per segment of the line, or it can't be placed
  if (values.length !== g.length - 1) return null;
  // The points prepareRoute kept (finite, not a repeat of the one before)
  const kept: number[] = [];
  for (let i = 0; i < g.length; i++) {
    const pt = g[i]!;
    if (!Number.isFinite(pt.latitude) || !Number.isFinite(pt.longitude)) continue;
    const last = kept.length ? g[kept[kept.length - 1]!]! : null;
    if (!last || last.latitude !== pt.latitude || last.longitude !== pt.longitude) kept.push(i);
  }
  if (kept.length !== p.n) return null;
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
  return out;
}

/** The limit (km/h) where the car is, `along` metres into the route; null when unknown */
export function limitAt(p: PreparedRoute, along: number): number | null {
  const limits = segmentLimits(p);
  if (!limits || !Number.isFinite(along)) return null;
  const v = limits[segmentAt(p, Math.max(0, along - SPEED_LIMIT.lagM))]!;
  return Number.isFinite(v) ? v : null;
}

/** The number for the sign in the user's units, or null if it wouldn't read as a real limit */
export function limitSign(kmh: number | null, system: ResolvedUnitSystem): number | null {
  if (kmh == null || !Number.isFinite(kmh) || kmh <= 0) return null;
  const n = Math.round(convertSpeed(kmh, system));
  return n > 0 && n % 5 === 0 ? n : null;
}

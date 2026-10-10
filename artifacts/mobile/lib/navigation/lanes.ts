// Lane guidance (Navigation): which lane(s) to be in for the next manoeuvre.
//
// Data: only the provider's structured lane data (the API's step.lanes,
// from Mapbox's intersections), normalised here once, when the route comes
// in; never read from instruction text, never inferred (not even UK
// roundabout lane rules). A lane is recommended when the provider marks it
// valid for this route's manoeuvre, and preferred when it marks it active.
// Data that looks wrong (no lanes, no valid lane, too many, unreadable) is
// dropped: no guidance is better than wrong guidance.
//
// Which junction: a step can pass several lane-bearing junctions. The one
// that matters for a manoeuvre is the junction at the manoeuvre itself,
// found by position (within LANES.junctionMatchM of the manoeuvre point),
// from the steps either side of it. Not "the first intersection of the step
// the car is on": that's the junction just driven through.
//
// When: from route progress (the same progress engine as the banner), only
// for the manoeuvre coming up, within a distance that grows with speed
// (about 200 m in town, 400 m on fast roads, 800 m at motorway speed, 1 km
// for a motorway exit or fork). Once shown, it stays until the manoeuvre is
// passed or the car is well beyond that distance again (hysteresis), so it
// never flickers around the threshold. Never while circulating a roundabout,
// never for the roundabout's own exit, departure or arrival.
//
// No React Native imports, so it is unit-tested under node.

import { distanceM } from '../backend/geo';
import type { LatLng } from './model';
import type { Maneuver, ManeuverDirection } from './maneuver';

export type LaneDirection = ManeuverDirection;

export interface Lane {
  /** What its markings allow, in a fixed order (left to right); empty: unmarked */
  directions: LaneDirection[];
  /** Can be used for the manoeuvre */
  recommended: boolean;
  /** The provider's preferred lane(s), a subset of the recommended */
  preferred: boolean;
  /** Which of its directions the route takes, when the provider says */
  use: LaneDirection | null;
}

/** A junction with lane data, from the route */
export interface LaneJunction {
  location: LatLng;
  /** Left to right */
  lanes: Lane[];
}

export const LANES = {
  /** The junction at a manoeuvre is this close (m) to its point */
  junctionMatchM: 35,
  maxLanes: 16,
  /** Shown this far (m) before the manoeuvre, by speed... */
  townM: 200,
  fastRoadM: 400,
  motorwayM: 800,
  /** ...and earlier for a motorway exit or fork at speed */
  motorwayExitM: 1_000,
  fastRoadMs: 13, // ~30 mph
  motorwayMs: 22, // ~50 mph
  /** Once shown, hidden again only beyond this many times the distance it appeared at */
  hideFactor: 1.3,
  /** Lane guidance logged per session (diagnostics) */
  maxLogs: 40,
} as const;

const DIRECTIONS: Record<string, LaneDirection> = {
  uturn: 'uturn',
  'sharp left': 'sharpLeft',
  left: 'left',
  'slight left': 'slightLeft',
  straight: 'straight',
  'slight right': 'slightRight',
  right: 'right',
  'sharp right': 'sharpRight',
};
const ORDER: LaneDirection[] = ['uturn', 'sharpLeft', 'left', 'slightLeft', 'straight', 'slightRight', 'right', 'sharpRight'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One junction's lanes from the API, or null if they can't be trusted */
function normalizeLanes(raw: unknown): Lane[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > LANES.maxLanes) return null;
  const lanes: Lane[] = [];
  for (const l of raw) {
    if (!isObj(l) || typeof l.valid !== 'boolean') return null;
    const seen = new Set<LaneDirection>();
    for (const i of Array.isArray(l.indications) ? l.indications : []) {
      const d = typeof i === 'string' ? DIRECTIONS[i] : undefined;
      if (d) seen.add(d);
    }
    const directions = ORDER.filter((d) => seen.has(d));
    const use = typeof l.validIndication === 'string' ? DIRECTIONS[l.validIndication] ?? null : null;
    lanes.push({
      directions,
      recommended: l.valid,
      preferred: l.valid && l.active === true,
      // Only a direction the lane actually has
      use: l.valid && use && (directions.includes(use) || !directions.length) ? use : null,
    });
  }
  return lanes.some((l) => l.recommended) ? lanes : null;
}

/** A step's lane junctions from the API (once, when the route comes in); undefined when there are none */
export function normalizeLaneJunctions(raw: unknown): LaneJunction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LaneJunction[] = [];
  for (const j of raw) {
    if (!isObj(j) || !isObj(j.location)) continue;
    const { lat, lng } = j.location as { lat?: unknown; lng?: unknown };
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const lanes = normalizeLanes(j.lanes);
    if (lanes) out.push({ location: { latitude: lat, longitude: lng }, lanes });
  }
  return out.length ? out : undefined;
}

/** Manoeuvres that never get lane guidance */
const NO_LANES = new Set<Maneuver['kind']>(['depart', 'arrive', 'roundaboutExit', 'notification']);

/**
 * The lanes for the manoeuvre at `location`: the lane junction at the
 * manoeuvre point (from the step leading to it, or its own), the nearest
 * within junctionMatchM; null if there's none.
 */
export function lanesAt(
  kind: Maneuver['kind'],
  location: LatLng,
  candidates: ReadonlyArray<LaneJunction | undefined>,
): Lane[] | null {
  if (NO_LANES.has(kind)) return null;
  let best: LaneJunction | null = null;
  let bestD: number = LANES.junctionMatchM;
  for (const j of candidates) {
    if (!j) continue;
    const d = distanceM(j.location, location);
    if (d <= bestD) {
      best = j;
      bestD = d;
    }
  }
  return best ? best.lanes : null;
}

/** How far before a manoeuvre (m) lane guidance starts, at this speed */
export function laneShowWithinM(speedMs: number | null, kind: Maneuver['kind']): number {
  const v = speedMs ?? 0;
  if (v >= LANES.motorwayMs) return kind === 'offRamp' || kind === 'fork' ? LANES.motorwayExitM : LANES.motorwayM;
  return v >= LANES.fastRoadMs ? LANES.fastRoadM : LANES.townM;
}

/** What the lane strip shows */
export interface LaneView {
  /** Changes only with the route and manoeuvre */
  key: string;
  stepIndex: number;
  lanes: Lane[];
  recommended: number;
  drivingSide: 'left' | 'right';
}

/** Visibility over successive progress updates (shown once close enough; hidden once passed) */
export class LaneTracker {
  private shown: { key: string; within: number; view: LaneView } | null = null;

  reset(): void {
    this.shown = null;
  }

  /**
   * The lanes to show now for the manoeuvre coming up, or null. `routeKey`
   * identifies the route (a reroute is a new one). A view is reused while
   * it's for the same manoeuvre, so the UI only re-renders when it changes.
   */
  update(routeKey: string, next: Maneuver, distanceToNextM: number, onRoundabout: boolean, speedMs: number | null): LaneView | null {
    if (!next.lanes || onRoundabout) {
      this.shown = null;
      return null;
    }
    const key = `${routeKey}|${next.stepIndex}`;
    const s = this.shown;
    if (s && s.key === key) {
      if (distanceToNextM > s.within * LANES.hideFactor) {
        this.shown = null;
        return null;
      }
      return s.view;
    }
    const within = laneShowWithinM(speedMs, next.kind);
    if (distanceToNextM > within) {
      this.shown = null;
      return null;
    }
    const view: LaneView = {
      key, stepIndex: next.stepIndex, lanes: next.lanes, drivingSide: next.drivingSide,
      recommended: next.lanes.filter((l) => l.recommended).length,
    };
    this.shown = { key, within, view };
    return view;
  }
}

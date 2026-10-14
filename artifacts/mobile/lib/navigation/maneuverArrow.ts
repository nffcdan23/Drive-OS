// The white manoeuvre arrow drawn on the route ahead of a turn: the route's
// own shape through the junction (into the turn and out of it, or round a
// roundabout to its exit), with a head where it leaves, so the map shows the
// movement itself, as Google and Apple Maps do. It is drawn over the blue
// route line, narrower than it, so the route stays visible either side.
//
// Built from the prepared route (the same points the blue line uses) and its
// steps; routing is never changed. Shown for the manoeuvre coming up when it
// actually turns (turns, forks, slip roads, end of road, roundabouts,
// U-turns; not "continue straight", departure or arrival), once the car is
// within MANEUVER_ARROW's show distance of it; gone once it is passed, and
// replaced by the next one. A reroute brings a new route and a new arrow.
// Its shaft is consumed behind the car the same way as the blue line.
//
// How long it is: from a few seconds' drive before the manoeuvre to a few
// seconds after it at the speed of the road leading in (so it reads the same
// at town and motorway zoom), never reaching far into the steps either side.
//
// No React Native imports, so it is unit-tested under node.

import { bearingDeg } from '../backend/geo';
import type { Maneuver } from './maneuver';
import { pointAt, segmentAt, type PreparedRoute, type RouteProgress } from './routeProgress';

export const MANEUVER_ARROW = {
  /** Shown this many seconds of driving before the manoeuvre, within these bounds (m) */
  showWithinS: 25,
  showMinM: 200,
  showMaxM: 800,
  /** The shaft starts this long before the manoeuvre (s of driving), within these bounds (m) */
  beforeS: 2.5,
  beforeMinM: 30,
  beforeMaxM: 90,
  /** …and ends this long after it */
  afterS: 2,
  afterMinM: 25,
  afterMaxM: 70,
  /** Round a roundabout: to its exit and this much past it, at most roundaboutMaxM after the entry */
  roundaboutPastExitM: 20,
  roundaboutMaxM: 160,
  /** Never more than this share of the step before or after it */
  stepShare: 0.45,
  /** The head is turned to the route's direction over this last stretch (m) */
  headSpanM: 8,
  /** Speed assumed when a step has no usable duration (m/s) */
  fallbackSpeedMs: 13,
} as const;

/** The manoeuvres with a movement worth drawing */
export function drawsArrow(m: Maneuver): boolean {
  switch (m.kind) {
    case 'turn':
    case 'continue':
    case 'merge':
      return m.direction != null && m.direction !== 'straight';
    case 'onRamp':
    case 'offRamp':
    case 'fork':
    case 'endOfRoad':
    case 'roundabout':
    case 'miniRoundabout':
    case 'uturn':
      return true;
    default:
      return false;
  }
}

/** The average speed (m/s) of the step leading into manoeuvre `m` */
function approachSpeed(p: PreparedRoute, m: number): number {
  const s = p.steps[m - 1];
  const v = s && s.durationS > 0 && s.distanceM > 0 ? s.distanceM / s.durationS : NaN;
  return Number.isFinite(v) && v > 0 ? v : MANEUVER_ARROW.fallbackSpeedMs;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * The manoeuvre to draw the arrow for at this progress (its step index), or
 * null: the one coming up, when it turns and the car is close enough.
 */
export function arrowManeuver(p: PreparedRoute, progress: RouteProgress | null): number | null {
  if (!progress) return null;
  const m = progress.next.stepIndex;
  if (m <= 0 || m >= p.steps.length) return null;
  const maneuver = p.maneuvers[m];
  if (!maneuver || !drawsArrow(maneuver)) return null;
  const A = MANEUVER_ARROW;
  const within = clamp(approachSpeed(p, m) * A.showWithinS, A.showMinM, A.showMaxM);
  // On a roundabout, `next` is the roundabout itself until its exit: still shown
  return progress.distanceToNextM <= within || progress.onRoundabout ? m : null;
}

export interface ManeuverArrowShape {
  /** The step it is for */
  step: number;
  /** The shaft, along the route (lng, lat) */
  coordinates: [number, number][];
  /** Where the shaft starts and ends, along the route (m) */
  fromAlong: number;
  toAlong: number;
  /** The head: at the shaft's end, turned to the route's direction there (° from north) */
  head: [number, number];
  headBearing: number;
}

const shapes = new WeakMap<PreparedRoute, Map<number, ManeuverArrowShape | null>>();

/** The arrow for manoeuvre `m` of this route (worked out once per route and manoeuvre) */
export function maneuverArrowShape(p: PreparedRoute, m: number): ManeuverArrowShape | null {
  let byStep = shapes.get(p);
  if (!byStep) shapes.set(p, (byStep = new Map()));
  if (byStep.has(m)) return byStep.get(m)!;
  const shape = build(p, m);
  byStep.set(m, shape);
  return shape;
}

function build(p: PreparedRoute, m: number): ManeuverArrowShape | null {
  if (m <= 0 || m >= p.steps.length) return null;
  const maneuver = p.maneuvers[m];
  if (!maneuver || !drawsArrow(maneuver)) return null;
  const A = MANEUVER_ARROW;
  const at = p.stepStart[m]!;
  const prevStart = p.stepStart[m - 1]!;
  const nextStart = m + 1 < p.steps.length ? p.stepStart[m + 1]! : p.total;
  const v = approachSpeed(p, m);
  const before = Math.min(clamp(v * A.beforeS, A.beforeMinM, A.beforeMaxM), (at - prevStart) * A.stepShare);
  let after: number;
  if (maneuver.kind === 'roundabout' || maneuver.kind === 'miniRoundabout') {
    // Round to the exit (holdUntil), a little past it
    const exit = p.holdUntil[m]! > at ? p.holdUntil[m]! : at + A.afterMinM;
    after = Math.min(exit - at + A.roundaboutPastExitM, A.roundaboutMaxM);
  } else {
    after = Math.min(clamp(v * A.afterS, A.afterMinM, A.afterMaxM), (nextStart - at) * A.stepShare);
  }
  const fromAlong = Math.max(0, at - before);
  const toAlong = Math.min(p.total, at + after);
  if (toAlong - fromAlong < 10) return null;
  const coordinates: [number, number][] = [];
  const start = pointAt(p, fromAlong);
  coordinates.push([start.longitude, start.latitude]);
  for (let i = segmentAt(p, fromAlong) + 1; i < p.n && p.cum[i]! < toAlong; i++) {
    coordinates.push([p.lng[i]!, p.lat[i]!]);
  }
  const end = pointAt(p, toAlong);
  coordinates.push([end.longitude, end.latitude]);
  const headFrom = pointAt(p, Math.max(fromAlong, toAlong - A.headSpanM));
  return {
    step: m,
    coordinates,
    fromAlong,
    toAlong,
    head: [end.longitude, end.latitude],
    headBearing: bearingDeg(headFrom, end),
  };
}

/**
 * How much of the shaft is behind the car's line start (`startAlong`, the
 * blue line's own trim): the share of the shaft to hide, 0–1. The shaft is
 * short, so its length along the route stands for its length on the map.
 */
export function shaftTrim(shape: ManeuverArrowShape, startAlong: number): number {
  const len = shape.toAlong - shape.fromAlong;
  if (!(len > 0)) return 0;
  return clamp((startAlong - shape.fromAlong) / len, 0, 1);
}

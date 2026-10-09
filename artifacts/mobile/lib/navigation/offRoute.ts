// Off-route detection (Navigation Phase 3): whether the car has really left
// the route, judged conservatively from several signals at once:
//
//  - how far the fix is from the route, against a threshold that grows with
//    the fix's own inaccuracy;
//  - for how long, over how many fixes and how much travel that has held;
//  - the direction of travel (driving the route the wrong way);
//  - the GPS accuracy: a fix too poor to judge counts for nothing, either way.
//
// So one noisy point, a few seconds of poor GPS, a road running alongside
// within the threshold, or the corner-cutting of a roundabout never trigger
// it; carrying on past a missed turn does, within a few seconds.
//
// It never reroutes: the guidance shows "You're off route" and the user
// chooses Update Route. Coming back onto the route clears it.
//
// No React Native imports, so it is unit-tested under node.

import { distanceM } from '../backend/geo';

export const OFF_ROUTE = {
  /** A fix farther than this from the route (m) is away from it... */
  minThresholdM: 35,
  /** ...or farther than its accuracy × this + pad, if that's more */
  accuracyFactor: 1.5,
  accuracyPadM: 10,
  /** Fixes less accurate than this (m) are not judged at all */
  maxUsableAccuracyM: 50,
  /** Away for this many fixes, this long and this far before it counts */
  confirmFixes: 3,
  confirmMs: 6_000,
  confirmTravelM: 30,
  /** Clearly gone: this far away (m) for this many fixes */
  farM: 150,
  farConfirmFixes: 2,
  /** Driving the route the wrong way: course this far off (deg), moving, for this many fixes */
  wrongWayDeg: 140,
  wrongWayMinSpeedMs: 4,
  wrongWayConfirmFixes: 4,
  /** Back on the route: this close (m) for this many fixes */
  backOnM: 25,
  backOnFixes: 2,
  /** Near a manoeuvre (m) direction isn't judged (junctions, roundabouts) */
  maneuverZoneM: 40,
  /** A gap in fixes this long (ms) starts the judging over */
  resetAfterGapMs: 10_000,
} as const;

export type Adherence = 'on' | 'off';

export interface AdherenceInput {
  latitude: number;
  longitude: number;
  /** Distance from the best match on the route (m) */
  lateralM: number;
  accuracyM: number | null;
  speedMs: number | null;
  /** Course vs the route's direction at the match (deg), when the course is usable */
  headingDiff: number | null;
  /** Within maneuverZoneM of a manoeuvre, or on a roundabout */
  nearManeuver: boolean;
  time: number;
}

/** The distance (m) beyond which a fix of this accuracy is away from the route */
export function awayThresholdM(accuracyM: number | null): number {
  return Math.max(OFF_ROUTE.minThresholdM, (accuracyM ?? 10) * OFF_ROUTE.accuracyFactor + OFF_ROUTE.accuracyPadM);
}

export class OffRouteDetector {
  private current: Adherence = 'on';
  private suspicion: { count: number; far: number; wrongWay: number; since: number; travelled: number; last: { latitude: number; longitude: number } } | null = null;
  private backOn = 0;
  private lastTime: number | null = null;

  get state(): Adherence {
    return this.current;
  }

  reset(): void {
    this.current = 'on';
    this.suspicion = null;
    this.backOn = 0;
    this.lastTime = null;
  }

  update(f: AdherenceInput): Adherence {
    const o = OFF_ROUTE;
    if (this.lastTime != null && f.time - this.lastTime > o.resetAfterGapMs) {
      this.suspicion = null;
      this.backOn = 0;
    }
    this.lastTime = f.time;
    // Too poor to judge: nothing changes, either way
    if (f.accuracyM != null && f.accuracyM > o.maxUsableAccuracyM) return this.current;

    const threshold = awayThresholdM(f.accuracyM);
    const away = f.lateralM > threshold;
    const wrongWay =
      !f.nearManeuver && !away && (f.speedMs ?? 0) >= o.wrongWayMinSpeedMs
      && f.headingDiff != null && f.headingDiff >= o.wrongWayDeg;

    if (this.current === 'on') {
      if (!away && !wrongWay) {
        this.suspicion = null;
        return 'on';
      }
      const here = { latitude: f.latitude, longitude: f.longitude };
      const s = (this.suspicion ??= { count: 0, far: 0, wrongWay: 0, since: f.time, travelled: 0, last: here });
      s.travelled += distanceM(s.last, here);
      s.last = here;
      if (away) s.count++;
      if (f.lateralM > o.farM) s.far++;
      if (wrongWay) s.wrongWay++;
      const confirmed =
        (s.count >= o.confirmFixes && f.time - s.since >= o.confirmMs && s.travelled >= o.confirmTravelM)
        || s.far >= o.farConfirmFixes
        || s.wrongWay >= o.wrongWayConfirmFixes;
      if (confirmed) {
        this.current = 'off';
        this.suspicion = null;
        this.backOn = 0;
      }
      return this.current;
    }

    const close = f.lateralM <= Math.max(o.backOnM, f.accuracyM ?? 0) && (f.headingDiff == null || f.headingDiff < 60);
    this.backOn = close ? this.backOn + 1 : 0;
    if (this.backOn >= o.backOnFixes) {
      this.current = 'on';
      this.backOn = 0;
    }
    return this.current;
  }
}

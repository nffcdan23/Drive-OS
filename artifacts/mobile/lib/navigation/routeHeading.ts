// The heading to draw (arrow and heading-up camera) while navigating on the
// route: the route's own direction where the arrow is drawn, every frame.
//
// GPS course arrives about once a second, so following it alone turns the
// map in pulses round a bend: ease to the new course, hold, ease again. On
// the route, the road ahead says which way the car is going continuously:
// the direction from a little behind the arrow to a little ahead of it
// (ROUTE_HEADING.backM / aheadM), so a bend turns the view smoothly as the
// arrow (dead-reckoned between fixes) moves round it, a little ahead of the
// car rather than behind it. GPS noise never wobbles it: it is road geometry.
//
// Used only while it is right:
//  - navigating, the arrow within ROUTE_HEADING.maxLateralM of the route;
//  - moving: the GPS course agrees with the route: within agreeDeg to start,
//    and it stops only past leaveDeg (the course lags the road through a
//    tight junction, which must not flip it back and forth). A missed turn
//    soon shows in the course, so the heading goes back to GPS; off route,
//    the course (and compass) as before;
//  - stopped or crawling (no trustworthy course): kept if it was in use
//    (waiting at lights on the route), never started.
//
// No React Native imports, so it is unit-tested under node.

import { bearingDeg, turnDeg } from '../backend/geo';
import type { LatLng } from './model';
import { pointAt, type PreparedRoute } from './routeProgress';
import { nearestAlong } from './routeTrim';

export const ROUTE_HEADING = {
  /** The direction is taken from this far behind the arrow (m)… */
  backM: 8,
  /** …to this far ahead (m): a bend starts turning the view just before it */
  aheadM: 22,
  /** The arrow is looked for this far either side of confirmed progress (m) */
  searchBackM: 30,
  searchAheadM: 70,
  /** Further than this from the route line (m): not on it */
  maxLateralM: 20,
  /** A GPS course within this of the route's direction (°) starts using it… */
  agreeDeg: 35,
  /** …and one further than this stops it */
  leaveDeg: 70,
  /** Below this speed (m/s) the GPS course says nothing */
  minSpeedMs: 3,
} as const;

/** The route's direction at `along` (°), from backM behind to aheadM ahead */
export function routeDirection(p: PreparedRoute, along: number): number {
  const a = pointAt(p, Math.max(0, along - ROUTE_HEADING.backM));
  const b = pointAt(p, Math.min(p.total, along + ROUTE_HEADING.aheadM));
  if (a.latitude === b.latitude && a.longitude === b.longitude) return p.segBearing[0] ?? 0;
  return bearingDeg(a, b);
}

export interface RouteHeadingInput {
  /** The route being followed and confirmed progress on it; null when not navigating on it */
  prepared: PreparedRoute | null;
  confirmedAlong: number | null;
  /** The arrow as drawn this frame */
  arrow: LatLng | null;
  /** The newest GPS course and speed */
  courseDeg: number | null;
  speedMs: number | null;
}

export class RouteHeading {
  private active = false;
  private prepared: PreparedRoute | null = null;

  /** Whether the route's direction is the heading now */
  get inUse(): boolean {
    return this.active;
  }

  /** The heading for this frame from the route, or null to use GPS / compass as before */
  at(input: RouteHeadingInput): number | null {
    const { prepared: p, confirmedAlong: base, arrow } = input;
    if (p !== this.prepared) {
      // A new route (or none): start over, from the course
      this.prepared = p;
      this.active = false;
    }
    if (!p || base == null || !arrow) return this.stop();
    const H = ROUTE_HEADING;
    const hit = nearestAlong(p, arrow, base, H.searchBackM, H.searchAheadM, H.maxLateralM);
    if (!hit) return this.stop();
    const direction = routeDirection(p, hit.along);
    const moving = input.speedMs != null && input.speedMs >= H.minSpeedMs
      && input.courseDeg != null && input.courseDeg >= 0 && input.courseDeg < 360;
    if (moving) {
      // The car itself says whether it is following the road
      const diff = turnDeg(input.courseDeg!, direction);
      this.active = this.active ? diff <= H.leaveDeg : diff <= H.agreeDeg;
    }
    return this.active ? direction : null;
  }

  private stop(): null {
    this.active = false;
    return null;
  }
}

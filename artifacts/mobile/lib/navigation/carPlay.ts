// CarPlay guidance (CarPlay Milestone 4): the navigation session, as the
// CarPlay screen shows it.
//
// There is one navigation session, the iPhone's (session.ts). CarPlay never
// routes, tracks GPS, records or keeps state of its own: this feed reads the
// session (the same state the guidance banner and bar read) and hands the
// native CarPlay screen a plain copy whenever it changes, through the
// optional native module (modules/derwent-carplay-feed). Native code keeps
// the latest copy, so a CarPlay screen connected later, or reconnected,
// picks up the journey already under way. Disconnecting CarPlay changes
// nothing here.
//
// Everything shown on CarPlay comes from the session: Mapbox's own
// instruction text, the engine's distance to the manoeuvre, distance and
// time left, and the destination's name. Nothing is made up: no manoeuvre
// before the car is placed on the route, none while off route or rerouting,
// and a "then" manoeuvre only when the engine has one.
//
// Distances are rounded exactly as the iPhone shows them (formatGuidanceDistance);
// CarPlay writes them out in its own style.
//
// No React Native imports, so it is unit-tested under node.

import { KM_PER_MILE, type ResolvedUnitSystem } from '../units';
import { formatVia } from './format';
import { guidanceLines } from './guidanceText';
import type { Maneuver } from './maneuver';
import type { NavigationMapView, NavigationState } from './session';

const METRES_PER_YARD = 0.9144;

/** A distance as the iPhone shows it: 0.3 mi, 120 yd, 4.2 km, 80 m */
export interface CarPlayDistance {
  value: number;
  unit: 'mi' | 'yd' | 'km' | 'm';
}

export interface CarPlayManeuver {
  /** Stable while it's the same manoeuvre on the same route */
  id: string;
  /** What to do, longest first (Mapbox's instruction, then the banner's road or place) */
  instructions: string[];
  /** SF Symbol for the manoeuvre's arrow */
  symbol: string;
  /** How far away it is */
  distance: CarPlayDistance;
}

/** Why there's no manoeuvre to show (CPTripPauseReason), and the iPhone's words for it */
export interface CarPlayPause {
  reason: 'loading' | 'locating' | 'rerouting';
  text: string;
}

export interface CarPlayGuidance {
  /** The navigation session (a new start is a new one) */
  sessionId: number;
  phase: 'starting' | 'navigating' | 'offRoute' | 'rerouting' | 'arrived';
  destination: { name: string; latitude: number; longitude: number };
  /** "via A591, M6", or null */
  via: string | null;
  /** The route being followed; null once arrived */
  routeId: string | null;
  pause: CarPlayPause | null;
  /** The next manoeuvre, then the one straight after it (when the engine has one) */
  maneuvers: CarPlayManeuver[];
  /** Distance and time left; null until the car is placed on the route */
  remaining: { distance: CarPlayDistance; timeS: number } | null;
}

/** The line still to drive, flat: [lng, lat, lng, lat, …] */
export interface CarPlayRouteLine {
  routeId: string;
  coordinates: number[];
}

/**
 * The native side: the latest guidance and route line. Called on every
 * change; null clears it (no navigation).
 */
export interface CarPlaySink {
  guidance(g: CarPlayGuidance | null): void;
  routeLine(line: CarPlayRouteLine | null): void;
}

/** The session as the feed reads it */
export interface CarPlaySessionSource {
  readonly state: NavigationState;
  readonly map: NavigationMapView;
  subscribe(fn: () => void): () => void;
}

/** The same rounding as formatGuidanceDistance (lib/units), as a number and unit */
export function carPlayDistance(metres: number, system: ResolvedUnitSystem): CarPlayDistance {
  const m = Math.max(0, Number.isFinite(metres) ? metres : 0);
  if (system === 'imperial') {
    const miles = m / (KM_PER_MILE * 1000);
    if (miles >= 0.1) return { value: miles < 10 ? Number(miles.toFixed(1)) : Math.round(miles), unit: 'mi' };
    return { value: Math.max(10, Math.round(m / METRES_PER_YARD / 10) * 10), unit: 'yd' };
  }
  if (m >= 1000) {
    const km = m / 1000;
    return { value: km < 10 ? Number(km.toFixed(1)) : Math.round(km), unit: 'km' };
  }
  return { value: Math.max(10, Math.round(m / 10) * 10), unit: 'm' };
}

/**
 * The SF Symbol for a manoeuvre: the turn's direction, a U-turn on the
 * driving side, roundabouts the way they're driven (clockwise where traffic
 * keeps left), and a pin on arrival.
 */
export function maneuverSymbol(m: Pick<Maneuver, 'kind' | 'direction' | 'drivingSide'>): string {
  const left = m.drivingSide === 'left';
  switch (m.kind) {
    case 'arrive':
      return 'mappin.circle.fill';
    case 'roundabout':
    case 'miniRoundabout':
      return left ? 'arrow.clockwise.circle' : 'arrow.counterclockwise.circle';
    case 'uturn':
      return left ? 'arrow.uturn.right' : 'arrow.uturn.left';
    case 'merge':
      return 'arrow.triangle.merge';
    case 'fork':
      return 'arrow.triangle.branch';
    default:
      break;
  }
  switch (m.direction) {
    case 'slightLeft':
      return 'arrow.up.left';
    case 'slightRight':
      return 'arrow.up.right';
    case 'left':
    case 'sharpLeft':
      return 'arrow.turn.up.left';
    case 'right':
    case 'sharpRight':
      return 'arrow.turn.up.right';
    case 'uturn':
      return left ? 'arrow.uturn.right' : 'arrow.uturn.left';
    default:
      return 'arrow.up';
  }
}

function carPlayManeuver(routeId: string, m: Maneuver, metres: number, system: ResolvedUnitSystem): CarPlayManeuver {
  const { primary } = guidanceLines(m);
  const instructions = [m.instruction, primary].map((t) => t?.trim() ?? '').filter((t, i, all) => t && all.indexOf(t) === i);
  return { id: `${routeId}#${m.stepIndex}`, instructions, symbol: maneuverSymbol(m), distance: carPlayDistance(metres, system) };
}

/** What CarPlay shows for the session's state; null without navigation (idle, or a route that can't be followed) */
export function carPlayGuidance(state: NavigationState, system: ResolvedUnitSystem): CarPlayGuidance | null {
  if (state.phase === 'idle' || state.phase === 'error') return null;
  const { destination } = state;
  const base = {
    sessionId: state.sessionId,
    destination: { name: destination.name, latitude: destination.coordinate.latitude, longitude: destination.coordinate.longitude },
  };
  if (state.phase === 'arrived') {
    return { ...base, phase: 'arrived', via: null, routeId: null, pause: null, maneuvers: [], remaining: null };
  }
  const { route, progress } = state;
  const remaining = progress
    ? { distance: carPlayDistance(progress.distanceRemainingM, system), timeS: Math.max(0, Math.round(progress.durationRemainingS)) }
    : null;
  // The iPhone banner's words while there's no manoeuvre to show
  let pause: CarPlayPause | null = null;
  if (state.phase === 'rerouting') pause = { reason: 'rerouting', text: 'Updating route…' };
  else if (state.phase === 'offRoute') pause = { reason: 'rerouting', text: state.updateFailed ? 'Route update unavailable' : "You're off route" };
  else if (state.starting === 'refreshing') pause = { reason: 'loading', text: 'Updating your route…' };
  else if (!progress) pause = { reason: 'locating', text: 'Starting navigation…' };
  const maneuvers: CarPlayManeuver[] = [];
  if (!pause && progress) {
    maneuvers.push(carPlayManeuver(route.routeId, progress.next, progress.distanceToNextM, system));
    if (progress.then && progress.thenAfterM != null) {
      maneuvers.push(carPlayManeuver(route.routeId, progress.then, progress.thenAfterM, system));
    }
  }
  return { ...base, phase: state.phase, via: formatVia(route.summary), routeId: route.routeId, pause, maneuvers, remaining };
}

/** The line still to drive, flat; null without one */
export function carPlayRouteLine(map: NavigationMapView): CarPlayRouteLine | null {
  const route = map.route;
  if (!route) return null;
  const coordinates: number[] = [];
  if (map.remaining) {
    for (const [lng, lat] of map.remaining) coordinates.push(lng, lat);
  } else {
    for (const p of route.geometry) coordinates.push(p.longitude, p.latitude);
  }
  return coordinates.length >= 4 ? { routeId: route.routeId, coordinates } : null;
}

/**
 * Hands the session to CarPlay, one way: every session change becomes at
 * most one guidance update (only if what CarPlay shows changed) and one
 * route line (only when the drawn line changed: a new route, or every
 * REMAINING_LINE.redrawEveryM of progress). A failing sink never reaches
 * the session or its other listeners.
 */
export class CarPlayFeed {
  private unsubscribe: (() => void) | null = null;
  /** What was last handed over; undefined: nothing yet (the first push always goes, clearing anything stale) */
  private lastGuidance: string | undefined;
  private lastMap: NavigationMapView | null = null;
  private lastLine: CarPlayRouteLine | null = null;
  /** Updates handed over (for tests) */
  sent = 0;

  constructor(
    private readonly session: CarPlaySessionSource,
    private readonly sink: CarPlaySink,
    private readonly units: () => ResolvedUnitSystem,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  get running(): boolean {
    return this.unsubscribe != null;
  }

  /** Follow the session (once: a second start does nothing), handing over its current state straight away */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.session.subscribe(() => this.push());
    this.push();
  }

  /** Stop following, and clear CarPlay's copy (the session itself carries on) */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastMap = null;
    this.lastLine = null;
    this.lastGuidance = undefined;
    this.safely(() => {
      this.sink.guidance(null);
      this.sink.routeLine(null);
    });
  }

  private push(): void {
    const guidance = carPlayGuidance(this.session.state, this.units());
    const key = JSON.stringify(guidance);
    if (key !== this.lastGuidance) {
      this.lastGuidance = key;
      this.sent++;
      this.safely(() => this.sink.guidance(guidance));
    }
    const map = this.session.map;
    if (map !== this.lastMap) {
      const first = this.lastMap == null;
      this.lastMap = map;
      const line = carPlayRouteLine(map);
      if (line || this.lastLine || first) {
        this.lastLine = line;
        this.safely(() => this.sink.routeLine(line));
      }
    }
  }

  private safely(fn: () => void) {
    try {
      fn();
    } catch (err) {
      this.onError(err);
    }
  }
}

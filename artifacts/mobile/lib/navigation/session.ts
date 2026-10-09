// The active navigation session (Navigation Phase 3), outside React.
//
//   idle ──start──▶ starting ──first fix on the route──▶ navigating ◀──┐
//                     │  (refreshing an out-of-date route, or waiting   │ back on the route
//                     │   for GPS)                                      │
//                     ▼                                    off route ──▶ offRoute
//                   error (a route that can't be followed)  Update Route ──▶ rerouting
//                                                           (one tap, one request; the
//   navigating ──destination reached──▶ arrived ──Done──▶ idle       old route stays until
//   any state ──End──▶ idle                                           the new one is in)
//
// It is fed the same accepted GPS fixes as the rest of the Drive screen, but
// only reads them: drive recording, the map's arrow and location sharing
// keep using the raw positions exactly as before. Navigation and recording
// never start, stop or change each other.
//
// Nothing is stored: the route and destination live here, in memory, for as
// long as the session. A Search Box destination is held exactly like any
// other and never written anywhere. The app being closed ends navigation.
//
// Routes are requested only when the user asks: starting with an
// out-of-date preview (one request) and Update Route (one request per tap).
// Never automatically.
//
// The diagnostics journal gets lifecycle facts only (started, step number,
// off route, reroute result, arrived, ended, GPS lost): never a position, a
// place name, a road name or the route.
//
// No React Native imports, so it is unit-tested under node.

import { distanceM } from '../backend/geo';
import type { ServerRoutes } from '../backend/endpoints';
import type { Journal } from '../backend/journal';
import { routeRequestBody, routesFromServer, type Destination, type NavRoute, type RouteOrigin } from './model';
import { OffRouteDetector, OFF_ROUTE, awayThresholdM } from './offRoute';
import type { PreviewError } from './previewStore';
import {
  RouteTracker, UnusableRouteError, pointAt, prepareRoute, usableFix,
  type GpsFix, type PreparedRoute, type RouteProgress,
} from './routeProgress';

export const NAVIGATION = {
  /** No fix for this long (ms): GPS is lost (shown, and nothing advances) */
  gpsLostMs: 10_000,
  /** Arrival: this close to the end of the route (m) */
  arriveWithinM: 15,
  /** ...or this close and nearly stopped */
  arriveSlowWithinM: 50,
  arriveSlowSpeedMs: 3,
  /** ...or this close to the end point itself, near the end of the route */
  arriveNearEndM: 30,
  /** Fixes no less accurate than this (m) can arrive */
  arriveMaxAccuracyM: 40,
  /** Qualifying fixes in a row (one is enough right at the end) */
  arriveFixes: 2,
  /** Step changes logged per session (the journal is shared with drive lifecycle) */
  maxStepLogs: 60,
} as const;

export type NavPhase = 'idle' | 'starting' | 'navigating' | 'offRoute' | 'rerouting' | 'arrived' | 'error';
export type GpsStatus = 'waiting' | 'ok' | 'weak' | 'lost';

interface Common {
  /** Unique per session: a new start makes a new one */
  sessionId: number;
  destination: Destination;
  startedAt: number;
}

export interface ActiveNavigation extends Common {
  phase: 'starting' | 'navigating' | 'offRoute' | 'rerouting';
  route: NavRoute;
  /** Where the car is on the route; null until the first fix places it */
  progress: RouteProgress | null;
  gps: GpsStatus;
  /** While starting: refreshing an out-of-date route, or finding the car on it */
  starting: 'refreshing' | 'locating' | null;
  /** Something to tell the user (a route update that failed) */
  notice: string | null;
}

export type NavigationState =
  | { phase: 'idle' }
  | ActiveNavigation
  | (Common & { phase: 'arrived'; arrivedAt: number })
  | (Common & { phase: 'error'; message: string });

export type EndReason = 'user' | 'replaced' | 'arrived' | 'closed';

export interface NavigationDeps {
  fetchRoutes(body: ReturnType<typeof routeRequestBody>): Promise<ServerRoutes>;
  describe(err: unknown): PreviewError;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  journal?: Journal;
}

export interface StartInput {
  route: NavRoute;
  destination: Destination;
  /** The preview was out of date: fetch a fresh route from here first (one request) */
  refreshFrom?: RouteOrigin | null;
}

const IDLE: NavigationState = { phase: 'idle' };
const isActive = (s: NavigationState): s is ActiveNavigation =>
  s.phase === 'starting' || s.phase === 'navigating' || s.phase === 'offRoute' || s.phase === 'rerouting';

export class NavigationSession {
  private current: NavigationState = IDLE;
  private listeners = new Set<() => void>();
  private nextSession = 0;
  private nextRequest = 0;
  private prepared: PreparedRoute | null = null;
  private tracker: RouteTracker | null = null;
  private detector = new OffRouteDetector();
  private lostTimer: unknown = null;
  private lostAt: number | null = null;
  private lastFix: GpsFix | null = null;
  private arriving = 0;
  private stepLogs = 0;
  private foreground = true;
  /** The map's view of the session: changes only with the route or destination */
  private mapView: { route: NavRoute | null; destination: Destination | null; arrived: boolean } = { route: null, destination: null, arrived: false };
  /** Route requests made (for tests and diagnostics) */
  requests = 0;

  constructor(private readonly deps: NavigationDeps) {}

  get state(): NavigationState {
    return this.current;
  }

  get phase(): NavPhase {
    return this.current.phase;
  }

  /** What the map draws; a new object only when the route or destination changes */
  get map() {
    return this.mapView;
  }

  /** Whether guidance is running (the camera follows the route) */
  get guiding(): boolean {
    return isActive(this.current);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: NavigationState) {
    if (next === this.current) return;
    this.current = next;
    const route = isActive(next) ? next.route : null;
    const destination = next.phase === 'idle' ? null : next.destination;
    const arrived = next.phase === 'arrived';
    const v = this.mapView;
    if (v.route !== route || v.destination !== destination || v.arrived !== arrived) {
      this.mapView = { route, destination, arrived };
    }
    for (const fn of [...this.listeners]) fn();
  }

  private log(event: string, data: Record<string, string | number | boolean | null> = {}) {
    this.deps.journal?.log(event, data);
  }

  /** Start guidance along `route` (the preview's chosen route) */
  async start(input: StartInput): Promise<void> {
    if (this.current.phase !== 'idle') this.end('replaced');
    const sessionId = ++this.nextSession;
    const startedAt = this.deps.now();
    const { destination } = input;
    this.stepLogs = 0;
    this.arriving = 0;
    this.lostAt = null;
    this.detector.reset();
    if (input.refreshFrom) {
      // Show the earlier route while the fresh one comes
      this.set({
        phase: 'starting', sessionId, destination, startedAt, route: input.route, progress: null,
        gps: this.gpsNow(), starting: 'refreshing', notice: null,
      });
      const requestId = ++this.nextRequest;
      let fresh: NavRoute | null = null;
      let notice: string | null = null;
      try {
        this.requests++;
        const routes = routesFromServer(await this.deps.fetchRoutes(routeRequestBody(input.refreshFrom, destination)), `n${requestId}`);
        fresh = routes.find((r) => r.summary && r.summary === input.route.summary) ?? routes[0] ?? null;
        if (!fresh) notice = "Couldn't update the route, so it's the earlier one.";
      } catch {
        notice = "Couldn't update the route, so it's the earlier one.";
      }
      // Ended or replaced meanwhile: nothing to do
      if (this.current.phase === 'idle' || (this.current as Common).sessionId !== sessionId) return;
      this.begin(sessionId, destination, startedAt, fresh ?? input.route, notice, true);
      return;
    }
    this.begin(sessionId, destination, startedAt, input.route, null, false);
  }

  private begin(sessionId: number, destination: Destination, startedAt: number, route: NavRoute, notice: string | null, refreshed: boolean) {
    try {
      this.prepared = prepareRoute(route);
    } catch (err) {
      this.prepared = null;
      this.tracker = null;
      const message = err instanceof UnusableRouteError ? err.message : "This route can't be followed.";
      this.set({ phase: 'error', sessionId, destination, startedAt, message });
      this.log('nav_error', { kind: 'unusable_route' });
      return;
    }
    this.tracker = new RouteTracker(this.prepared);
    this.set({
      phase: 'starting', sessionId, destination, startedAt, route, progress: null,
      gps: this.gpsNow(), starting: 'locating', notice,
    });
    this.log('nav_started', {
      source: destination.source,
      steps: this.prepared.steps.length,
      km: Math.round(this.prepared.total / 100) / 10,
      refreshed,
    });
    this.armLostTimer();
    // A recent fix places the car straight away
    const fix = this.lastFix;
    if (fix && this.deps.now() - fix.time <= 5_000) this.noteFix(fix);
  }

  private gpsNow(): GpsStatus {
    const fix = this.lastFix;
    if (!fix || this.deps.now() - fix.time > NAVIGATION.gpsLostMs) return 'waiting';
    return usableFix(fix) ? 'ok' : 'weak';
  }

  /** The app came back on screen (or left it): the next fix is searched for widely */
  setForeground(live: boolean): void {
    if (live === this.foreground) return;
    this.foreground = live;
    if (live) this.tracker?.widen();
  }

  /** A GPS fix the Drive screen accepted (the same one recording gets, read only) */
  noteFix(raw: GpsFix): void {
    const fix: GpsFix = { ...raw };
    this.lastFix = fix;
    const s = this.current;
    if (!isActive(s)) return;
    this.armLostTimer();
    if (this.lostAt != null) {
      this.log('nav_gps', { state: 'recovered', seconds: Math.round((this.deps.now() - this.lostAt) / 1000) });
      this.lostAt = null;
    }
    const tracker = this.tracker;
    const gps: GpsStatus = usableFix(fix) ? 'ok' : 'weak';
    // Still fetching the fresh route, or too poor to guide by: nothing moves
    if (!tracker || s.starting === 'refreshing' || gps === 'weak') {
      tracker?.noteFix(fix);
      if (s.gps !== gps) this.set({ ...s, gps });
      return;
    }
    const match = tracker.match(fix, s.phase === 'offRoute' || s.phase === 'rerouting');
    if (!match) return;
    const before = tracker.progress;
    const near = this.nearManeuver(match.along, before);
    const adherence = this.detector.update({
      latitude: fix.latitude, longitude: fix.longitude, lateralM: match.lateralM, accuracyM: fix.accuracyM,
      speedMs: fix.speedMs, headingDiff: match.headingDiff, nearManeuver: near, time: fix.time,
    });

    if (adherence === 'off') {
      tracker.noteFix(fix);
      if (s.phase === 'rerouting') {
        if (s.gps !== gps) this.set({ ...s, gps });
        return;
      }
      if (s.phase !== 'offRoute') this.log('nav_off_route', { state: 'entered', step: before?.stepIndex ?? null });
      this.set({ ...s, phase: 'offRoute', gps, starting: null });
      return;
    }

    // On the route (or not yet judged off it). Progress only moves on a fix
    // that's actually close to the line.
    if (match.lateralM > awayThresholdM(fix.accuracyM)) {
      tracker.noteFix(fix);
      if (s.gps !== gps || s.phase === 'offRoute') {
        this.set({ ...s, gps, phase: s.phase === 'offRoute' ? 'navigating' : s.phase });
      }
      return;
    }
    const progress = tracker.commit(fix, match);
    if (s.phase === 'offRoute') this.log('nav_off_route', { state: 'exited', step: progress.stepIndex });
    if (before && progress.stepIndex !== before.stepIndex) this.logStep(progress);
    if (this.arrivedAt(fix, progress)) {
      this.arrive(s);
      return;
    }
    this.set({
      ...s,
      phase: s.phase === 'rerouting' ? 'rerouting' : 'navigating',
      progress, gps, starting: null,
    });
  }

  private nearManeuver(along: number, progress: RouteProgress | null): boolean {
    const p = this.prepared;
    if (!p) return false;
    if (progress?.onRoundabout) return true;
    const zone = OFF_ROUTE.maneuverZoneM;
    // The manoeuvres either side of `along`
    for (let k = 0; k < p.stepStart.length; k++) {
      const at = p.stepStart[k]!;
      if (at > along + zone) break;
      if (Math.abs(at - along) <= zone || (along >= at && along <= p.holdUntil[k]! + zone)) return true;
    }
    return false;
  }

  private logStep(progress: RouteProgress) {
    if (this.stepLogs >= NAVIGATION.maxStepLogs) return;
    this.stepLogs++;
    this.log('nav_step', {
      step: progress.stepIndex,
      kind: this.prepared?.maneuvers[progress.stepIndex]?.kind ?? null,
      ...(this.stepLogs === NAVIGATION.maxStepLogs ? { more: 'not logged' } : {}),
    });
  }

  private arrivedAt(fix: GpsFix, progress: RouteProgress): boolean {
    const p = this.prepared;
    if (!p) return false;
    const a = NAVIGATION;
    const accurate = fix.accuracyM == null || fix.accuracyM <= a.arriveMaxAccuracyM;
    const remaining = progress.distanceRemainingM;
    const slow = (fix.speedMs ?? 0) < a.arriveSlowSpeedMs;
    const nearEnd = distanceM(fix, pointAt(p, p.total)) <= a.arriveNearEndM && progress.along >= p.total - 150;
    const qualifies = accurate && (remaining <= a.arriveWithinM || (remaining <= a.arriveSlowWithinM && slow) || nearEnd);
    this.arriving = qualifies ? this.arriving + 1 : 0;
    return this.arriving >= a.arriveFixes || (qualifies && remaining <= 5);
  }

  private arrive(s: ActiveNavigation) {
    this.stopLostTimer();
    const arrivedAt = this.deps.now();
    this.log('nav_arrived', { minutes: Math.round((arrivedAt - s.startedAt) / 60_000) });
    this.tracker = null;
    this.prepared = null;
    this.set({ phase: 'arrived', sessionId: s.sessionId, destination: s.destination, startedAt: s.startedAt, arrivedAt });
  }

  /**
   * Update Route: fresh directions from `origin` to the same destination.
   * One call, one request; ignored while one is already in flight. The
   * current route stays (and guidance carries on) until the new one is in.
   */
  async reroute(origin: RouteOrigin): Promise<void> {
    const s = this.current;
    if (!isActive(s) || s.phase === 'rerouting' || s.phase === 'starting') return;
    const back = s.phase;
    const requestId = ++this.nextRequest;
    this.set({ ...s, phase: 'rerouting', notice: null });
    this.log('nav_reroute', { result: 'requested', from: back });
    let route: NavRoute | null = null;
    let error: PreviewError | null = null;
    try {
      this.requests++;
      route = routesFromServer(await this.deps.fetchRoutes(routeRequestBody(origin, s.destination)), `n${requestId}`)[0] ?? null;
      if (!route) error = { code: 'route_not_found', message: 'No driving route was found from here.' };
    } catch (err) {
      error = this.deps.describe(err);
    }
    const now = this.current;
    // Ended, replaced or arrived meanwhile: this answer is for nothing
    if (!isActive(now) || now.sessionId !== s.sessionId || requestId !== this.nextRequest) return;
    let prepared: PreparedRoute | null = null;
    if (route) {
      try {
        prepared = prepareRoute(route);
      } catch {
        error = { code: 'unusable_route', message: "The new route can't be followed." };
      }
    }
    if (!route || !prepared) {
      this.log('nav_reroute', { result: error?.code ?? 'failed' });
      // Keep guiding on the old route; say why the update didn't happen
      this.set({ ...now, phase: this.detector.state === 'off' ? 'offRoute' : 'navigating', notice: error?.message ?? "Couldn't update the route." });
      return;
    }
    this.log('nav_reroute', { result: 'ok', steps: prepared.steps.length });
    this.prepared = prepared;
    this.tracker = new RouteTracker(prepared);
    this.detector.reset();
    this.arriving = 0;
    this.set({ ...now, phase: 'navigating', route, progress: null, starting: 'locating', notice: null });
    const fix = this.lastFix;
    if (fix && this.deps.now() - fix.time <= 10_000) this.noteFix(fix);
  }

  /** End navigation (End, or Done after arriving). Recording, if any, carries on. */
  end(reason: EndReason = 'user'): void {
    const s = this.current;
    if (s.phase === 'idle') return;
    this.stopLostTimer();
    this.nextRequest++;
    this.tracker = null;
    this.prepared = null;
    this.lostAt = null;
    this.detector.reset();
    if (s.phase !== 'arrived' || reason !== 'arrived') {
      this.log('nav_ended', { reason, phase: s.phase, minutes: Math.round((this.deps.now() - s.startedAt) / 60_000) });
    }
    this.set(IDLE);
  }

  private armLostTimer() {
    this.stopLostTimer();
    this.lostTimer = this.deps.setTimer(() => {
      this.lostTimer = null;
      const s = this.current;
      if (!isActive(s)) return;
      // Nothing advances while lost; it comes back with the next fix
      if (this.foreground && this.lostAt == null) {
        this.lostAt = this.deps.now();
        this.log('nav_gps', { state: 'lost' });
      }
      if (s.gps !== 'lost') this.set({ ...s, gps: 'lost' });
    }, NAVIGATION.gpsLostMs);
  }

  private stopLostTimer() {
    if (this.lostTimer != null) this.deps.clearTimer(this.lostTimer);
    this.lostTimer = null;
  }
}

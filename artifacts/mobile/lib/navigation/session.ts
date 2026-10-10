// The active navigation session (Navigation Phase 3), outside React.
//
//   idle ──start──▶ starting ──first fix on the route──▶ navigating ◀──┐
//                     │  (refreshing an out-of-date route, or waiting   │ back on the route
//                     │   for GPS)                                      │
//                     ▼                                    off route ──▶ offRoute
//                   error (a route that can't be followed)  automatically ──▶ rerouting
//                                                           (one request at a time; the
//   navigating ──destination reached──▶ arrived ──Done──▶ idle       old route stays until
//   any state ──End──▶ idle                                           the new one is in)
//
// It is fed the same accepted GPS fixes as the rest of the Drive screen, but
// only reads them: drive recording, the map's arrow and location sharing
// keep using the raw positions exactly as before. The session never starts
// or stops a recording itself: it only remembers whether Start Navigation
// started one (`recording`), so the Drive screen can finish that drive on
// arriving and leave one the user started alone.
//
// Nothing is stored: the route and destination live here, in memory, for as
// long as the session. A Search Box destination is held exactly like any
// other and never written anywhere. The app being closed ends navigation.
//
// Routes are requested: starting with an out-of-date preview (one request);
// and once the off-route detector (offRoute.ts, never one noisy fix) is sure
// the car has left the route, automatically, from the car's position,
// heading and speed (REROUTE: one request in flight, a cooldown after each
// new route, a growing wait after a failure, a cap per ten minutes, only
// while still off the route and with the app on screen). An answer that
// comes after the car is back on the route, or after navigation ended, is
// dropped. A failed update keeps the old route.
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
  REMAINING_LINE, RouteTracker, UnusableRouteError, pointAt, prepareRoute, remainingLine, usableFix,
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

/**
 * Automatic rerouting. Well inside the API's own limit (10 route requests a
 * minute, 60 an hour per user, shared with previews), which stays as it is.
 */
export const REROUTE = {
  /** After a new route, wait this long (ms) before another automatic one */
  cooldownMs: 20_000,
  /** After a failure, wait this long (ms), doubling each time... */
  backoffMs: 10_000,
  /** ...up to this */
  maxBackoffMs: 60_000,
  /** At most this many automatic requests in any `windowMs` */
  maxPerWindow: 6,
  windowMs: 10 * 60_000,
  /** Failures in a row before Try Again is offered as well */
  retryAfterFailures: 3,
  /** Below this speed (m/s) the GPS course is noise, so no heading is sent */
  headingMinSpeedMs: 2.8,
  /** Fixes older than this (ms) aren't a starting point */
  maxFixAgeMs: 5_000,
} as const;

export type NavPhase = 'idle' | 'starting' | 'navigating' | 'offRoute' | 'rerouting' | 'arrived' | 'error';
export type GpsStatus = 'waiting' | 'ok' | 'weak' | 'lost';

/**
 * The drive recording alongside this navigation: started by Start Navigation
 * ('navigation': finished on arriving), already running when it started
 * ('existing': never stopped by navigation), or none.
 */
export type NavRecording = 'navigation' | 'existing' | 'none';

interface Common {
  /** Unique per session: a new start makes a new one */
  sessionId: number;
  destination: Destination;
  startedAt: number;
  recording: NavRecording;
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
  /** The last route update failed; the old route is still followed */
  updateFailed: boolean;
  /** Several updates failed in a row: Try Again is offered too */
  canRetry: boolean;
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
  /** The recording alongside (default none) */
  recording?: NavRecording;
}

/** The line still to drive, as [longitude, latitude] points */
export type RouteLine = readonly (readonly [number, number])[];

/** What the map draws */
export interface NavigationMapView {
  route: NavRoute | null;
  /** The part of `route` still ahead; null: all of it */
  remaining: RouteLine | null;
  destination: Destination | null;
  arrived: boolean;
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
  /** The map's view of the session: changes with the route, the destination, or every REMAINING_LINE.redrawEveryM of progress */
  private mapView: NavigationMapView = { route: null, remaining: null, destination: null, arrived: false };
  /** The remaining line last drawn, and how far along it starts */
  private trimmed: { prepared: PreparedRoute; along: number; line: RouteLine } | null = null;
  /** Automatic rerouting: no request before this time; failures in a row; when requests were made */
  private nextAutoAt = 0;
  private failures = 0;
  private autoTimes: number[] = [];
  /** Route requests made (for tests and diagnostics) */
  requests = 0;

  constructor(private readonly deps: NavigationDeps) {}

  get state(): NavigationState {
    return this.current;
  }

  get phase(): NavPhase {
    return this.current.phase;
  }

  /** What the map draws; a new object only when the route, destination or drawn remainder changes */
  get map(): NavigationMapView {
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
    const remaining = this.remainingFor(route, isActive(next) ? next.progress : null);
    const destination = next.phase === 'idle' ? null : next.destination;
    const arrived = next.phase === 'arrived';
    const v = this.mapView;
    if (v.route !== route || v.remaining !== remaining || v.destination !== destination || v.arrived !== arrived) {
      this.mapView = { route, remaining, destination, arrived };
    }
    for (const fn of [...this.listeners]) fn();
  }

  /**
   * The line still to drive: derived from the prepared route (never changed),
   * starting just behind the car's progress, which only ever moves it
   * forwards. Rebuilt only after REMAINING_LINE.redrawEveryM of progress, so
   * the map isn't redrawn per fix, let alone per frame.
   */
  private remainingFor(route: NavRoute | null, progress: RouteProgress | null): RouteLine | null {
    const p = this.prepared;
    if (!route || !p || p.route !== route) {
      this.trimmed = null;
      return null;
    }
    const t = this.trimmed && this.trimmed.prepared === p ? this.trimmed : null;
    const along = Math.max(progress?.along ?? 0, t?.along ?? 0);
    if (t && along - t.along < REMAINING_LINE.redrawEveryM) return t.line;
    const line = remainingLine(p, along);
    this.trimmed = { prepared: p, along, line };
    return line;
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
    const recording = input.recording ?? 'none';
    this.stepLogs = 0;
    this.arriving = 0;
    this.lostAt = null;
    this.detector.reset();
    this.resetRerouting();
    if (input.refreshFrom) {
      // Show the earlier route while the fresh one comes
      this.set({
        phase: 'starting', sessionId, destination, startedAt, recording, route: input.route, progress: null,
        gps: this.gpsNow(), starting: 'refreshing', notice: null, updateFailed: false, canRetry: false,
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
      // (The recording may have ended meanwhile: the state knows)
      this.begin(sessionId, destination, startedAt, this.current.recording, fresh ?? input.route, notice, true);
      return;
    }
    this.begin(sessionId, destination, startedAt, recording, input.route, null, false);
  }

  private begin(
    sessionId: number, destination: Destination, startedAt: number, recording: NavRecording,
    route: NavRoute, notice: string | null, refreshed: boolean,
  ) {
    try {
      this.prepared = prepareRoute(route);
    } catch (err) {
      this.prepared = null;
      this.tracker = null;
      const message = err instanceof UnusableRouteError ? err.message : "This route can't be followed.";
      this.set({ phase: 'error', sessionId, destination, startedAt, recording, message });
      this.log('nav_error', { kind: 'unusable_route' });
      return;
    }
    this.tracker = new RouteTracker(this.prepared);
    this.set({
      phase: 'starting', sessionId, destination, startedAt, recording, route, progress: null,
      gps: this.gpsNow(), starting: 'locating', notice, updateFailed: false, canRetry: false,
    });
    this.log('nav_started', {
      source: destination.source,
      steps: this.prepared.steps.length,
      km: Math.round(this.prepared.total / 100) / 10,
      refreshed,
      recording,
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
      // Confirmed off the route, on a good fix: a new route, when allowed
      this.maybeAutoReroute(fix);
      return;
    }

    // On the route (or not yet judged off it). Progress only moves on a fix
    // that's actually close to the line.
    if (match.lateralM > awayThresholdM(fix.accuracyM)) {
      tracker.noteFix(fix);
      if (s.gps !== gps || s.phase === 'offRoute') {
        this.set({ ...s, gps, ...(s.phase === 'offRoute' ? this.backOnRoute() : {}) });
      }
      return;
    }
    const progress = tracker.commit(fix, match);
    const rejoined = s.phase === 'offRoute' ? this.backOnRoute() : {};
    if (s.phase === 'offRoute') this.log('nav_off_route', { state: 'exited', step: progress.stepIndex });
    if (before && progress.stepIndex !== before.stepIndex) this.logStep(progress);
    if (this.arrivedAt(fix, progress)) {
      this.arrive(s);
      return;
    }
    this.set({
      ...s,
      ...rejoined,
      phase: s.phase === 'rerouting' ? 'rerouting' : 'navigating',
      progress, gps, starting: null,
    });
  }

  /** Back on the route after being off it: a failed update no longer matters */
  private backOnRoute() {
    this.failures = 0;
    return { phase: 'navigating' as const, notice: null, updateFailed: false, canRetry: false };
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
    this.log('nav_arrived', { minutes: Math.round((arrivedAt - s.startedAt) / 60_000), recording: s.recording });
    this.tracker = null;
    this.prepared = null;
    this.set({ phase: 'arrived', sessionId: s.sessionId, destination: s.destination, startedAt: s.startedAt, recording: s.recording, arrivedAt });
  }

  private resetRerouting() {
    this.nextAutoAt = 0;
    this.failures = 0;
    this.autoTimes = [];
  }

  /** Where a new route starts: this fix, with its course only when moving */
  private originOf(fix: GpsFix): RouteOrigin {
    const moving = (fix.speedMs ?? 0) >= REROUTE.headingMinSpeedMs && fix.headingDeg != null && fix.headingDeg >= 0 && fix.headingDeg < 360;
    return {
      coordinate: { latitude: fix.latitude, longitude: fix.longitude },
      headingDeg: moving ? fix.headingDeg : null,
      // Only plausible values (the server refuses impossible ones)
      speedMs: fix.speedMs != null && fix.speedMs >= 0 && fix.speedMs <= 90 ? fix.speedMs : null,
      accuracyM: fix.accuracyM != null && fix.accuracyM >= 0 && fix.accuracyM <= 2_000 ? fix.accuracyM : null,
    };
  }

  /**
   * Off the route (confirmed by the detector) on this fix: request a new
   * route from it, unless one is already on its way, the cooldown or the
   * wait after a failure hasn't passed, the cap is reached, or the app isn't
   * on screen. The next confirmed-off fix tries again.
   */
  private maybeAutoReroute(fix: GpsFix) {
    const s = this.current;
    if (s.phase !== 'offRoute' || this.detector.state !== 'off' || !this.foreground) return;
    const now = this.deps.now();
    if (now < this.nextAutoAt || now - fix.time > REROUTE.maxFixAgeMs) return;
    this.autoTimes = this.autoTimes.filter((t) => now - t < REROUTE.windowMs);
    if (this.autoTimes.length >= REROUTE.maxPerWindow) return;
    this.autoTimes.push(now);
    void this.reroute(this.originOf(fix), 'auto');
  }

  /** Try Again, offered after several failed updates: one request from the latest fix */
  retryReroute(): Promise<void> {
    const fix = this.lastFix;
    if (!fix) return Promise.resolve();
    return this.reroute(this.originOf(fix), 'manual');
  }

  /**
   * A new route from `origin` to the same destination: automatically once
   * off the route, or Try Again. One request at a time (ignored while one is
   * in flight). The current route stays (and guidance carries on) until the
   * new one is in, and stays if it fails. An answer for a session that has
   * ended, or that comes once the car is back on the route, is dropped.
   */
  async reroute(origin: RouteOrigin, trigger: 'auto' | 'manual' = 'manual'): Promise<void> {
    const s = this.current;
    if (!isActive(s) || s.phase === 'rerouting' || s.phase === 'starting') return;
    const back = s.phase;
    const requestId = ++this.nextRequest;
    this.set({ ...s, phase: 'rerouting', notice: null });
    this.log('nav_reroute', { result: 'requested', from: back, trigger });
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
    // Back on the route meanwhile: it's still the one to follow
    if (this.detector.state === 'on') {
      this.log('nav_reroute', { result: 'dropped', reason: 'back_on_route' });
      this.nextAutoAt = this.deps.now() + REROUTE.cooldownMs;
      this.set({ ...now, phase: 'navigating', notice: null });
      return;
    }
    let prepared: PreparedRoute | null = null;
    if (route) {
      try {
        prepared = prepareRoute(route);
      } catch {
        error = { code: 'unusable_route', message: "The new route can't be followed." };
      }
    }
    if (!route || !prepared) {
      this.failures++;
      // Wait longer after each failure in a row (the longest after the API's own limit)
      const wait = error?.code === 'rate_limited'
        ? REROUTE.maxBackoffMs
        : Math.min(REROUTE.backoffMs * 2 ** (this.failures - 1), REROUTE.maxBackoffMs);
      this.nextAutoAt = this.deps.now() + wait;
      this.log('nav_reroute', { result: error?.code ?? 'failed', failures: this.failures });
      // Keep guiding on the old route
      this.set({
        ...now, phase: this.detector.state === 'off' ? 'offRoute' : 'navigating',
        notice: 'Route update unavailable', updateFailed: true,
        canRetry: this.failures >= REROUTE.retryAfterFailures,
      });
      return;
    }
    this.log('nav_reroute', { result: 'ok', steps: prepared.steps.length });
    this.failures = 0;
    this.nextAutoAt = this.deps.now() + REROUTE.cooldownMs;
    this.prepared = prepared;
    this.tracker = new RouteTracker(prepared);
    this.detector.reset();
    this.arriving = 0;
    this.set({ ...now, phase: 'navigating', route, progress: null, starting: 'locating', notice: null, updateFailed: false, canRetry: false });
    const fix = this.lastFix;
    if (fix && this.deps.now() - fix.time <= 10_000) this.noteFix(fix);
  }

  /**
   * The drive recording ended (finished from the drive panel, or by the
   * Drive screen on arriving): navigation no longer has one alongside.
   */
  recordingEnded(): void {
    const s = this.current;
    if (s.phase === 'idle' || s.recording === 'none') return;
    this.set({ ...s, recording: 'none' });
  }

  /** End navigation (End, or Done after arriving). Never stops a recording: the Drive screen does that. */
  end(reason: EndReason = 'user'): void {
    const s = this.current;
    if (s.phase === 'idle') return;
    this.stopLostTimer();
    this.nextRequest++;
    this.tracker = null;
    this.prepared = null;
    this.lostAt = null;
    this.detector.reset();
    this.resetRerouting();
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

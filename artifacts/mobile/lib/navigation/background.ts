// Background guidance (Navigation): keeps an active navigation session going
// while the app is in the background or the phone is locked.
//
// There's no second location stream: the fixes come from the one background
// location task (lib/backend/sharedLocationUpdates), the same one that
// records a drive. While the app is on screen the Drive screen feeds
// navigation as before and the task's fixes are ignored here; off screen
// they're fed to the session in time order. The session then does what it
// does on screen: route progress, the step, distance and time left, the line
// still to drive, off route (the same conservative detector), automatic
// rerouting (the same limits: one request at a time, cooldown, backoff, cap)
// and arrival. Nothing here moves the camera or draws: the map and the
// guidance UI pick up the current state when the app is back.
//
// While it guides, navigation asks for the updates to stay on; it asks for
// them to be started only when no drive is being recorded alongside (the
// recording's own updates serve otherwise), and lets them go when it ends.
//
// The diagnostics journal gets lifecycle facts only (entered the background,
// fixes received, step numbers, reroute results, arrival, back on screen):
// never a position, road, destination, spoken text or the route.
//
// No React Native imports, so it is unit-tested under node.

import type { Journal } from '../backend/journal';
import type { ActiveNavigation, NavigationSession, NavigationState } from './session';

/** A fix from the background location task */
export interface BackgroundFix {
  latitude: number;
  longitude: number;
  speedMs: number | null;
  headingDeg?: number | null;
  accuracyM?: number | null;
  timestamp: number;
}

/** The shared background location updates, as navigation uses them */
export interface NavigationLocationSource {
  /** Keep the updates on while guiding; `start`: start them if they aren't running (no recording alongside) */
  holdForNavigation(start: boolean): Promise<string>;
  releaseForNavigation(): Promise<void>;
  subscribe(fn: (fixes: BackgroundFix[]) => void): () => void;
}

export const BACKGROUND_NAV = {
  /** Step changes logged per spell in the background */
  maxStepLogs: 40,
} as const;

const active = (s: NavigationState): s is ActiveNavigation => s.phase === 'starting' || s.phase === 'navigating' || s.phase === 'offRoute' || s.phase === 'rerouting';

export interface BackgroundNavigationDeps {
  session: NavigationSession;
  /** null where there are no background updates (web, Expo Go) */
  source: NavigationLocationSource | null;
  /** Hands a fix to navigation (the same path the Drive screen's fixes take) */
  feed(fix: BackgroundFix): void;
  now(): number;
  journal?: Journal;
}

export class BackgroundNavigation {
  private appActive = true;
  /** Holding the updates for this session, and whether they were asked to start */
  private holding: { sessionId: number; started: boolean } | null = null;
  private unsubscribe: Array<() => void> = [];
  // One spell in the background
  private spell: { since: number; fixes: number; steps: number; reroutes: number } | null = null;
  private lastStep: number | null = null;
  private lastPhase: NavigationState['phase'] = 'idle';
  private lastRoute: unknown = null;
  /** Fixes fed (for tests and diagnostics) */
  fed = 0;

  constructor(private readonly deps: BackgroundNavigationDeps) {}

  attach(): () => void {
    this.detach();
    this.unsubscribe.push(this.deps.session.subscribe(() => this.onSession()));
    if (this.deps.source) this.unsubscribe.push(this.deps.source.subscribe((fixes) => this.onFixes(fixes)));
    this.onSession();
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.holding) {
      this.holding = null;
      void this.deps.source?.releaseForNavigation().catch(() => {});
    }
  }

  private log(data: Record<string, string | number | boolean | null>) {
    this.deps.journal?.log('nav_background', data);
  }

  /** The app's state (AppState): anything but "active" is off screen for guidance */
  setAppState(state: string): void {
    const isActive = state === 'active';
    if (isActive === this.appActive) return;
    this.appActive = isActive;
    const s = this.deps.session.state;
    if (!isActive) {
      if (!active(s)) return;
      this.spell = { since: this.deps.now(), fixes: 0, steps: 0, reroutes: 0 };
      this.log({ action: 'entered', phase: s.phase, recording: s.recording, location: this.holding ? 'held' : 'none', voice: 'foreground_only' });
      return;
    }
    const spell = this.spell;
    this.spell = null;
    if (!spell) return;
    this.log({
      action: 'returned', phase: s.phase, seconds: Math.round((this.deps.now() - spell.since) / 1000),
      fixes: spell.fixes, steps: spell.steps, reroutes: spell.reroutes,
    });
  }

  /** Fixes from the background task: navigation's only while it's off screen */
  private onFixes(fixes: BackgroundFix[]) {
    if (this.appActive || !active(this.deps.session.state)) return;
    const spell = this.spell;
    if (spell && spell.fixes === 0) this.log({ action: 'fixes', first: true, count: fixes.length });
    const ordered = [...fixes].sort((a, b) => a.timestamp - b.timestamp);
    for (const f of ordered) {
      // Arrived (or ended) part way through a batch: the rest is for nothing
      if (!active(this.deps.session.state)) break;
      this.fed++;
      if (spell) spell.fixes++;
      this.deps.feed(f);
    }
  }

  private onSession() {
    const s = this.deps.session.state;
    this.syncUpdates(s);
    if (!this.appActive && this.spell) this.noteOffScreen(s);
    this.lastPhase = s.phase;
    this.lastRoute = active(s) ? s.route : null;
    this.lastStep = active(s) ? s.progress?.stepIndex ?? this.lastStep : null;
  }

  /** Keep the updates on while guiding; start them only with no recording alongside */
  private syncUpdates(s: NavigationState) {
    const source = this.deps.source;
    if (!source) return;
    if (active(s)) {
      const start = s.recording === 'none';
      const h = this.holding;
      if (h && h.sessionId === s.sessionId && (h.started || !start)) return;
      this.holding = { sessionId: s.sessionId, started: start };
      void source.holdForNavigation(start).then(
        (result) => this.log({ action: 'location', result, recording: s.recording }),
        () => {},
      );
      return;
    }
    if (this.holding) {
      this.holding = null;
      void source.releaseForNavigation().catch(() => {});
    }
  }

  private noteOffScreen(s: NavigationState) {
    const spell = this.spell!;
    if (s.phase === 'arrived' && this.lastPhase !== 'arrived') {
      this.log({ action: 'arrival', recording: s.recording });
      return;
    }
    if (!active(s)) return;
    if (s.phase === 'rerouting' && this.lastPhase !== 'rerouting') {
      spell.reroutes++;
      this.log({ action: 'reroute', result: 'requested' });
    } else if (this.lastPhase === 'rerouting' && s.phase !== 'rerouting') {
      const result = s.route !== this.lastRoute ? 'ok' : s.updateFailed ? 'failed' : 'dropped';
      this.log({ action: 'reroute', result });
    }
    const step = s.progress?.stepIndex;
    if (step != null && step !== this.lastStep && s.route === this.lastRoute) {
      spell.steps++;
      if (spell.steps <= BACKGROUND_NAV.maxStepLogs) this.log({ action: 'step', step });
    }
  }
}

// Keeps the upcoming hazard warning current, outside React: recomputed on
// every navigation update (each GPS fix the session accepts, in the
// foreground or from the background location task, and every reroute) and
// every change to the hazards near the driver (a snapshot, or a Realtime
// report, confirmation or removal). So it stays right while the app is in
// the background, and the screen shows the current warning the moment it
// is back. It never speaks and never notifies.
//
// No React Native imports, so it is unit-tested under node.

import type { BackgroundFix } from '../navigation/background';
import type { NavigationSession } from '../navigation/session';
import type { HazardStore } from './store';
import type { HazardWarnings } from './warnings';

export interface HazardWarningSources {
  session: Pick<NavigationSession, 'state' | 'preparedRoute' | 'subscribe'>;
  store: Pick<HazardStore, 'list' | 'subscribe'>;
  /** The newest raw fix navigation has (speed, heading, accuracy) */
  latestFix: () => BackgroundFix | null;
  warnings: HazardWarnings;
  now?: () => number;
}

/** Starts keeping the warning current; returns the stop function */
export function connectHazardWarnings(src: HazardWarningSources): () => void {
  const now = src.now ?? Date.now;
  const recompute = () => {
    const s = src.session.state;
    const active = s.phase === 'starting' || s.phase === 'navigating' || s.phase === 'offRoute' || s.phase === 'rerouting';
    const prepared = src.session.preparedRoute;
    src.warnings.update({
      sessionId: s.phase === 'idle' ? null : s.sessionId,
      phase: s.phase,
      gps: active ? s.gps : null,
      // Only the route actually being followed
      prepared: active && prepared && prepared.route === s.route ? prepared : null,
      progress: active ? s.progress : null,
      fix: src.latestFix(),
      hazards: src.store.list,
      now: now(),
    });
  };
  const offSession = src.session.subscribe(recompute);
  const offStore = src.store.subscribe(recompute);
  recompute();
  return () => {
    offSession();
    offStore();
  };
}

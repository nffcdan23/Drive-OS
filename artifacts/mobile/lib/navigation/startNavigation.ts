// Start Navigation (Navigation Phase 3): the route preview (Phase 2A)
// becomes an active navigation session. Every kind of destination (saved
// place, Beauty Spot, search result, dropped pin, coordinates) arrives here
// the same way, as a preview, and leaves the same way.
//
// The preview's chosen route is followed as it is, unless the preview was
// marked out of date (10 minutes old, or the car has moved): then starting
// is the user's request for a fresh route from where they are now (one
// request), and the earlier route is used if that fails.
//
// Starting navigation also records the drive, through the app's one existing
// recorder (the same Start Drive as the button), when nothing is being
// recorded yet: the session remembers that it started it ('navigation'), so
// arriving finishes that drive. A drive already being recorded is left alone
// ('existing'): no second recording, and navigation never stops it. As a
// passenger nothing is recorded, as everywhere else.
//
// No React Native imports, so it is unit-tested under node.

import type { NavRoute, RouteOrigin } from './model';
import type { RoutePreviewStore } from './previewStore';
import type { NavigationSession, NavRecording } from './session';

/** The app's drive recorder, as Start Navigation sees it */
export interface NavigationRecorder {
  /** A drive is being recorded now */
  isRecording(): boolean;
  /** A drive may be started (not in Passenger Mode) */
  canRecord(): boolean;
  /** The existing Start Drive (it does nothing if one is already recording) */
  startRecording(): void;
}

/**
 * Whose recording runs alongside a navigation starting now. `replacing` is
 * the recording of a navigation this one replaces: a drive that one started
 * stays navigation's (so arriving still finishes it), never a second drive.
 */
export function recordingForStart(recorder: NavigationRecorder | null | undefined, replacing: NavRecording | null = null): NavRecording {
  if (!recorder) return 'none';
  if (recorder.isRecording()) return replacing === 'navigation' ? 'navigation' : 'existing';
  return recorder.canRecord() ? 'navigation' : 'none';
}

/** Whether Derwent can guide along `route` itself (it has a line and turn-by-turn steps) */
export function canNavigate(route: NavRoute | null | undefined): boolean {
  if (!route || route.geometry.length < 2) return false;
  return route.legs.reduce((n, l) => n + l.steps.length, 0) >= 2;
}

/**
 * Starts guidance on the preview's selected route and closes the preview.
 * False if there was no route to start.
 */
export async function startFromPreview(
  preview: RoutePreviewStore,
  session: NavigationSession,
  currentOrigin: () => Promise<RouteOrigin>,
  recorder?: NavigationRecorder | null,
): Promise<boolean> {
  const s = preview.state;
  if (s.phase !== 'preview') return false;
  const route = s.routes.find((r) => r.index === s.selectedIndex) ?? s.routes[0];
  if (!canNavigate(route)) return false;
  let refreshFrom: RouteOrigin | null = null;
  if (s.stale) {
    refreshFrom = await currentOrigin().catch(() => null);
    // The preview was closed or changed while finding the position: don't start
    if (preview.state.phase !== 'preview' || preview.state.destination !== s.destination) return false;
  }
  // The session takes over (synchronously) before the preview closes, so
  // the map goes straight from the overview into guidance
  const before = session.state;
  const recording = recordingForStart(recorder, before.phase === 'idle' ? null : before.recording);
  const startsDrive = recording === 'navigation' && !recorder!.isRecording();
  const started = session.start({ route: route!, destination: s.destination, refreshFrom, recording });
  preview.cancel();
  if (startsDrive) {
    // Only for a route that can be followed: an unusable one starts nothing
    if (session.phase === 'error') session.recordingEnded();
    else recorder!.startRecording();
  }
  await started;
  return true;
}

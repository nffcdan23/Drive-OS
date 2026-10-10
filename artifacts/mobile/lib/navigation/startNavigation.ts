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
// No React Native imports, so it is unit-tested under node.

import type { NavRoute, RouteOrigin } from './model';
import type { RoutePreviewStore } from './previewStore';
import type { NavigationSession } from './session';

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
  const started = session.start({ route: route!, destination: s.destination, refreshFrom });
  preview.cancel();
  await started;
  return true;
}

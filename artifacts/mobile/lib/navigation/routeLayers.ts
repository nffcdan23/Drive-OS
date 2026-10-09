// What the Drive map draws for a route preview: the selected route, the
// alternatives (tappable) and the destination. Empty when there's no preview,
// so the map's route layers can stay mounted and keep their place beneath the
// trail and the arrow.
//
// No React Native imports, so it is unit-tested under node.

import type { PreviewState } from './previewStore';
import type { LatLng } from './model';

export interface RouteLineCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: { index: number };
    geometry: { type: 'LineString'; coordinates: [number, number][] };
  }>;
}

export interface RoutePointCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: Record<string, never>;
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
}

export interface RoutePreviewFeatures {
  selected: RouteLineCollection;
  alternatives: RouteLineCollection;
  destination: RoutePointCollection;
}

const lineOf = (index: number, points: readonly LatLng[]) => ({
  type: 'Feature' as const,
  properties: { index },
  geometry: { type: 'LineString' as const, coordinates: points.map((p): [number, number] => [p.longitude, p.latitude]) },
});

const EMPTY_LINES: RouteLineCollection = { type: 'FeatureCollection', features: [] };
const EMPTY_POINTS: RoutePointCollection = { type: 'FeatureCollection', features: [] };

/** The preview's features; routes only once they're in (never while routing) */
export function routePreviewFeatures(state: PreviewState): RoutePreviewFeatures {
  if (state.phase === 'idle') return { selected: EMPTY_LINES, alternatives: EMPTY_LINES, destination: EMPTY_POINTS };
  const d = state.destination.coordinate;
  const destination: RoutePointCollection = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [d.longitude, d.latitude] } }],
  };
  if (state.phase !== 'preview') return { selected: EMPTY_LINES, alternatives: EMPTY_LINES, destination };
  const drawable = state.routes.filter((r) => r.geometry.length >= 2);
  return {
    selected: {
      type: 'FeatureCollection',
      features: drawable.filter((r) => r.index === state.selectedIndex).map((r) => lineOf(r.index, r.geometry)),
    },
    alternatives: {
      type: 'FeatureCollection',
      features: drawable.filter((r) => r.index !== state.selectedIndex).map((r) => lineOf(r.index, r.geometry)),
    },
    destination,
  };
}

/** The route index a tap on an alternative names, if it names one */
export function tappedRouteIndex(features: ReadonlyArray<{ properties?: Record<string, unknown> | null }> | undefined): number | null {
  for (const f of features ?? []) {
    const i = f.properties?.index;
    if (typeof i === 'number' && Number.isInteger(i)) return i;
  }
  return null;
}

/** Route colours: distinct from the cyan drive trail */
export const ROUTE_COLORS = {
  selected: '#4C8DFF',
  selectedCasing: '#173B7A',
  alternative: '#8C9AAD',
  alternativeCasing: '#2A3442',
  destination: '#FFFFFF',
  destinationRing: '#173B7A',
} as const;

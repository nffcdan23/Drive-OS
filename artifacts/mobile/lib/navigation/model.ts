// Derwent's navigation route model (Navigation Phase 2A: route previews).
//
// Provider-neutral: the API converts Mapbox's response into this shape, so
// the app never depends on one provider's format. Routes live in memory only
// (Mapbox's terms don't allow Directions results to be stored), and nothing
// here is ever written to the device or a journey.
//
// No React Native imports, so it is unit-tested under node.

import { decodePolyline } from '../backend/geo';
import type { ServerRoute, ServerRoutes } from '../backend/endpoints';

export interface LatLng { latitude: number; longitude: number }

/** Where a preview goes: one of the user's own places, for now */
export interface Destination {
  /** The saved place or Beauty Spot id */
  id: string;
  name: string;
  /** e.g. "Saved place", "Beauty Spot · Friend" */
  subtitle: string | null;
  coordinate: LatLng;
  source: 'saved' | 'spot';
}

/** Where a route starts: the phone's position, and its heading when moving */
export interface RouteOrigin {
  coordinate: LatLng;
  headingDeg: number | null;
}

export interface RouteManeuver {
  type: string;
  modifier: string | null;
  /** Roundabout exit number */
  exit: number | null;
  bearingBefore: number | null;
  bearingAfter: number | null;
  location: LatLng;
  instruction: string | null;
}

export interface RouteStep {
  maneuver: RouteManeuver;
  /** Metres from the start of the route to this step */
  startDistanceM: number;
  distanceM: number;
  durationS: number;
  roadName: string | null;
  /** Road number, e.g. "A591" */
  roadRef: string | null;
  signposts: string | null;
  junctionRef: string | null;
  drivingSide: 'left' | 'right' | null;
  banner: { primary: string; secondary: string | null } | null;
  voice: Array<{ distanceBeforeM: number; text: string }>;
}

export interface RouteLeg {
  distanceM: number;
  durationS: number;
  summary: string;
  steps: RouteStep[];
  /** Per segment: 0 unknown, 1 low, 2 moderate, 3 heavy, 4 severe */
  congestion: number[] | null;
  maxspeedKmh: Array<number | null> | null;
}

export interface NavRoute {
  /** Unique within the app session: the request id and the route's index */
  routeId: string;
  /** 0 is the recommended route; the rest are alternatives */
  index: number;
  geometry: LatLng[];
  distanceM: number;
  durationS: number;
  typicalDurationS: number | null;
  /** Main roads, e.g. "A591, M6" */
  summary: string;
  legs: RouteLeg[];
}

const point = (p: { lat: number; lng: number }): LatLng => ({ latitude: p.lat, longitude: p.lng });

function routeFromServer(r: ServerRoute, requestId: string): NavRoute {
  return {
    routeId: `${requestId}:${r.index}`,
    index: r.index,
    geometry: decodePolyline(r.geometry, 6),
    distanceM: r.distanceM,
    durationS: r.durationS,
    typicalDurationS: r.typicalDurationS,
    summary: r.summary,
    legs: r.legs.map((l) => ({
      distanceM: l.distanceM,
      durationS: l.durationS,
      summary: l.summary,
      congestion: l.congestion,
      maxspeedKmh: l.maxspeedKmh,
      steps: l.steps.map((s) => ({ ...s, maneuver: { ...s.maneuver, location: point(s.maneuver.location) } })),
    })),
  };
}

/**
 * The routes in an API response, ready to draw. Routes without a usable line
 * are dropped (a route that can't be drawn can't be previewed).
 */
export function routesFromServer(res: ServerRoutes, requestId: string): NavRoute[] {
  return (res.routes ?? [])
    .map((r) => routeFromServer(r, requestId))
    .filter((r) => r.geometry.length >= 2 && Number.isFinite(r.distanceM) && Number.isFinite(r.durationS));
}

/** The API request body for a route from `origin` to `destination` */
export function routeRequestBody(origin: RouteOrigin, destination: Destination) {
  return {
    origin: {
      lat: origin.coordinate.latitude,
      lng: origin.coordinate.longitude,
      headingDeg: origin.headingDeg,
    },
    destination: { lat: destination.coordinate.latitude, lng: destination.coordinate.longitude },
  };
}

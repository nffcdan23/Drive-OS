// Mapbox settings and camera maths for the Drive map.
//
// The Drive map runs on Mapbox when a public token and a style URL are both
// configured (EXPO_PUBLIC_MAPBOX_TOKEN, EXPO_PUBLIC_MAPBOX_STYLE_URL) and the
// app binary includes the Mapbox native module; otherwise it keeps the
// react-native-maps map (Apple Maps on iOS, Google on Android).
//
// Kept free of React Native imports so it can be unit-tested under node.

import type { FollowCameraPose, LatLng, ReportedPose } from "./locationSmoothing";

/** Mapbox's own public styles, for the map-style picker's other layers */
export const MAPBOX_PUBLIC_STYLES = {
  outdoors: "mapbox://styles/mapbox/outdoors-v12",
  satelliteStreets: "mapbox://styles/mapbox/satellite-streets-v12",
} as const;

export interface MapboxSettings {
  /** Public token (pk.…) */
  token: string;
  /** The Derwent style, mapbox://styles/<account>/<style id> */
  styleUrl: string;
}

/**
 * The usable Mapbox settings, or null when Mapbox isn't configured.  Only a
 * public token is accepted: a secret token (sk.…) must never ship in the app.
 */
export function mapboxSettings(
  token: string | null | undefined,
  styleUrl: string | null | undefined,
): MapboxSettings | null {
  const t = (token ?? "").trim();
  const s = (styleUrl ?? "").trim();
  if (!t.startsWith("pk.")) return null;
  // mapbox://styles/<account>/<style id>, optionally Studio's /draft copy
  if (
    !/^mapbox:\/\/styles\/[^/\s]+\/[^/\s]+(\/draft)?$/.test(s) &&
    !/^https:\/\/\S+$/.test(s)
  ) {
    return null;
  }
  return { token: t, styleUrl: s };
}

/** The map-style picker's layer, as a Mapbox style URL */
export function mapboxStyleFor(mapType: string, derwentStyleUrl: string): string {
  if (mapType === "satellite" || mapType === "hybrid") {
    return MAPBOX_PUBLIC_STYLES.satelliteStreets;
  }
  if (mapType === "terrain") return MAPBOX_PUBLIC_STYLES.outdoors;
  return derwentStyleUrl;
}

// Zoom range the Drive map's zoom buttons stay within
export const MAPBOX_ZOOM_LIMITS = { min: 3, max: 20 } as const;

export function clampMapboxZoom(zoom: number): number {
  return Math.min(Math.max(zoom, MAPBOX_ZOOM_LIMITS.min), MAPBOX_ZOOM_LIMITS.max);
}

/** A camera write for @rnmapbox/maps' Camera.setCamera */
export interface MapboxCameraStop {
  centerCoordinate: [number, number];
  zoomLevel: number;
  heading: number;
  pitch: number;
  animationDuration: number;
  animationMode: "none";
}

/**
 * The follow camera as one unanimated Mapbox camera write.  The zoom is the
 * follow pose's zoom, which comes only from the held zoom target (never from
 * the map), and Mapbox's zoom doesn't depend on pitch or bearing, so heading
 * and tilt changes can't move it.
 */
export function mapboxFollowCamera(pose: FollowCameraPose): MapboxCameraStop {
  return {
    centerCoordinate: [pose.center.longitude, pose.center.latitude],
    zoomLevel: pose.zoom,
    heading: pose.heading,
    pitch: pose.pitch,
    animationDuration: 0,
    animationMode: "none",
  };
}

/** The camera Mapbox reported (onCameraChanged), as a pose to ease from */
export function reportedPoseFromMapbox(properties: {
  center: number[];
  zoom: number;
  heading: number;
  pitch: number;
}): ReportedPose {
  const [longitude, latitude] = properties.center;
  const pose: ReportedPose = {};
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    pose.center = { latitude, longitude };
  }
  if (Number.isFinite(properties.zoom)) pose.zoom = properties.zoom;
  if (Number.isFinite(properties.heading)) pose.heading = properties.heading;
  if (Number.isFinite(properties.pitch)) pose.pitch = properties.pitch;
  return pose;
}

export interface TrailFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, never>;
    geometry: { type: "LineString"; coordinates: [number, number][] };
  }>;
}

/** The recorded drive as GeoJSON for the trail line (empty under two points) */
export function trailFeatureCollection(
  coordinates: readonly LatLng[] | null | undefined,
): TrailFeatureCollection {
  const points = (coordinates ?? []).filter(
    (c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude),
  );
  if (points.length < 2) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: points.map((c): [number, number] => [c.longitude, c.latitude]),
        },
      },
    ],
  };
}

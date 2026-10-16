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

/**
 * Most points the drawn trail is given at once.  The map's trail source is
 * replaced whenever the route grows, so its size is what each update costs;
 * past this the older stretch is thinned evenly (the recent stretch, where
 * the live head joins it, is kept exactly).  Display only: the recorded
 * route is untouched.
 */
export const TRAIL_DISPLAY = { maxPoints: 4000, recentPoints: 1000 } as const;

export function displayTrail(coordinates: readonly LatLng[] | null | undefined): readonly LatLng[] | null {
  if (!coordinates || coordinates.length <= TRAIL_DISPLAY.maxPoints) return coordinates ?? null;
  const recentFrom = coordinates.length - TRAIL_DISPLAY.recentPoints;
  const room = TRAIL_DISPLAY.maxPoints - TRAIL_DISPLAY.recentPoints;
  const step = recentFrom / room;
  const older: LatLng[] = [];
  for (let i = 0; i < room; i++) older.push(coordinates[Math.floor(i * step)]!);
  return [...older, ...coordinates.slice(recentFrom)];
}

/**
 * The arrow's size against its artwork (44 × 48 pt): 1.2 draws it at about
 * 53 × 58 pt, easier to read at a glance while driving (it was 1). The same
 * artwork from its @2x/@3x files, so it stays sharp; the shadow is scaled
 * with it, and it's still well above the hazard markers (30 pt at most).
 */
export const LOCATION_ARROW_SCALE = 1.2;

/** The arrow artwork's size in points at scale 1 (puck-arrow.png / puck-shadow.png, 44 × 48 pt) */
export const LOCATION_ARROW_ARTWORK_PT = { width: 44, height: 48 } as const;

/**
 * How the location arrow is drawn on the Mapbox map: the Derwent arrow
 * artwork (assets/images/map/puck-arrow.png, over its soft shadow) as an
 * image draped flat on the map (an ImageSource under a RasterLayer), its four
 * corners placed from the car's position, heading and the map's zoom.  So it
 * lies on the road at any tilt and turns with the map, at the same on-screen
 * size the symbol had.
 *
 * Not a symbol layer: a symbol on a GeoJSON source replaced every frame is
 * re-tiled on each update, and symbols in freshly built tiles stay hidden
 * until the map's next placement pass, so the arrow blinked off and on while
 * driving.  An image source's corners are one property update in place: no
 * tiles, no placement, no fade.
 */
export const LOCATION_ARROW_RASTER = {
  rasterOpacity: 1,
  rasterFadeDuration: 0,
  rasterResampling: "linear",
  rasterEmissiveStrength: 1,
} as const;

/** The arrow's pose as last drawn: where, which way, and at what map zoom */
export interface ArrowPose {
  position: LatLng;
  /** Degrees clockwise from north */
  heading: number;
  zoom: number;
}

const validPosition = (p: LatLng | null | undefined): p is LatLng =>
  !!p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
  && Math.abs(p.latitude) <= 85 && Math.abs(p.longitude) <= 180;

/**
 * The arrow's next pose.  Once it has a valid position it never goes away:
 * an invalid position keeps the last valid one, a missing heading keeps the
 * last heading, a missing zoom keeps the last zoom.  Null only before the
 * first valid position.  Returns `prev` itself when nothing changed.
 */
export function nextArrowPose(
  prev: ArrowPose | null,
  position: LatLng | null | undefined,
  heading: number | null | undefined,
  zoom: number | null | undefined,
): ArrowPose | null {
  const pos = validPosition(position) ? position : prev?.position;
  if (!pos) return null;
  const h = typeof heading === "number" && Number.isFinite(heading)
    ? ((heading % 360) + 360) % 360
    : prev?.heading ?? 0;
  const z = typeof zoom === "number" && Number.isFinite(zoom) ? zoom : prev?.zoom ?? 15;
  if (prev && prev.position.latitude === pos.latitude && prev.position.longitude === pos.longitude
    && prev.heading === h && prev.zoom === z) return prev;
  return { position: { latitude: pos.latitude, longitude: pos.longitude }, heading: h, zoom: z };
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/** Metres per point at a latitude and Mapbox zoom (512-point tiles) */
export function metresPerPoint(latitude: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
}

export type ImageCorners = [[number, number], [number, number], [number, number], [number, number]];

/**
 * The arrow image's corners on the map ([lng, lat]; top left, top right,
 * bottom right, bottom left, as ImageSource takes them): centred on the
 * position (the anchor), the artwork's top turned to the heading, sized so
 * it shows at LOCATION_ARROW_SCALE × its artwork at the given zoom.
 */
export function locationArrowCorners(pose: ArrowPose, scale = LOCATION_ARROW_SCALE): ImageCorners {
  const { latitude, longitude } = pose.position;
  const mpp = metresPerPoint(latitude, pose.zoom);
  const halfW = (LOCATION_ARROW_ARTWORK_PT.width * scale * mpp) / 2;
  const halfH = (LOCATION_ARROW_ARTWORK_PT.height * scale * mpp) / 2;
  const rad = (pose.heading * Math.PI) / 180;
  // Unit vectors in metres (east, north): forward along the heading, and to its right
  const fwd = [Math.sin(rad), Math.cos(rad)] as const;
  const right = [Math.cos(rad), -Math.sin(rad)] as const;
  const mPerDegLat = EARTH_CIRCUMFERENCE_M / 360;
  const mPerDegLng = mPerDegLat * Math.cos((latitude * Math.PI) / 180);
  const at = (r: number, f: number): [number, number] => [
    longitude + (right[0] * r + fwd[0] * f) / mPerDegLng,
    latitude + (right[1] * r + fwd[1] * f) / mPerDegLat,
  ];
  return [at(-halfW, halfH), at(halfW, halfH), at(halfW, -halfH), at(-halfW, -halfH)];
}

/**
 * The box around a completed route, for fitting the camera to it ([lng, lat]
 * corners), or null without any valid point.  A route that never moved gets
 * a small box so the camera still has an area to show.
 */
export function routeBounds(
  coordinates: readonly LatLng[] | null | undefined,
): { ne: [number, number]; sw: [number, number] } | null {
  const points = (coordinates ?? []).filter(
    (c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude),
  );
  if (!points.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const c of points) {
    minLat = Math.min(minLat, c.latitude);
    maxLat = Math.max(maxLat, c.latitude);
    minLng = Math.min(minLng, c.longitude);
    maxLng = Math.max(maxLng, c.longitude);
  }
  const MIN_SPAN = 0.002; // about 200 m
  const padLat = Math.max(0, (MIN_SPAN - (maxLat - minLat)) / 2);
  const padLng = Math.max(0, (MIN_SPAN - (maxLng - minLng)) / 2);
  return {
    ne: [maxLng + padLng, maxLat + padLat],
    sw: [minLng - padLng, minLat - padLat],
  };
}

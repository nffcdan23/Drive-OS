// Camera maths for route previews: the camera that shows every route in the
// part of the screen the panels leave clear, and the in-between poses that
// move the map there smoothly.
//
// The poses go through the Drive map's one camera path (LatestPoseWriter →
// the Camera's props), exactly like the follow camera: no setCamera, no
// fitBounds, nothing imperative.
//
// No React Native imports, so it is unit-tested under node.

import type { FollowCameraPose } from '../locationSmoothing';
import type { LatLng, NavRoute } from './model';

export interface Bounds { north: number; south: number; east: number; west: number }

/** The box around every route (and the destination), or null without points */
export function routesBounds(routes: readonly NavRoute[], extra: readonly LatLng[] = []): Bounds | null {
  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  const add = (p: LatLng) => {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
    north = Math.max(north, p.latitude);
    south = Math.min(south, p.latitude);
    east = Math.max(east, p.longitude);
    west = Math.min(west, p.longitude);
  };
  for (const r of routes) for (const p of r.geometry) add(p);
  for (const p of extra) add(p);
  return north >= south && east >= west ? { north, south, east, west } : null;
}

/** Space the panels cover, in points */
export interface Insets { top: number; bottom: number; left: number; right: number }

export const OVERVIEW = {
  /** Zoom range of the overview camera */
  minZoom: 3,
  maxZoom: 16.5,
  /** Map points per zoom-0 world (Mapbox's 512-point tiles) */
  worldSize: 512,
  /** Never fit into less than this (points), however much the panels cover */
  minArea: 80,
} as const;

// Web Mercator, as fractions of the world (0..1, y down)
const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((Math.max(Math.min(lat, 85), -85) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const lngOf = (x: number) => x * 360 - 180;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/**
 * The flat, north-up camera that fits `bounds` inside the screen less
 * `insets`: the largest zoom at which the whole box fits, centred in the clear
 * area (not the middle of the screen, which the panels partly cover).
 */
export function overviewPose(
  bounds: Bounds,
  viewport: { width: number; height: number },
  insets: Insets,
): FollowCameraPose {
  const o = OVERVIEW;
  const areaW = Math.max(viewport.width - insets.left - insets.right, o.minArea);
  const areaH = Math.max(viewport.height - insets.top - insets.bottom, o.minArea);
  const x0 = mercX(bounds.west), x1 = mercX(bounds.east);
  const y0 = mercY(bounds.north), y1 = mercY(bounds.south);
  const spanX = Math.max(x1 - x0, 1e-9);
  const spanY = Math.max(y1 - y0, 1e-9);
  const fit = Math.min(areaW / (spanX * o.worldSize), areaH / (spanY * o.worldSize));
  const zoom = Math.min(Math.max(Math.log2(fit), o.minZoom), o.maxZoom);
  const scale = o.worldSize * 2 ** zoom; // points per world
  // The clear area's centre is offset from the screen's by half the difference
  // in insets; the camera centre is the box centre moved back by that much
  const dx = (insets.left - insets.right) / 2 / scale;
  const dy = (insets.top - insets.bottom) / 2 / scale;
  const cx = (x0 + x1) / 2 - dx;
  const cy = (y0 + y1) / 2 - dy;
  return {
    center: { latitude: latOf(cy), longitude: lngOf(cx) },
    heading: 0,
    pitch: 0,
    // Mapbox states zoom; distance is only read by the Apple Maps fallback,
    // which never shows a preview
    distance: 0,
    zoom,
  };
}

/** Where a point lands on screen (points from the top left) under a flat, north-up pose */
export function screenPoint(pose: FollowCameraPose, viewport: { width: number; height: number }, p: LatLng) {
  const scale = OVERVIEW.worldSize * 2 ** pose.zoom;
  return {
    x: viewport.width / 2 + (mercX(p.longitude) - mercX(pose.center.longitude)) * scale,
    y: viewport.height / 2 + (mercY(p.latitude) - mercY(pose.center.latitude)) * scale,
  };
}

/** Eased progress (smoothstep) */
export const easeInOut = (t: number) => {
  const u = Math.min(Math.max(t, 0), 1);
  return u * u * (3 - 2 * u);
};

/**
 * The pose `t` (0..1) of the way from `a` to `b`: centre in Mercator, zoom
 * linearly (zoom is already logarithmic), heading the short way round.
 */
export function interpolatePose(a: FollowCameraPose, b: FollowCameraPose, t: number): FollowCameraPose {
  const u = Math.min(Math.max(t, 0), 1);
  const lerp = (x: number, y: number) => x + (y - x) * u;
  const turn = ((((b.heading - a.heading) % 360) + 540) % 360) - 180;
  return {
    center: {
      latitude: latOf(lerp(mercY(a.center.latitude), mercY(b.center.latitude))),
      longitude: lngOf(lerp(mercX(a.center.longitude), mercX(b.center.longitude))),
    },
    heading: (((a.heading + turn * u) % 360) + 360) % 360,
    pitch: lerp(a.pitch, b.pitch),
    distance: lerp(a.distance, b.distance),
    zoom: lerp(a.zoom, b.zoom),
  };
}

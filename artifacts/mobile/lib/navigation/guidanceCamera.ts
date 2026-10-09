// How close the camera sits while guiding (Navigation Phase 3): a little
// further out the faster the car goes, and a little closer approaching a
// junction in town, so the turn is clear.
//
// This only picks a zoom. The Drive screen hands it to the follow camera's
// own zoom target (FollowCameraController), which eases to it through the
// one camera path the map has; nothing here writes to the map. Zoom moves
// in a few steps with hysteresis, never continuously, and changes at most
// every few seconds, so it never pumps in and out with speed.
//
// No React Native imports, so it is unit-tested under node.

import type { ManeuverKind } from './maneuver';

export const GUIDANCE_CAMERA = {
  /** Speed bands (km/h) and their Mapbox zoom: town, faster roads, motorway */
  bands: [
    { upToKmh: 55, zoom: 16.4 },
    { upToKmh: 90, zoom: 15.8 },
    { upToKmh: Infinity, zoom: 15.1 },
  ],
  /** A band changes only once speed is this far past its edge (km/h) */
  hysteresisKmh: 8,
  /** Approaching a manoeuvre (closer than this, m) below this speed (km/h)... */
  approachM: 220,
  approachMaxKmh: 70,
  /** ...zooms in by this much */
  approachZoomIn: 0.6,
  /** Zoom never changes more often than this (ms), except to approach a turn */
  minIntervalMs: 4_000,
} as const;

export interface GuidanceZoom {
  band: number;
  approaching: boolean;
  zoom: number;
  changedAt: number;
}

export interface GuidanceZoomInput {
  speedKmh: number;
  distanceToNextM: number | null;
  nextKind: ManeuverKind | null;
  now: number;
}

function bandFor(speedKmh: number, prev: number | null): number {
  const bands = GUIDANCE_CAMERA.bands;
  const raw = bands.findIndex((b) => speedKmh <= b.upToKmh);
  const band = raw < 0 ? bands.length - 1 : raw;
  if (prev == null || band === prev) return band;
  const h = GUIDANCE_CAMERA.hysteresisKmh;
  // Moving up a band: speed must clear the lower band's top by h; down: drop below it by h
  if (band > prev) return speedKmh > bands[prev]!.upToKmh + h ? band : prev;
  return speedKmh < bands[band]!.upToKmh - h ? band : prev;
}

/** The guidance zoom for now, given the last one (null to start) */
export function guidanceZoom(prev: GuidanceZoom | null, input: GuidanceZoomInput): GuidanceZoom {
  const c = GUIDANCE_CAMERA;
  const speed = Math.max(0, input.speedKmh);
  const band = bandFor(speed, prev?.band ?? null);
  const approaching =
    input.distanceToNextM != null && input.distanceToNextM <= c.approachM && speed <= c.approachMaxKmh
    && input.nextKind !== 'arrive' && input.nextKind !== 'notification';
  const zoom = Math.round((c.bands[band]!.zoom + (approaching ? c.approachZoomIn : 0)) * 100) / 100;
  if (!prev) return { band, approaching, zoom, changedAt: input.now };
  if (zoom === prev.zoom) return { ...prev, band, approaching };
  // Zooming in for a turn is never held back; anything else waits its turn
  const urgent = approaching && !prev.approaching;
  if (!urgent && input.now - prev.changedAt < c.minIntervalMs) return prev;
  return { band, approaching, zoom, changedAt: input.now };
}

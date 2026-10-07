/**
 * The drive in progress as the Drive screen shows it: the route so far,
 * distance and speeds.  Built from the fixes CloudSync accepts for the drive
 * (foreground and background alike, each once and in order), so time spent
 * in another app or with the phone locked appears as the road actually
 * driven, not a straight line.
 */
import { msToKmh } from '../units';
import { distanceM } from './geo';
import type { GpsFix, JourneyRecord } from './journeyRecorder';
import type { ActiveDrive } from './model';

export function newLiveDrive(startTime: number): ActiveDrive {
  return { startTime, coordinates: [], speedSamples: [], topSpeed: 0, estimatedDistance: 0, currentSpeed: 0 };
}

/** Adds an accepted fix to the live drive. */
export function appendLiveFix(prev: ActiveDrive, fix: GpsFix): ActiveDrive {
  const speedKmh = msToKmh(fix.speedMs);
  const last = prev.coordinates[prev.coordinates.length - 1];
  const addedKm = last ? distanceM(last, fix) / 1000 : 0;
  return {
    ...prev,
    coordinates: [...prev.coordinates, { latitude: fix.latitude, longitude: fix.longitude }],
    speedSamples: [...prev.speedSamples, speedKmh],
    topSpeed: Math.max(prev.topSpeed, speedKmh),
    estimatedDistance: prev.estimatedDistance + addedKm,
    currentSpeed: speedKmh,
  };
}

/**
 * The live drive for a drive picked up after the app was relaunched: the
 * points recorded so far (the screen's per-second fixes from before are gone).
 */
export function liveDriveFromRecord(rec: JourneyRecord): ActiveDrive {
  const last = rec.points[rec.points.length - 1];
  return {
    startTime: Date.parse(rec.startedAt),
    coordinates: rec.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    speedSamples: rec.points.map((p) => p.speedKmh),
    topSpeed: rec.topSpeedKmh,
    estimatedDistance: rec.clientDistanceKm,
    currentSpeed: last?.speedKmh ?? 0,
  };
}

/**
 * The drive in progress as the Drive screen shows it: the route so far,
 * distance and speeds.  Built from the fixes CloudSync accepts for the drive
 * (foreground and background alike, each once and in order), so time spent
 * in another app or with the phone locked appears as the road actually
 * driven, not a straight line.
 *
 * Display only (what's recorded and uploaded is CloudSync's), and bounded
 * however long the drive:
 *  - the route keeps a point at least every LIVE_ROUTE.minStepM, always ending
 *    exactly at the newest fix (a parked or crawling car doesn't pile up
 *    points), and past LIVE_ROUTE.maxPoints its older half is thinned;
 *  - speed samples past LIVE_ROUTE.maxSpeedSamples are averaged in pairs
 *    (the average speed is unchanged);
 *  - while the app isn't on screen, LiveDriveFeed holds the fixes instead of
 *    re-rendering for each one, and applies them in one go when it's back.
 */
import { msToKmh } from '../units';
import { distanceM } from './geo';
import type { GpsFix, JourneyRecord } from './journeyRecorder';
import type { ActiveDrive } from './model';

export const LIVE_ROUTE = {
  /** A new route point once the last fixed one is this far behind (m) */
  minStepM: 2,
  /** Past this many points the older half of the route is thinned */
  maxPoints: 20_000,
  /** Past this many speed samples they're averaged in pairs */
  maxSpeedSamples: 20_000,
  /** Fixes held while the app isn't on screen before they're folded in (unpublished) */
  maxHeldFixes: 600,
} as const;

export function newLiveDrive(startTime: number): ActiveDrive {
  return { startTime, coordinates: [], speedSamples: [], topSpeed: 0, estimatedDistance: 0, currentSpeed: 0 };
}

/** Adds an accepted fix to the live drive. */
export function appendLiveFix(prev: ActiveDrive, fix: GpsFix): ActiveDrive {
  return appendLiveFixes(prev, [fix]);
}

/** Adds accepted fixes to the live drive, in order, copying its arrays once. */
export function appendLiveFixes(prev: ActiveDrive, fixes: readonly GpsFix[]): ActiveDrive {
  if (!fixes.length) return prev;
  const coordinates = prev.coordinates.slice();
  const speedSamples = prev.speedSamples.slice();
  let { topSpeed, estimatedDistance, currentSpeed } = prev;
  for (const fix of fixes) {
    const speedKmh = msToKmh(fix.speedMs);
    const point = { latitude: fix.latitude, longitude: fix.longitude };
    const n = coordinates.length;
    const last = coordinates[n - 1];
    if (last) estimatedDistance += distanceM(last, point) / 1000;
    // The newest point floats until it's minStepM from the one before it
    if (n >= 2 && distanceM(coordinates[n - 2]!, last!) < LIVE_ROUTE.minStepM) coordinates[n - 1] = point;
    else coordinates.push(point);
    speedSamples.push(speedKmh);
    topSpeed = Math.max(topSpeed, speedKmh);
    currentSpeed = speedKmh;
  }
  return {
    ...prev,
    coordinates: coordinates.length > LIVE_ROUTE.maxPoints ? thinOlderHalf(coordinates) : coordinates,
    speedSamples: speedSamples.length > LIVE_ROUTE.maxSpeedSamples ? pairMeans(speedSamples) : speedSamples,
    topSpeed,
    estimatedDistance,
    currentSpeed,
  };
}

/** Every other point of the older half (the start and the recent half kept as they are) */
function thinOlderHalf<T>(points: T[]): T[] {
  const half = Math.floor(points.length / 2);
  const older = points.slice(0, half).filter((_, i) => i % 2 === 0);
  return [...older, ...points.slice(half)];
}

function pairMeans(samples: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < samples.length; i += 2) out.push((samples[i]! + samples[i + 1]!) / 2);
  // An odd one out keeps its place (and its weight is close enough)
  if (samples.length % 2) out.push(samples[samples.length - 1]!);
  return out;
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

/**
 * The live drive the screen is given (`publish`).  On screen, each accepted
 * fix is published as it comes.  Off screen (`setVisible(false)`), fixes are
 * held without publishing (no re-render, no route copy per fix), folded in
 * quietly every LIVE_ROUTE.maxHeldFixes, and published once when the app is
 * back on screen: the route catches up in one update, nothing is replayed.
 */
export class LiveDriveFeed {
  private drive: ActiveDrive | null = null;
  private held: GpsFix[] = [];
  /** Changes not yet published (held fixes, including ones already folded in) */
  private unpublished = false;
  private visible: boolean;
  private publishes = 0;

  constructor(private readonly publish: (drive: ActiveDrive | null) => void, visible = true) {
    this.visible = visible;
  }

  /** The drive as it stands, held fixes included (applied first). */
  get current(): ActiveDrive | null {
    this.fold();
    return this.drive;
  }

  /** How many times it has published (tests) */
  get publishCount(): number { return this.publishes; }
  get heldCount(): number { return this.held.length; }

  /** Replaces the drive (started, ended, picked up after a relaunch): published at once. */
  set(drive: ActiveDrive | null): void {
    this.held = [];
    this.drive = drive;
    this.emit();
  }

  /** Changes the drive from what it is now (held fixes applied first). */
  update(fn: (prev: ActiveDrive | null) => ActiveDrive | null): void {
    this.fold();
    this.set(fn(this.drive));
  }

  addFix(fix: GpsFix): void {
    if (!this.drive) return;
    if (this.visible) {
      this.drive = appendLiveFix(this.drive, fix);
      this.emit();
      return;
    }
    this.held.push(fix);
    this.unpublished = true;
    if (this.held.length >= LIVE_ROUTE.maxHeldFixes) this.fold();
  }

  /** The app came on screen (publish what was held) or left it (hold from now on). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible && this.unpublished) {
      this.fold();
      this.emit();
    }
  }

  private fold() {
    if (!this.held.length || !this.drive) { this.held = []; return; }
    this.drive = appendLiveFixes(this.drive, this.held);
    this.held = [];
  }

  private emit() {
    this.unpublished = false;
    this.publishes++;
    this.publish(this.drive);
  }
}

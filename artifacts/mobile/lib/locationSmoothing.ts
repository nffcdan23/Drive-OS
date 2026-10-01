// Visual smoothing for the Drive map's live position.
//
// GPS arrives about once a second.  Showing each fix as it lands makes the
// vehicle and map hop forward once a second; easing between fixes instead
// leaves the display a full fix behind the car.  This does what navigation
// apps do: between fixes it dead-reckons along the reported speed and course
// (so at steady speed the display sits where the car is now, not where it
// was), and when a fix lands it blends any disagreement away over a fraction
// of a second rather than snapping.
//
// This is display-only.  Raw fixes still go to drive recording and the rest
// of the data layer untouched; nothing here feeds back into them.
//
// Kept free of React Native imports so it can be unit-tested under node.

import { distanceForAltitude } from "./followCamera";

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface LocationFix extends LatLng {
  /** Ground speed in m/s, or null/negative when the device doesn't know */
  speed: number | null;
  /** Course over ground in degrees, or null/negative when unknown */
  course: number | null;
  /** Horizontal accuracy radius in metres */
  accuracy: number | null;
  /** When the fix was taken (ms, same clock as `now`) */
  time: number;
}

export const SMOOTHING = {
  // How quickly the display closes the gap to a new fix's track.  Short enough
  // that it never visibly trails the GPS, long enough to hide the correction.
  correctionTauMs: 450,
  // Dead reckoning runs at full speed for this long after a fix...
  extrapolateFullMs: 1200,
  // ...then eases to a stop over this long if no new fix arrives, so a late
  // or lost signal never shows the car driving on by itself indefinitely.
  extrapolateFadeMs: 1000,
  // Below this the car is treated as stopped and nothing is extrapolated
  stationarySpeedMs: 0.8,
  // A disagreement bigger than this is a relocation, not drift: snap to it
  snapDistanceM: 250,
  // Fix timestamps older than this (or from the future) are not trusted
  maxFixAgeMs: 2500,
  // While stopped, wander inside the fix's own accuracy radius (clamped to
  // this range) is ignored
  minJitterRadiusM: 3,
  maxJitterRadiusM: 10,
  // Below this the remaining correction is invisible and the display is still
  settledM: 0.02,
} as const;

const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

/** Metres east (x) and north (y) from `from` to `to` (local flat approximation) */
export function metersBetween(from: LatLng, to: LatLng): { x: number; y: number } {
  const cosLat = Math.cos(((from.latitude + to.latitude) / 2) * DEG);
  return {
    x: (to.longitude - from.longitude) * M_PER_DEG_LAT * cosLat,
    y: (to.latitude - from.latitude) * M_PER_DEG_LAT,
  };
}

/** `p` moved by x metres east and y metres north */
export function offsetMeters(p: LatLng, x: number, y: number): LatLng {
  const cosLat = Math.cos(p.latitude * DEG);
  return {
    latitude: p.latitude + y / M_PER_DEG_LAT,
    longitude: p.longitude + x / (M_PER_DEG_LAT * Math.max(cosLat, 1e-6)),
  };
}

/**
 * A map centre `meters` *ahead* of the vehicle along `headingDeg`.  In
 * heading-up mode ahead is up the screen, so the vehicle draws below the
 * centre and most of the view is road in front of it.
 */
export function lookAheadCenter(
  p: LatLng,
  headingDeg: number,
  meters: number,
): LatLng {
  if (meters === 0) return p;
  const ahead = headingDeg * DEG;
  return offsetMeters(p, meters * Math.sin(ahead), meters * Math.cos(ahead));
}

/**
 * Seconds of travel to extrapolate `elapsedMs` after a fix: real time up to
 * extrapolateFullMs, then a smooth deceleration to a stop (velocity stays
 * continuous, so the car never visibly brakes hard on a late fix).
 */
export function extrapolationSeconds(elapsedMs: number): number {
  const full = SMOOTHING.extrapolateFullMs;
  const fade = SMOOTHING.extrapolateFadeMs;
  if (elapsedMs <= 0) return 0;
  if (elapsedMs <= full) return elapsedMs / 1000;
  const u = Math.min((elapsedMs - full) / fade, 1);
  return (full + fade * (u - (u * u) / 2)) / 1000;
}

/** Frame-rate independent exponential approach of `current` toward `target` */
export function approach(
  current: number,
  target: number,
  dtMs: number,
  tauMs: number,
): number {
  if (tauMs <= 0) return target;
  return target + (current - target) * Math.exp(-Math.max(dtMs, 0) / tauMs);
}

/** Signed shortest angular difference target − current, in [-180, 180) */
export function angleDelta(current: number, target: number): number {
  return ((((target - current) % 360) + 540) % 360) - 180;
}

/** `approach` for angles in degrees, taking the short way round 0/360 */
export function approachAngle(
  current: number,
  target: number,
  dtMs: number,
  tauMs: number,
): number {
  // How far to turn this step: the share of the remaining turn covered
  const turned = approach(0, angleDelta(current, target), dtMs, tauMs);
  return (((current + turned) % 360) + 360) % 360;
}

/**
 * Turns ~1 Hz GPS fixes into a position that can be sampled every frame.
 *
 * Display position = (latest fix, projected forward along its velocity)
 *                  + (correction offset, decaying exponentially to zero).
 * The offset is whatever it takes to keep the display continuous at the
 * moment a fix arrives, so fixes never cause a jump, and it always decays,
 * so the display always converges back onto the GPS track.
 */
export class LocationSmoother {
  private base: LatLng | null = null;
  private baseTime = 0;
  private vx = 0; // m/s east
  private vy = 0; // m/s north
  private offsetX = 0; // m, at blendStart
  private offsetY = 0;
  private blendStart = 0;
  private lastRaw: { p: LatLng; time: number } | null = null;

  /** Whether the latest fix says the vehicle is moving */
  get isMoving(): boolean {
    return this.vx !== 0 || this.vy !== 0;
  }

  /**
   * Feeds a fix in.  `now` is the current time on the same clock as fix.time.
   * Returns what happened, mostly for tests: the first fix and relocations
   * snap, ordinary fixes blend, and stationary jitter is held.
   */
  addFix(fix: LocationFix, now: number): "snap" | "blend" | "held" {
    const time =
      fix.time <= now && now - fix.time <= SMOOTHING.maxFixAgeMs
        ? fix.time
        : now;
    const p = { latitude: fix.latitude, longitude: fix.longitude };
    const prevRaw = this.lastRaw;
    this.lastRaw = { p, time };

    const { vx, vy } = velocityFor(fix, p, time, prevRaw);

    if (!this.base) {
      this.setTrack(p, time, vx, vy, now, 0, 0);
      return "snap";
    }

    // Stopped, and the fix only wandered within its own noise: hold still.
    // Without this the parked car shuffles around as GPS settles.
    if (vx === 0 && vy === 0 && !this.isMoving) {
      const d = metersBetween(this.base, p);
      const radius = Math.min(
        Math.max(fix.accuracy ?? 0, SMOOTHING.minJitterRadiusM),
        SMOOTHING.maxJitterRadiusM,
      );
      if (Math.hypot(d.x, d.y) < radius) return "held";
    }

    // Keep the display exactly where it is right now; the new track takes
    // over through a decaying offset rather than a jump.
    const shown = this.sample(now)!;
    const projected = this.project(p, time, vx, vy, now);
    const gap = metersBetween(projected, shown);
    if (Math.hypot(gap.x, gap.y) > SMOOTHING.snapDistanceM) {
      this.setTrack(p, time, vx, vy, now, 0, 0);
      return "snap";
    }
    this.setTrack(p, time, vx, vy, now, gap.x, gap.y);
    return "blend";
  }

  /** The position to draw at `now`, or null before the first fix */
  sample(now: number): LatLng | null {
    if (!this.base) return null;
    const projected = this.project(this.base, this.baseTime, this.vx, this.vy, now);
    const decay = this.decay(now);
    if (decay === 0) return projected;
    return offsetMeters(projected, this.offsetX * decay, this.offsetY * decay);
  }

  /** True once the displayed position has stopped changing */
  isSettled(now: number): boolean {
    if (!this.base) return true;
    const correcting =
      Math.hypot(this.offsetX, this.offsetY) * this.decay(now) >
      SMOOTHING.settledM;
    const coasting =
      this.isMoving &&
      now - this.baseTime <
        SMOOTHING.extrapolateFullMs + SMOOTHING.extrapolateFadeMs;
    return !correcting && !coasting;
  }

  private setTrack(
    p: LatLng,
    time: number,
    vx: number,
    vy: number,
    now: number,
    offsetX: number,
    offsetY: number,
  ) {
    this.base = p;
    this.baseTime = time;
    this.vx = vx;
    this.vy = vy;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.blendStart = now;
  }

  private project(p: LatLng, time: number, vx: number, vy: number, now: number) {
    if (vx === 0 && vy === 0) return p;
    const s = extrapolationSeconds(now - time);
    return offsetMeters(p, vx * s, vy * s);
  }

  private decay(now: number): number {
    if (this.offsetX === 0 && this.offsetY === 0) return 0;
    return Math.exp(
      -Math.max(now - this.blendStart, 0) / SMOOTHING.correctionTauMs,
    );
  }
}

/**
 * Velocity for a fix.  Prefers the device's own speed and course (Doppler-
 * derived on iOS, far steadier than differencing positions), falling back to
 * the displacement since the previous fix for whichever is missing.
 */
function velocityFor(
  fix: LocationFix,
  p: LatLng,
  time: number,
  prev: { p: LatLng; time: number } | null,
): { vx: number; vy: number } {
  let speed = fix.speed != null && fix.speed >= 0 ? fix.speed : null;
  let course = fix.course != null && fix.course >= 0 ? fix.course : null;

  if ((speed == null || course == null) && prev) {
    const dt = (time - prev.time) / 1000;
    const d = metersBetween(prev.p, p);
    const dist = Math.hypot(d.x, d.y);
    if (speed == null && dt >= 0.2) speed = dist / dt;
    if (course == null && dist >= 1) {
      course = (Math.atan2(d.x, d.y) / DEG + 360) % 360;
    }
  }

  if (speed == null || course == null || speed < SMOOTHING.stationarySpeedMs) {
    return { vx: 0, vy: 0 };
  }
  return { vx: speed * Math.sin(course * DEG), vy: speed * Math.cos(course * DEG) };
}

// ─── Follow camera easing ────────────────────────────────────────────────────

export interface FollowCameraTarget {
  /** Smoothed vehicle position */
  position: LatLng;
  /** Map bearing to hold (the vehicle heading in heading-up, 0 in north-up) */
  heading: number;
  pitch: number;
  /** iOS camera distance, eye to centre (m), and Android zoom */
  distance: number;
  zoom: number;
  /** How far ahead of the vehicle the centre sits (0 in north-up) */
  lookAheadM: number;
}

export interface FollowCameraPose {
  center: LatLng;
  heading: number;
  pitch: number;
  distance: number;
  zoom: number;
}

/**
 * A camera to ease from: what the map reports (react-native-maps getCamera,
 * which gives altitude), or a pose this easer produced (which gives distance)
 */
export interface ReportedPose {
  center?: LatLng;
  heading?: number;
  pitch?: number;
  altitude?: number;
  distance?: number;
  zoom?: number;
}

export const CAMERA_EASING = {
  // Recentring (resume following) and bearing changes of mode
  offsetTauMs: 280,
  // Tilt in/out on entering follow and heading-mode switches (~95% in 0.8 s)
  pitchTauMs: 270,
  zoomTauMs: 270,
  lookAheadTauMs: 300,
  // Farther than this from the vehicle and easing over would just be a blur
  // across the map; jump instead
  maxEaseDistanceM: 3000,
  settledM: 0.05,
  settledDeg: 0.05,
} as const;

/**
 * The follow camera, stepped every frame.  At rest it is exactly the target
 * (vehicle position, smoothed heading), so steady following adds no lag of
 * its own.  Changes of state — resuming follow from wherever the user panned,
 * a drive starting or ending, switching heading mode — ease over a fraction
 * of a second instead of jumping or restarting a native animation.
 */
export class FollowCameraEaser {
  private seeded = false;
  private pitch = 0;
  private logDistance = 0;
  private zoom = 0;
  private lookAhead = 0;
  // Decaying offsets from the target, set when seeding from the live camera
  private headingOffset = 0;
  private centerX = 0;
  private centerY = 0;
  private last: FollowCameraPose | null = null;

  get isSeeded(): boolean {
    return this.seeded;
  }

  /** Forget the camera; the next follow must seed from the live map */
  reset(): void {
    this.seeded = false;
    this.last = null;
  }

  /** Starts easing from the camera the map is showing now */
  seed(current: ReportedPose, target: FollowCameraTarget): void {
    this.pitch = current.pitch ?? target.pitch;
    const distance =
      current.distance ??
      (current.altitude != null && current.altitude > 0
        ? distanceForAltitude(current.altitude, this.pitch)
        : target.distance);
    this.logDistance = Math.log(distance);
    this.zoom = current.zoom ?? target.zoom;
    this.lookAhead = target.lookAheadM;
    this.headingOffset =
      current.heading != null ? angleDelta(target.heading, current.heading) : 0;
    this.centerX = 0;
    this.centerY = 0;
    this.seeded = true;
    if (current.center) {
      const want = lookAheadCenter(
        target.position,
        target.heading + this.headingOffset,
        this.lookAhead,
      );
      const d = metersBetween(want, current.center);
      if (Math.hypot(d.x, d.y) <= CAMERA_EASING.maxEaseDistanceM) {
        this.centerX = d.x;
        this.centerY = d.y;
      }
    }
  }

  /**
   * The target jumped (heading mode switched): ease over from the camera last
   * shown instead of snapping to it
   */
  retarget(target: FollowCameraTarget): void {
    if (this.seeded && this.last) this.seed(this.last, target);
  }

  /** Advances by dtMs and returns the camera to show, or null if unseeded */
  step(
    target: FollowCameraTarget,
    dtMs: number,
  ): { pose: FollowCameraPose; settled: boolean } | null {
    if (!this.seeded) return null;
    const e = CAMERA_EASING;
    this.pitch = approach(this.pitch, target.pitch, dtMs, e.pitchTauMs);
    this.logDistance = approach(
      this.logDistance,
      Math.log(target.distance),
      dtMs,
      e.zoomTauMs,
    );
    this.zoom = approach(this.zoom, target.zoom, dtMs, e.zoomTauMs);
    this.lookAhead = approach(this.lookAhead, target.lookAheadM, dtMs, e.lookAheadTauMs);
    this.headingOffset = approach(this.headingOffset, 0, dtMs, e.offsetTauMs);
    this.centerX = approach(this.centerX, 0, dtMs, e.offsetTauMs);
    this.centerY = approach(this.centerY, 0, dtMs, e.offsetTauMs);

    const heading = (((target.heading + this.headingOffset) % 360) + 360) % 360;
    const center = offsetMeters(
      lookAheadCenter(target.position, heading, this.lookAhead),
      this.centerX,
      this.centerY,
    );
    // Report the target itself once there, not exp(log(x)) ≈ x
    const eased = Math.exp(this.logDistance);
    const distance =
      Math.abs(eased - target.distance) < e.settledM ? target.distance : eased;

    const settled =
      Math.abs(this.pitch - target.pitch) < e.settledDeg &&
      Math.abs(distance - target.distance) < e.settledM &&
      Math.abs(this.zoom - target.zoom) < 0.001 &&
      Math.abs(this.lookAhead - target.lookAheadM) < e.settledM &&
      Math.abs(this.headingOffset) < e.settledDeg &&
      Math.hypot(this.centerX, this.centerY) < e.settledM;
    if (settled) {
      // Land exactly, so a settled camera is the target and nothing drifts
      this.pitch = target.pitch;
      this.logDistance = Math.log(target.distance);
      this.zoom = target.zoom;
      this.lookAhead = target.lookAheadM;
      this.headingOffset = 0;
      this.centerX = 0;
      this.centerY = 0;
    }
    this.last = { center, heading, pitch: this.pitch, distance, zoom: this.zoom };
    return { pose: this.last, settled };
  }
}

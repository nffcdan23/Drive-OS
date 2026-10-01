// Zoom bookkeeping for the Drive map's follow camera.
//
// The follow camera always states its zoom outright, from a target that only
// changes when someone means it to: the user pinching the map, or the app
// deliberately resetting it (start of a drive, resume following).  It must
// never be re-derived from the camera the map reports back.  Apple Maps does
// not hand back exactly the altitude it was given (and reports mid-flight
// values when a compass rotation interrupts the previous one), so feeding the
// reported value into the next animation compounded a small outward error on
// every heading tick until the map had zoomed far out.
//
// Kept free of React Native imports so it can be unit-tested under node.

export type CameraPlatform = "ios" | "android" | "web" | "windows" | "macos";

export interface FollowZoom {
  /** Google zoom level, read by Android */
  zoom: number;
  /**
   * Apple Maps camera distance, eye to map centre, in metres.  Held instead of
   * altitude because altitude is eye height: the same altitude at a steeper
   * pitch puts the camera further away, and MapKit limits pitch by distance.
   */
  distance: number;
}

const DEG = Math.PI / 180;
// cos(pitch) floor, so a near-horizontal reading can't explode the distance
const MIN_COS = 0.1;

/** Eye height (what MapKit's camera.altitude means) for a distance and pitch */
export function altitudeForDistance(
  distance: number,
  pitchDeg: number,
): number {
  return distance * Math.max(Math.cos(pitchDeg * DEG), MIN_COS);
}

/** Camera distance for a reported altitude and pitch */
export function distanceForAltitude(
  altitude: number,
  pitchDeg: number,
): number {
  return altitude / Math.max(Math.cos(pitchDeg * DEG), MIN_COS);
}

export interface FollowCamera {
  center: { latitude: number; longitude: number };
  heading: number;
  pitch: number;
  zoom?: number;
  altitude?: number;
}

/** The camera as the map reports it after settling (react-native-maps getCamera) */
export interface ReportedCamera {
  zoom?: number;
  altitude?: number;
  pitch?: number;
}

/**
 * Builds a follow camera.  Position and heading come from the caller; the zoom
 * comes only from the held target.  iOS reads altitude (derived here from the
 * distance and pitch) and Android reads zoom, and setting both lets them
 * fight, so exactly one is stated.
 */
export function buildFollowCamera(
  center: { latitude: number; longitude: number },
  heading: number,
  pitch: number,
  target: FollowZoom,
  platform: CameraPlatform,
): FollowCamera {
  const camera: FollowCamera = { center, heading, pitch };
  if (platform === "ios") {
    camera.altitude = altitudeForDistance(target.distance, pitch);
  } else camera.zoom = target.zoom;
  return camera;
}

// How long after the user lifts their fingers the map may still be moving from
// their gesture (MapKit decelerates a fling or pinch for a moment).
export const GESTURE_SETTLE_MS = 1000;

/**
 * Holds the zoom the follow camera keeps.  Only a user gesture can move it
 * (besides explicit resets), so the app's own camera animations, which happen
 * on every location fix and compass tick, can never feed back into it.
 *
 * The gesture window doubles as the rule for when automatic follow updates may
 * animate: never while it is open, which both stops follow from fighting the
 * user's fingers and guarantees any camera that settles inside it is theirs.
 */
export class FollowZoomTarget {
  private target: FollowZoom;
  private touching = false;
  private lastGestureAt = -Infinity;

  constructor(initial: FollowZoom) {
    this.target = { ...initial };
  }

  get current(): FollowZoom {
    return { ...this.target };
  }

  /**
   * Sets the target outright, for deliberate resets and explicit zoom picks.
   * Takes a distance directly, or the altitude and pitch the map reported.
   */
  set(next: Partial<FollowZoom> & ReportedCamera): void {
    if (next.zoom != null && Number.isFinite(next.zoom)) {
      this.target.zoom = next.zoom;
    }
    const distance =
      next.distance ??
      (next.altitude != null
        ? distanceForAltitude(next.altitude, next.pitch ?? 0)
        : undefined);
    if (distance != null && Number.isFinite(distance) && distance > 0) {
      this.target.distance = distance;
    }
  }

  /** Fingers went down on the map */
  touchStart(now: number): void {
    this.touching = true;
    this.lastGestureAt = now;
  }

  /** The map reported a drag/pinch in progress */
  gestureMoved(now: number): void {
    this.lastGestureAt = now;
  }

  /** Fingers lifted; the map may coast for GESTURE_SETTLE_MS */
  touchEnd(now: number): void {
    this.touching = false;
    this.lastGestureAt = now;
  }

  /** A deliberate camera action (resume, locate) supersedes the gesture */
  clearGesture(): void {
    this.touching = false;
    this.lastGestureAt = -Infinity;
  }

  /** Whether the camera is currently the user's to move */
  gestureActive(now: number): boolean {
    return this.touching || now - this.lastGestureAt <= GESTURE_SETTLE_MS;
  }

  /**
   * Called when the map settles, with whether a gesture was active at that
   * moment and the camera it settled at.  Adopts the zoom only for a user
   * gesture; returns whether it did.
   */
  settle(fromGesture: boolean, reported: ReportedCamera): boolean {
    if (!fromGesture) return false;
    this.set(reported);
    return true;
  }
}

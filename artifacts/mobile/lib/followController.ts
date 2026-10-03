// The Drive map's follow camera, as one object with one rule: once follow
// mode is established, nothing read back from the map feeds into it.
//
// MapKit is read exactly once per entry into follow mode from a camera the
// user positioned (Continue Following, locate, a drive starting while the map
// was moved), to know where the ease-in starts.  From then on every value the
// camera shows comes from Derwent's own state: the target distance/zoom from
// the held FollowZoomTarget (set from NAV_CAMERA), the current eased values
// from the FollowCameraEaser, and heading/position from the caller.  Heading
// and position only ever move heading and centre; they can't reach distance,
// pitch or an in-progress transition.
//
// Reading the camera back repeatedly is what made the map zoom out a little on
// every heading change: MapKit reports a tilted camera's altitude in a way that
// doesn't round-trip exactly (and mid-flight while easing), and each read was
// converted to a distance and fed into the next frame, compounding.
//
// Kept free of React Native imports so it can be unit-tested under node.

import { FollowZoomTarget, type FollowZoom } from "./followCamera";
import {
  angleDelta,
  metersBetween,
  FollowCameraEaser,
  type FollowCameraPose,
  type FollowCameraTarget,
  type ReportedPose,
} from "./locationSmoothing";

/** A follow target without scale: distance and zoom are the controller's */
export type FollowFrameTarget = Omit<FollowCameraTarget, "distance" | "zoom">;

/**
 * Telling a tilt from exploring.  react-native-maps doesn't say which gesture
 * moved the map, and MapKit's tilt (a two-finger vertical drag) also fires its
 * pan callback, so the gesture is judged by what it did to the camera,
 * against a reading taken as it began.
 */
export const FOLLOW_GESTURE = {
  // The centre moving more than this is a pan (metres, or a share of the
  // camera distance when zoomed out)
  panM: 10,
  panShareOfDistance: 0.02,
  // The bearing turning more than this is a rotation
  rotateDeg: 3,
  // The scale changing more than this is a pinch.  Judged on both the raw
  // altitude and altitude/cos(pitch): a pure tilt keeps one of them steady
  // whichever way MapKit reports a tilted camera's altitude, a pinch moves both
  zoomRatio: 0.1,
  // Smaller tilt changes are noise, not a choice
  pitchDeg: 0.5,
  // The follow pitch the user can pick
  minPitchDeg: 0,
  maxPitchDeg: 75,
} as const;

export type FollowGesture = "none" | "pitch" | "explore";

const DEG = Math.PI / 180;
const cosDeg = (d: number) => Math.max(Math.cos(d * DEG), 0.1);

/** What a gesture has done so far, from the camera at its start and now */
export function classifyFollowGesture(
  start: ReportedPose,
  now: ReportedPose,
): FollowGesture {
  const g = FOLLOW_GESTURE;
  const p0 = start.pitch ?? 0;
  const p1 = now.pitch ?? 0;
  if (start.center && now.center) {
    const d = metersBetween(start.center, now.center);
    const distance = start.altitude != null ? start.altitude / cosDeg(p0) : 0;
    if (
      Math.hypot(d.x, d.y) > Math.max(g.panM, distance * g.panShareOfDistance)
    ) {
      return "explore";
    }
  }
  if (start.heading != null && now.heading != null) {
    if (Math.abs(angleDelta(start.heading, now.heading)) > g.rotateDeg)
      return "explore";
  }
  if (start.altitude != null && now.altitude != null && start.altitude > 0) {
    const raw = now.altitude / start.altitude;
    const dist = now.altitude / cosDeg(p1) / (start.altitude / cosDeg(p0));
    if (Math.abs(raw - 1) > g.zoomRatio && Math.abs(dist - 1) > g.zoomRatio)
      return "explore";
  }
  // Mapbox reports zoom rather than altitude; its zoom doesn't change with
  // tilt, so any change past the same 10% scale is a pinch
  if (
    start.zoom != null &&
    now.zoom != null &&
    Math.abs(now.zoom - start.zoom) > Math.log2(1 + g.zoomRatio)
  ) {
    return "explore";
  }
  return Math.abs(p1 - p0) > g.pitchDeg ? "pitch" : "none";
}

export type FollowFrame =
  /** Draw this camera */
  | { kind: "camera"; pose: FollowCameraPose; settled: boolean }
  /** The user's fingers are on the map: write nothing */
  | { kind: "paused" }
  /** Entering follow from a user-positioned map: read its camera once */
  | { kind: "needsSeed" };

export class FollowCameraController {
  /** The single authoritative follow distance/zoom, plus gesture tracking */
  readonly zoom: FollowZoomTarget;
  private readonly easer = new FollowCameraEaser();
  // Bumped whenever follow mode is left, so a camera read that was in flight
  // for an earlier entry can never land on a later one
  private epoch = 0;
  private seedingEpoch: number | null = null;
  private paused = false;
  // The tilt the user picked by tilting the map while following.  Replaces
  // the navigation pitch for the rest of the session, through Continue
  // Following too.  Null until they do.
  private userPitch: number | null = null;

  constructor(initial: FollowZoom, limits?: { min: number; max: number }) {
    this.zoom = new FollowZoomTarget(initial, limits);
  }

  get isSeeded(): boolean {
    return this.easer.isSeeded;
  }

  /**
   * The camera target for a frame: caller's position/heading, our scale, and
   * the user's chosen tilt wherever the camera tilts at all (a flat target,
   * north-up or satellite, stays flat)
   */
  private full(t: FollowFrameTarget): FollowCameraTarget {
    const z = this.zoom.current;
    const pitch =
      t.pitch > 0 && this.userPitch != null ? this.userPitch : t.pitch;
    return { ...t, pitch, distance: z.distance, zoom: z.zoom };
  }

  /** The follow pitch the user picked, or null for the navigation default */
  get followPitch(): number | null {
    return this.userPitch;
  }

  /**
   * The user tilted the map without leaving follow mode: that tilt becomes the
   * follow pitch.  Distance, heading and position are untouched.
   */
  setUserPitch(pitch: number): void {
    if (!Number.isFinite(pitch)) return;
    const p = Math.min(
      Math.max(pitch, FOLLOW_GESTURE.minPitchDeg),
      FOLLOW_GESTURE.maxPitchDeg,
    );
    this.userPitch = p;
    this.easer.setPitch(p);
  }

  /**
   * Follow mode was entered (or re-asserted).  Already following: carry on
   * from our own state, so an in-progress transition is never restarted.
   * Otherwise start over, easing from `live` if the caller already has the
   * map's camera, or reading it on the next frame.
   */
  enter(
    wasFollowing: boolean,
    live?: ReportedPose,
    target?: FollowFrameTarget,
  ): void {
    if (wasFollowing && this.easer.isSeeded) return;
    this.leave();
    if (live && target) this.easer.seed(live, this.full(target));
  }

  /** Follow mode ended (the user moved the map): forget the camera */
  leave(): void {
    this.epoch++;
    this.seedingEpoch = null;
    this.paused = false;
    this.easer.reset();
  }

  /**
   * The target jumped for a reason other than heading or position (heading
   * mode switched): ease over from the camera last drawn, our own state
   */
  retarget(target: FollowFrameTarget): void {
    this.easer.retarget(this.full(target));
  }

  /** Starts the one camera read for this entry; null if none is needed */
  beginSeed(): number | null {
    if (this.easer.isSeeded || this.seedingEpoch === this.epoch) return null;
    this.seedingEpoch = this.epoch;
    return this.epoch;
  }

  /**
   * The read finished.  Applied only if it belongs to the current entry and
   * nothing has started the ease since; a late or stale read is dropped.
   * `live` is {} when the read failed (the ease then starts at the target).
   */
  completeSeed(
    token: number,
    live: ReportedPose,
    target: FollowFrameTarget | null,
  ): boolean {
    if (token !== this.epoch || this.seedingEpoch !== token) return false;
    this.seedingEpoch = null;
    if (this.easer.isSeeded || !target) return false;
    this.easer.seed(live, this.full(target));
    return true;
  }

  /** One frame of following */
  frame(
    target: FollowFrameTarget,
    dtMs: number,
    gestureActive: boolean,
  ): FollowFrame {
    if (gestureActive) {
      // Write nothing while fingers are down.  If the user moves the map that
      // ends follow mode (leave()); if they only tapped, the map is still
      // where we last put it, so we resume from our own last pose.
      this.paused = true;
      return { kind: "paused" };
    }
    if (!this.easer.isSeeded) return { kind: "needsSeed" };
    const full = this.full(target);
    if (this.paused) {
      this.paused = false;
      this.easer.retarget(full);
    }
    const step = this.easer.step(full, dtMs)!;
    return { kind: "camera", pose: step.pose, settled: step.settled };
  }
}

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
  FollowCameraEaser,
  type FollowCameraPose,
  type FollowCameraTarget,
  type ReportedPose,
} from "./locationSmoothing";

/** A follow target without scale: distance and zoom are the controller's */
export type FollowFrameTarget = Omit<FollowCameraTarget, "distance" | "zoom">;

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

  constructor(initial: FollowZoom, limits?: { min: number; max: number }) {
    this.zoom = new FollowZoomTarget(initial, limits);
  }

  get isSeeded(): boolean {
    return this.easer.isSeeded;
  }

  /** The camera target for a frame: caller's position/heading, our scale */
  private full(t: FollowFrameTarget): FollowCameraTarget {
    const z = this.zoom.current;
    return { ...t, distance: z.distance, zoom: z.zoom };
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

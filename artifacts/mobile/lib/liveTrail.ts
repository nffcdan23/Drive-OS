// The live end of the drive trail, for display only.
//
// The recorded trail is drawn from raw GPS fixes, which arrive about once a
// second, so on its own it stops up to a second's travel short of the arrow and
// jumps forward a step at a time.  This adds a short temporary "head" from the
// last recorded fix to wherever the arrow is drawn now: the path the arrow has
// actually travelled since that fix (thinned to a point every few metres, so
// bends follow the road rather than cutting the corner), ending exactly at the
// arrow's current position.  When the next fix is recorded, it becomes the
// trail's new end and the head starts again from there.
//
// None of this is recorded.  Saved journeys, uploads and distance all come
// from the raw fixes; the head lives only in memory while a drive is active.
//
// Kept free of React Native imports so it can be unit-tested under node.

import { metersBetween, type LatLng } from "./locationSmoothing";

export const LIVE_TRAIL = {
  // Arrow positions closer together than this aren't added to the head's trace
  traceStepM: 3,
  // Longest trace kept: a lost signal can't grow the head without limit
  maxTracePoints: 120,
  // How often the head is redrawn.  Each redraw rebuilds a small map overlay,
  // so this is kept just high enough to look continuous.
  redrawIntervalMs: 33,
} as const;

const dist = (a: LatLng, b: LatLng) => {
  const d = metersBetween(a, b);
  return Math.hypot(d.x, d.y);
};

export class LiveTrailHead {
  private anchor: LatLng | null = null;
  private trace: LatLng[] = [];

  /** A raw fix was recorded (and drawn as the trail's newest point) */
  recordedPoint(p: LatLng): void {
    this.anchor = { latitude: p.latitude, longitude: p.longitude };
    this.trace = [];
  }

  /**
   * The arrow is drawn at `position` this frame.  Returns the head to draw:
   * last recorded fix → the arrow's path since → `position`, or null when
   * there is no recorded fix to start from yet.
   */
  frame(position: LatLng): LatLng[] | null {
    if (!this.anchor) return null;
    const last = this.trace[this.trace.length - 1] ?? this.anchor;
    if (dist(last, position) >= LIVE_TRAIL.traceStepM) {
      this.trace.push({
        latitude: position.latitude,
        longitude: position.longitude,
      });
      if (this.trace.length > LIVE_TRAIL.maxTracePoints) this.trace.shift();
    }
    const head = [this.anchor, ...this.trace];
    const end = head[head.length - 1]!;
    if (
      end.latitude !== position.latitude ||
      end.longitude !== position.longitude
    ) {
      head.push({ latitude: position.latitude, longitude: position.longitude });
    }
    return head;
  }

  /** The drive ended (or a new one began): forget the head entirely */
  reset(): void {
    this.anchor = null;
    this.trace = [];
  }
}

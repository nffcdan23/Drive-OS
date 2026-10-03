// The live end of the drive trail, for display only.
//
// The recorded trail is drawn from raw GPS fixes, which arrive about once a
// second, so on its own it stops up to a second's travel short of the arrow and
// jumps forward a step at a time.  This adds a short temporary "head" from the
// trail's last recorded point to wherever the arrow is drawn now: the path the
// arrow has actually travelled since that point (thinned to a point every few
// metres, so bends follow the road rather than cutting the corner), ending
// exactly at the arrow's current position.  When the trail gains a point, that
// becomes the head's new start and the head starts again from there.
//
// None of this is recorded.  Saved journeys, uploads and distance all come
// from the raw fixes; the head lives only in memory while a drive is active.
// The same head is drawn on either map (Apple Maps or Mapbox).
//
// Kept free of React Native imports so it can be unit-tested under node.

import { metersBetween, type LatLng } from "./locationSmoothing";

export const LIVE_TRAIL = {
  // Arrow positions closer together than this aren't added to the head's trace
  traceStepM: 3,
  // Longest trace kept: a lost signal can't grow the head without limit
  maxTracePoints: 120,
  // How often the head is redrawn.  Each redraw replaces a small map overlay
  // (or Mapbox source), so this is kept just high enough to look continuous.
  redrawIntervalMs: 33,
} as const;

/** What a frame should do about the head on the map */
export type LiveTrailUpdate =
  /** Draw this head (null: draw none) */
  | { kind: "draw"; head: LatLng[] | null }
  /** What's drawn is current */
  | { kind: "idle" }
  /** A redraw is owed but held back by the redraw interval: keep the frames coming */
  | { kind: "wait" };

const IDLE: LiveTrailUpdate = { kind: "idle" };
const WAIT: LiveTrailUpdate = { kind: "wait" };

const dist = (a: LatLng, b: LatLng) => {
  const d = metersBetween(a, b);
  return Math.hypot(d.x, d.y);
};
const same = (a: LatLng, b: LatLng) =>
  a.latitude === b.latitude && a.longitude === b.longitude;

export class LiveTrailHead {
  private anchor: LatLng | null = null;
  private trace: LatLng[] = [];
  // What update() last had drawn: where the head ended, whether one shows,
  // and whether it has to be redrawn whatever the position (a new start)
  private drawnEnd: LatLng | null = null;
  private visible = false;
  private stale = true;
  private drawnAt = -Infinity;

  /** A raw fix was recorded (and drawn as the trail's newest point) */
  recordedPoint(p: LatLng): void {
    this.anchor = { latitude: p.latitude, longitude: p.longitude };
    this.trace = [];
    this.stale = true;
  }

  /**
   * The trail as drawn now: the head starts from its last point.  Following
   * the drawn trail (not the screen's own fixes) keeps the two joined when a
   * fix is thinned away, or the trail's newest point came from background
   * tracking.  Returns true when the head starts somewhere new.
   */
  followTrail(trail: readonly LatLng[]): boolean {
    const last = trail[trail.length - 1];
    if (!last || (this.anchor && same(this.anchor, last))) return false;
    this.recordedPoint(last);
    return true;
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
    if (!same(end, position)) {
      head.push({ latitude: position.latitude, longitude: position.longitude });
    }
    return head;
  }

  /**
   * One display frame.  `position` is where the arrow (or Mapbox's puck) is
   * drawn this frame; `active` is false while no head should show (not
   * driving, paused, passenger).  Redraws at most every redrawIntervalMs, and
   * only when the head's end or start has moved; a redraw held back by the
   * interval is reported as "wait", so the head always catches up with where
   * the arrow came to rest.
   */
  update(
    position: LatLng | null,
    active: boolean,
    now: number,
  ): LiveTrailUpdate {
    if (!active || !position) {
      if (!this.visible) return IDLE;
      this.visible = false;
      this.drawnEnd = null;
      return { kind: "draw", head: null };
    }
    if (!this.stale && this.drawnEnd && same(this.drawnEnd, position)) {
      return IDLE;
    }
    if (now - this.drawnAt < LIVE_TRAIL.redrawIntervalMs) return WAIT;
    this.drawnAt = now;
    this.stale = false;
    this.drawnEnd = {
      latitude: position.latitude,
      longitude: position.longitude,
    };
    const head = this.frame(position);
    if (!head && !this.visible) return IDLE;
    this.visible = head != null;
    return { kind: "draw", head };
  }

  /**
   * The drive ended (or a new one began, or it was paused): forget the head
   * entirely.  The caller clears what's drawn.
   */
  reset(): void {
    this.anchor = null;
    this.trace = [];
    this.drawnEnd = null;
    this.visible = false;
    this.stale = true;
  }
}

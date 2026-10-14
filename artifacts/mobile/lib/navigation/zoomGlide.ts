// The guidance camera's zoom, glided rather than switched.
//
// Guidance picks its zoom in a few bands (guidanceCamera.ts: speed, and
// closer approaching a turn), so the target zoom changes in steps; the
// follow camera then eased to each new zoom in well under a second and held
// there, which read as zoom, stop, zoom. This moves the zoom the camera is
// given toward guidance's choice gradually, every frame: a first-order
// glide (GLIDE.tauMs) capped at GLIDE.maxRatePerS zoom levels a second,
// which the camera's own short ease then rounds off at the start. A change
// of band takes two or three seconds; nothing ever jumps.
//
// It writes only while moving: once settled, the camera's zoom is left alone
// (a pinch while following stays until guidance next changes its mind).
//
// No React Native imports, so it is unit-tested under node.

export const GLIDE = {
  tauMs: 700,
  /** Never faster than this (zoom levels a second) */
  maxRatePerS: 0.35,
  /** Closer than this (zoom levels) is there */
  settled: 0.005,
} as const;

export class ZoomGlide {
  private value: number | null = null;
  private target: number | null = null;

  get current(): number | null {
    return this.value;
  }

  get settled(): boolean {
    return this.value == null || this.target == null || this.value === this.target;
  }

  /** Jumps straight to `zoom` (guidance starting, Recenter): nothing to glide */
  reset(zoom: number | null): void {
    this.value = zoom;
    this.target = zoom;
  }

  /** Guidance's new zoom, to glide to */
  setTarget(zoom: number): void {
    if (!Number.isFinite(zoom)) return;
    if (this.value == null) this.value = zoom;
    this.target = zoom;
  }

  /** One frame: the zoom to give the camera, or null when there is nothing to write */
  step(dtMs: number): number | null {
    if (this.value == null || this.target == null || this.value === this.target) return null;
    const gap = this.target - this.value;
    const dt = Math.max(0, dtMs);
    let move = gap * (1 - Math.exp(-dt / GLIDE.tauMs));
    const cap = (GLIDE.maxRatePerS * dt) / 1000;
    if (Math.abs(move) > cap) move = Math.sign(move) * cap;
    this.value += move;
    if (Math.abs(this.target - this.value) < GLIDE.settled) this.value = this.target;
    return this.value;
  }
}

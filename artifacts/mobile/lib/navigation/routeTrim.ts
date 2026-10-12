// The navigation route line, consumed smoothly behind the arrow.
//
// The map draws the whole prepared route once (per route: a reroute brings a
// new one) and hides the part already driven with Mapbox's line trim
// (`lineTrimOffset`, a fraction of the line), so following the car costs one
// number per update, never a new line. The route itself is never changed.
//
// Where the line starts: just behind the arrow as it is drawn this frame
// (the Drive screen's frame loop hands over the same smoothed position it
// gives the arrow), found on the route near navigation's confirmed progress.
// GPS progress moves once a second; the arrow glides between fixes (dead-
// reckoned, lib/locationSmoothing.ts), so following progress alone left the
// line trailing behind the arrow and then jumping forward. Bounded so it can
// never run away from navigation:
//  - never more than ROUTE_TRIM.maxAheadM beyond the confirmed progress (the
//    arrow's own dead reckoning stays well inside that);
//  - always ROUTE_TRIM.behindM behind the arrow, so it starts under it;
//  - only ever forwards on a route (GPS jitter or the arrow easing back after
//    a fix never brings driven road back);
//  - an arrow that isn't near the route (off route) moves nothing.
// Updated when the start has moved ROUTE_TRIM.minStepM and at most every
// ROUTE_TRIM.minIntervalMs: about 15 small steps a second at speed, nothing
// while stopped, and nothing off screen (the frame loop doesn't run there).
//
// Mapbox measures a line's progress on the Web Mercator plane, not in
// metres, so the fraction is worked out in projected length (per route, once).
//
// No React Native imports, so it is unit-tested under node.

import type { LatLng } from './model';
import { segmentAt, type PreparedRoute } from './routeProgress';

export const ROUTE_TRIM = {
  /** The line starts this far behind the arrow (m): under it, never ahead */
  behindM: 5,
  /** Never more than this beyond navigation's confirmed progress (m) */
  maxAheadM: 40,
  /** The arrow is looked for this far behind the confirmed progress (m) */
  searchBackM: 30,
  /** An arrow further than this from the route line (m) is not on it */
  maxLateralM: 35,
  /** Redrawn once the start has moved this far (m)… */
  minStepM: 1,
  /** …and at most this often (ms): every 4th frame at 60 Hz, every 8th at 120 Hz */
  minIntervalMs: 60,
} as const;

const M_PER_DEG = (6_371_000 * Math.PI) / 180;
const D2R = Math.PI / 180;

/** Mercator y of a latitude (radians of the projected plane) */
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * D2R) / 2));

export class RouteLineTrim {
  /** Cumulative Web Mercator length at each route point */
  private readonly merc: Float64Array;
  private confirmed: number | null = null;
  /** Where the drawn line starts now (m along the route) */
  private start = 0;
  private drawnStart = 0;
  private drawnAt = -Infinity;
  /** Positions looked at (for tests) */
  scans = 0;

  constructor(readonly prepared: PreparedRoute) {
    const p = prepared;
    const merc = new Float64Array(p.n);
    for (let i = 1; i < p.n; i++) {
      const dx = (p.lng[i]! - p.lng[i - 1]!) * D2R;
      const dy = mercY(p.lat[i]!) - mercY(p.lat[i - 1]!);
      merc[i] = merc[i - 1]! + Math.hypot(dx, dy);
    }
    this.merc = merc;
  }

  /** Navigation's progress (m along this route), on each fix it commits */
  confirm(along: number): void {
    if (Number.isFinite(along)) this.confirmed = Math.min(Math.max(along, 0), this.prepared.total);
  }

  /** Where the drawn line starts (m along the route) */
  get startAlong(): number {
    return this.start;
  }

  /** The share of the line (Web Mercator length) before `along`: what lineTrimOffset hides */
  fractionAt(along: number): number {
    const p = this.prepared;
    const total = this.merc[p.n - 1]!;
    if (!(total > 0) || along <= 0) return 0;
    if (along >= p.total) return 1;
    const i = segmentAt(p, along);
    const len = p.segLen[i]!;
    const t = len > 0 ? Math.min(Math.max((along - p.cum[i]!) / len, 0), 1) : 0;
    const m = this.merc[i]! + t * (this.merc[i + 1]! - this.merc[i]!);
    return Math.min(Math.max(m / total, 0), 1);
  }

  /**
   * The arrow drawn at `arrow` at `now`: the new trim fraction when the line
   * should be redrawn, else null.
   */
  frame(arrow: LatLng | null, now: number): number | null {
    const base = this.confirmed;
    if (base == null) return null;
    const at = arrow ? this.alongNear(arrow, base) : null;
    if (at != null) {
      const target = Math.min(at, base + ROUTE_TRIM.maxAheadM, this.prepared.total) - ROUTE_TRIM.behindM;
      if (target > this.start) this.start = target;
    }
    const moved = this.start - this.drawnStart;
    const first = this.drawnAt === -Infinity;
    if (!first && (moved < ROUTE_TRIM.minStepM || now - this.drawnAt < ROUTE_TRIM.minIntervalMs)) return null;
    if (first && this.start <= 0) {
      this.drawnAt = now;
      return 0;
    }
    this.drawnStart = this.start;
    this.drawnAt = now;
    return this.fractionAt(this.start);
  }

  /** Where `pos` lies along the route, looked for close to `base`; null if not near it */
  private alongNear(pos: LatLng, base: number): number | null {
    const p = this.prepared;
    const from = segmentAt(p, Math.max(0, base - ROUTE_TRIM.searchBackM));
    const to = segmentAt(p, Math.min(p.total, base + ROUTE_TRIM.maxAheadM + ROUTE_TRIM.searchBackM));
    let best: number | null = null;
    let bestLateral: number = ROUTE_TRIM.maxLateralM;
    for (let i = from; i <= to; i++) {
      this.scans++;
      const cs = p.segCos[i]!;
      const px = (pos.longitude - p.lng[i]!) * cs * M_PER_DEG;
      const py = (pos.latitude - p.lat[i]!) * M_PER_DEG;
      const dx = p.segDx[i]!;
      const dy = p.segDy[i]!;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const lateral = Math.hypot(px - t * dx, py - t * dy);
      if (lateral <= bestLateral) {
        bestLateral = lateral;
        best = p.cum[i]! + t * p.segLen[i]!;
      }
    }
    return best;
  }
}

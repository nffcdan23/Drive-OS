// The navigation speed HUD's number: the car's speed from the newest real
// GPS fix navigation was given (the Drive screen's accepted fixes, or the
// background task's), never a route-snapped or map-derived speed.
//
// A fix without a speed (iOS reports -1 when it has none), an implausible
// one, or one older than SPEED_HUD.freshMs shows "--", never a false 0.
//
// No React Native imports, so it is unit-tested under node.

import { convertSpeed, msToKmh, type ResolvedUnitSystem } from '../units';

export const SPEED_HUD = {
  /** A fix older than this (ms) no longer says how fast the car is going */
  freshMs: 10_000,
  /** How often a fix that stopped coming is checked for staleness (ms) */
  recheckMs: 1_000,
  /** Faster than this (m/s, ~200 mph) is a bad reading */
  maxSpeedMs: 90,
} as const;

export interface SpeedFix {
  speedMs: number | null;
  timestamp: number;
}

/** The whole number to show (mph or km/h), or null for "--" */
export function hudSpeed(fix: SpeedFix | null, now: number, system: ResolvedUnitSystem): number | null {
  if (!fix || fix.speedMs == null || !Number.isFinite(fix.speedMs)) return null;
  if (fix.speedMs < 0 || fix.speedMs > SPEED_HUD.maxSpeedMs) return null;
  const age = now - fix.timestamp;
  if (!Number.isFinite(age) || age > SPEED_HUD.freshMs) return null;
  return Math.round(convertSpeed(msToKmh(fix.speedMs), system));
}

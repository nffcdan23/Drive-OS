// The recording screen's figures as shown: the drive time with its units
// label, and the distance in the user's units. No React Native imports.

import { KM_PER_MILE, distanceUnit, type ResolvedUnitSystem } from './units';

/** "0:09" with "m : s", or "1:02:09" with "h : m : s" */
export function driveTimeParts(totalSeconds: number): { value: string; units: string } {
  const sec = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  if (h > 0) return { value: `${h}:${String(m).padStart(2, '0')}:${s}`, units: 'h : m : s' };
  return { value: `${m}:${s}`, units: 'm : s' };
}

/** Distance from km: two decimals under 10, one above (e.g. "0.00" mi, "12.4" km) */
export function distanceParts(km: number, system: ResolvedUnitSystem): { value: string; units: string } {
  const safe = Math.max(0, Number.isFinite(km) ? km : 0);
  const n = system === 'imperial' ? safe / KM_PER_MILE : safe;
  return { value: n < 10 ? n.toFixed(2) : n.toFixed(1), units: distanceUnit(system) };
}

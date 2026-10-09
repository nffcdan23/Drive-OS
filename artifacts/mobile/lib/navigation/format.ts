// How a route preview reads: journey time, distance and arrival time.
//
// No React Native imports, so it is unit-tested under node.

import { formatShortDistance, type ResolvedUnitSystem } from '../units';

/** "45 min", "1 hr 5 min", "2 hr"; under a minute is "1 min" */
export function formatDuration(seconds: number): string {
  const total = Math.max(1, Math.round((Number.isFinite(seconds) ? seconds : 0) / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** A route's length: yards when short, then miles (or metres, then km) */
export function formatRouteDistance(metres: number, system: ResolvedUnitSystem): string {
  return formatShortDistance(Math.max(0, metres), system);
}

/** When the drive would end, leaving now */
export function arrivalTime(now: number, durationS: number): Date {
  return new Date(now + Math.max(0, durationS) * 1000);
}

/** "14:05": the arrival clock time, 24-hour as UK road signs and sat-navs show it */
export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "via A591, M6", or null when the provider named no main roads */
export function formatVia(summary: string): string | null {
  const s = summary.trim();
  return s ? `via ${s}` : null;
}

/** A guidance distance, sat-nav style (lib/units does the converting) */
export { formatGuidanceDistance } from '../units';

/** Close enough to the manoeuvre (m) to say "Now" instead of a distance */
export const NOW_WITHIN_M = 15;

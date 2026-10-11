// Reporting a hazard from the phone: which position may be sent, and what
// the driver is told afterwards. The server checks the same things again
// (and owns everything else); this lets the sheet say so at once, offline
// included, instead of pretending a report went.
//
// No React Native imports, so it is unit-tested under node.

import { msToKmh } from '../units';
import type { HazardKind } from './model';

/** The Drive screen's latest accepted GPS fix: the raw position, never a route-snapped one */
export interface ReportFix {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  /** When the phone took it (ms) */
  timestamp: number;
  /** The GPS speed (m/s) and course (degrees; negative = none): only to judge the direction of travel, never sent */
  speedMs?: number | null;
  headingDeg?: number | null;
}

/**
 * When the direction of travel goes with a report (0021): only from a GPS
 * course that can be trusted. Below about 15 km/h the course wanders (and
 * standing still it is meaningless), and an old or vague fix says little.
 */
export const REPORT_HEADING = { minSpeedKmh: 15, maxAgeMs: 10_000, maxAccuracyM: 30 } as const;

/** The driver's direction of travel to send with a report, or null (sent as nothing) */
export function reportHeading(fix: ReportFix | null, now: number): number | null {
  if (!fix) return null;
  const h = fix.headingDeg;
  if (h == null || !Number.isFinite(h) || h < 0 || h >= 360) return null;
  if (fix.speedMs == null || !Number.isFinite(fix.speedMs) || msToKmh(fix.speedMs) < REPORT_HEADING.minSpeedKmh) return null;
  if (now - fix.timestamp > REPORT_HEADING.maxAgeMs || fix.timestamp - now > REPORT_HEADING.maxAgeMs) return null;
  if (fix.accuracyM == null || fix.accuracyM > REPORT_HEADING.maxAccuracyM) return null;
  return h;
}

/** The same limits as the API (artifacts/api-server/src/lib/hazards.ts) */
export const REPORT_FIX = { maxAgeMs: 2 * 60_000, maxAccuracyM: 75 } as const;

export type ReportFixProblem = 'no_fix' | 'stale_fix' | 'inaccurate_fix';

export function reportFixProblem(fix: ReportFix | null, now: number): ReportFixProblem | null {
  if (!fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return 'no_fix';
  if (now - fix.timestamp > REPORT_FIX.maxAgeMs) return 'stale_fix';
  if (fix.accuracyM != null && fix.accuracyM > REPORT_FIX.maxAccuracyM) return 'inaccurate_fix';
  return null;
}

export const FIX_PROBLEM_MESSAGE: Record<ReportFixProblem, string> = {
  no_fix: "Waiting for your location. The report wasn't sent.",
  stale_fix: "Your location is out of date. The report wasn't sent.",
  inaccurate_fix: "Your location isn't accurate enough yet. The report wasn't sent.",
};

/**
 * The request body (POST /hazards): the fix as taken, with when it was
 * taken, and the direction of travel only when reliable (otherwise the field
 * is left out, exactly as before). Never the speed, a route or a journey.
 */
export function reportBody(kind: HazardKind, fix: ReportFix, now = Date.now()) {
  const headingDeg = reportHeading(fix, now);
  return {
    kind,
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyM: fix.accuracyM,
    capturedAt: new Date(fix.timestamp).toISOString(),
    ...(headingDeg != null ? { headingDeg } : {}),
  };
}

/** What the driver is told once the server has it */
export function reportedMessage(outcome: string): string {
  if (outcome === 'merged') return 'Already reported here. Your report confirms it.';
  if (outcome === 'already_reported') return "You've already reported this.";
  return 'Reported. Thanks.';
}

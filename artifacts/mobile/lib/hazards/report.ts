// Reporting a hazard from the phone: which position may be sent, and what
// the driver is told afterwards. The server checks the same things again
// (and owns everything else); this lets the sheet say so at once, offline
// included, instead of pretending a report went.
//
// No React Native imports, so it is unit-tested under node.

import type { HazardKind } from './model';

/** The Drive screen's latest accepted GPS fix: the raw position, never a route-snapped one */
export interface ReportFix {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  /** When the phone took it (ms) */
  timestamp: number;
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

/** The request body (POST /hazards): the fix as taken, with when it was taken */
export function reportBody(kind: HazardKind, fix: ReportFix) {
  return {
    kind,
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyM: fix.accuracyM,
    capturedAt: new Date(fix.timestamp).toISOString(),
  };
}

/** What the driver is told once the server has it */
export function reportedMessage(outcome: string): string {
  if (outcome === 'merged') return 'Already reported here. Your report confirms it.';
  if (outcome === 'already_reported') return "You've already reported this.";
  return 'Reported. Thanks.';
}

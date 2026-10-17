// Save Point while recording: the spot the car is at now, kept as a private
// saved place (Places, synced like any other). The position is the newest
// accepted GPS fix, held to the same freshness and accuracy limits as a
// hazard report, so a point is never saved somewhere the car wasn't.

import { reportFixProblem, type ReportFix, type ReportFixProblem } from './hazards/report';

export const SAVE_POINT_MESSAGE: Record<ReportFixProblem, string> = {
  no_fix: "Waiting for your location. The point wasn't saved.",
  stale_fix: "Your location is out of date. The point wasn't saved.",
  inaccurate_fix: "Your location isn't accurate enough yet. The point wasn't saved.",
};

/** Why a point can't be saved at this fix, or null when it can */
export function savePointProblem(fix: ReportFix | null, now: number): string | null {
  const problem = reportFixProblem(fix, now);
  return problem ? SAVE_POINT_MESSAGE[problem] : null;
}

/** "Saved point 14:05", in the phone's local time */
export function savePointName(now: number): string {
  const d = new Date(now);
  return `Saved point ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

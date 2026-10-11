/**
 * Road hazards (migration 0020): the request rules that sit in front of the
 * database functions. The database owns everything that must hold however
 * many API instances run (lifetimes, merging, one vote per person, removal,
 * the per-person limits); this file only checks what a request may ask for
 * and turns the database's outcomes into HTTP answers.
 *
 * No Express or database imports, so it is unit-tested on its own.
 */

/** The kinds a driver can report. The database's road_hazards_kind check is the authority. */
export const HAZARD_KINDS = ["accident", "hazard", "broken_down", "roadworks", "flooding", "police"] as const;
export type HazardKind = (typeof HAZARD_KINDS)[number];

export const HAZARD_VOTES = ["still_there", "not_there"] as const;
export type HazardVote = (typeof HAZARD_VOTES)[number];

/** A fix less accurate than this (metres) is too vague to mark a hazard with. */
export const MAX_REPORT_ACCURACY_M = 75;
/** A fix older than this (by the phone's clock) is not where the hazard is now: no stale queued reports. */
export const MAX_REPORT_FIX_AGE_MS = 2 * 60_000;

/** The largest area the map may ask for at once, in degrees (the database enforces the same). */
export const MAX_VIEW_LAT_SPAN = 1.0;
export const MAX_VIEW_LNG_SPAN = 1.6;

/** 5 decimal places, about a metre. */
export const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

export interface ViewArea {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** Why an area can't be served, or null when it can. */
export function viewAreaProblem(a: ViewArea): string | null {
  const values = [a.minLat, a.minLng, a.maxLat, a.maxLng];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return "invalid_area";
  if (a.minLat < -90 || a.maxLat > 90 || a.minLng < -180 || a.maxLng > 180) return "invalid_area";
  if (a.maxLat <= a.minLat || a.maxLng <= a.minLng) return "invalid_area";
  if (a.maxLat - a.minLat > MAX_VIEW_LAT_SPAN || a.maxLng - a.minLng > MAX_VIEW_LNG_SPAN) return "area_too_large";
  return null;
}

/** Why a reporter's fix can't be used, or null when it can. */
export function reportFixProblem(fix: { accuracyM?: number | null; capturedAt?: Date | null }, now = Date.now()): string | null {
  if (fix.accuracyM != null && fix.accuracyM > MAX_REPORT_ACCURACY_M) return "inaccurate_fix";
  if (fix.capturedAt) {
    const age = now - fix.capturedAt.getTime();
    if (age > MAX_REPORT_FIX_AGE_MS || age < -MAX_REPORT_FIX_AGE_MS) return "stale_fix";
  }
  return null;
}

export type ReportOutcome = "created" | "merged" | "already_reported" | "rate_limited";
export type VoteOutcome = "counted" | "already_voted" | "own_report" | "not_found" | "rate_limited";

export interface Answer {
  status: number;
  code?: string;
  message?: string;
}

/** private.report_hazard's outcome as an HTTP answer. */
export function reportAnswer(outcome: string): Answer {
  switch (outcome as ReportOutcome) {
    case "created": return { status: 201 };
    case "merged": return { status: 200 };
    case "already_reported": return { status: 200 };
    case "rate_limited":
      return { status: 429, code: "hazard_rate_limited", message: "You've reported a lot of hazards recently. Try again later." };
    default: return { status: 500, code: "unexpected_outcome" };
  }
}

/** private.vote_hazard's outcome as an HTTP answer. */
export function voteAnswer(outcome: string): Answer {
  switch (outcome as VoteOutcome) {
    case "counted": return { status: 200 };
    case "already_voted": return { status: 409, code: "already_voted", message: "You've already said whether this is still there." };
    case "own_report": return { status: 409, code: "own_report", message: "You reported this one." };
    case "not_found": return { status: 404, code: "hazard_gone", message: "This report has expired or been cleared." };
    case "rate_limited": return { status: 429, code: "hazard_rate_limited", message: "Too many updates recently. Try again later." };
    default: return { status: 500, code: "unexpected_outcome" };
  }
}

/** What a driver may know about their own relation to a hazard (never anyone else's). */
export type MyHazardVote = "reported" | "still_there" | "not_there" | null;

export function presentHazard(json: Record<string, unknown>, myVote: string | null): Record<string, unknown> {
  // Only the fields the map shows, whatever the database adds later
  const { id, kind, latitude, longitude, reportedAt, lastConfirmedAt, expiresAt, expiresInMs, confirmations } = json;
  const mine: MyHazardVote = myVote === "reported" || myVote === "still_there" || myVote === "not_there" ? myVote : null;
  return { id, kind, latitude, longitude, reportedAt, lastConfirmedAt, expiresAt, expiresInMs, confirmations, myVote: mine };
}

import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireUser } from "../middleware/auth";
import { badRequest, handler, HttpError, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first, type Tx } from "../lib/userDb";
import { rateLimit } from "../lib/rateLimit";
import {
  HAZARD_KINDS,
  HAZARD_VOTES,
  presentHazard,
  reportAnswer,
  reportFixProblem,
  round5,
  viewAreaProblem,
  voteAnswer,
} from "../lib/hazards";

/**
 * Live road hazards (migration 0020).
 *
 * Reporting, merging, votes, lifetimes, removal and the per-person limits are
 * decided by the database functions private.report_hazard,
 * private.vote_hazard and private.hazards_in_view, so they hold however many
 * API instances run. The in-memory limits below only absorb bursts.
 *
 * Anonymous: no response ever says who reported or voted on a hazard; a
 * driver learns only their own vote. Coordinates travel in request bodies
 * (never URLs) and are never logged.
 */
const router = Router();

const listLimit = rateLimit({ name: "hazard map", windowMs: 60_000, max: 60 });
const reportLimit = rateLimit({ name: "hazard report", windowMs: 60_000, max: 6 });
const voteLimit = rateLimit({ name: "hazard update", windowMs: 60_000, max: 30 });

/**
 * A database error from a statement carrying a position would carry the
 * coordinates too (the driver includes bound parameters in its message), and
 * unexpected errors are logged: keep only the error code.
 */
async function withoutValues<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const code = (err as { code?: unknown; cause?: { code?: unknown } })?.cause?.code ?? (err as { code?: unknown })?.code;
    const safe = new Error(`hazard query failed (${typeof code === "string" ? code : "unknown"})`);
    if (typeof code === "string") Object.assign(safe, { code });
    throw safe;
  }
}

function answer(a: { status: number; code?: string; message?: string }): void {
  if (a.status >= 400) throw new HttpError(a.status, a.code ?? "error", a.message);
}

interface Row {
  hazard: Record<string, unknown> | null;
  my_vote: string | null;
}

/** One hazard as the caller may see it: null once expired or removed. */
async function hazardFor(tx: Tx, userId: string, id: string) {
  const row = first<Row>(await tx.execute(sql`
    select private.hazard_public_json(h) as hazard,
           (select v.vote from public.road_hazard_votes v where v.hazard_id = h.id and v.user_id = ${userId}) as my_vote
      from public.road_hazards h
     where h.id = ${id} and h.expires_at > now() and h.removed_at is null`));
  return row?.hazard ? presentHazard(row.hazard, row.my_vote) : null;
}

// POST /api/hazards/in-view — active hazards in a map area, nearest its
// centre first (at most 200). Body: { minLat, minLng, maxLat, maxLng }, at
// most 1° × 1.6° (about 110 km). Each comes with the caller's own vote.
router.post("/hazards/in-view", requireUser, listLimit, handler(async (req, res) => {
  const b = Body.of(req);
  const area = {
    minLat: b.num("minLat")!, minLng: b.num("minLng")!, maxLat: b.num("maxLat")!, maxLng: b.num("maxLng")!,
  };
  const problem = viewAreaProblem(area);
  if (problem === "area_too_large") throw badRequest(problem, "That map area is too large.");
  if (problem) throw badRequest(problem, "That map area is not valid.");
  const rows = await withoutValues(asUser(req.userId, async (tx) => (await tx.execute(sql`
    select hazard, my_vote from private.hazards_in_view(
      ${req.userId}, ${area.minLat}, ${area.minLng}, ${area.maxLat}, ${area.maxLng}, 200)`)).rows as unknown as Row[]));
  res.json(rows.filter((r) => r.hazard).map((r) => presentHazard(r.hazard!, r.my_vote)));
}));

// POST /api/hazards — report a hazard where the driver is now.
//   kind        accident | hazard | broken_down | roadworks | flooding | police
//   latitude, longitude   the phone's current accepted GPS fix (not a
//                         route-snapped point)
//   accuracyM   optional; a fix vaguer than 75 m is refused
//   capturedAt  optional; a fix older than 2 minutes is refused (no stale
//               reports sent long after the fact)
// 201 created, or 200 when it confirmed one already there (outcome "merged",
// or "already_reported" if this driver had already reported or confirmed it).
router.post("/hazards", requireUser, reportLimit, handler(async (req, res) => {
  const b = Body.of(req);
  const kind = b.oneOf("kind", HAZARD_KINDS)!;
  const latitude = round5(b.num("latitude", { min: -90, max: 90 })!);
  const longitude = round5(b.num("longitude", { min: -180, max: 180 })!);
  const accuracyM = b.num("accuracyM", { optional: true, nullable: true, min: 0, max: 100_000 }) ?? null;
  const capturedAt = b.timestamp("capturedAt", { optional: true }) ?? null;
  const problem = reportFixProblem({ accuracyM, capturedAt });
  if (problem === "inaccurate_fix") throw new HttpError(422, problem, "Your location isn't accurate enough to report a hazard.");
  if (problem) throw new HttpError(422, problem, "That location is too old to report a hazard with.");

  const result = await withoutValues(asUser(req.userId, async (tx) => {
    const r = first<{ hazard_id: string | null; outcome: string }>(await tx.execute(sql`
      select hazard_id, outcome from private.report_hazard(${req.userId}, ${kind}, ${latitude}, ${longitude})`))!;
    const a = reportAnswer(r.outcome);
    answer(a);
    return { status: a.status, outcome: r.outcome, hazard: r.hazard_id ? await hazardFor(tx, req.userId, r.hazard_id) : null };
  }));
  res.status(result.status).json({ outcome: result.outcome, hazard: result.hazard });
}));

// POST /api/hazards/:id/vote — { vote: still_there | not_there }. One vote
// per driver per hazard, final; not on your own report; not on an expired or
// cleared one. Answers the hazard as it is now (null if this vote cleared it).
router.post("/hazards/:id/vote", requireUser, voteLimit, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const vote = Body.of(req).oneOf("vote", HAZARD_VOTES)!;
  const result = await withoutValues(asUser(req.userId, async (tx) => {
    const r = first<{ outcome: string }>(await tx.execute(sql`select private.vote_hazard(${req.userId}, ${id}, ${vote}) as outcome`))!;
    answer(voteAnswer(r.outcome));
    return { outcome: r.outcome, hazard: await hazardFor(tx, req.userId, id) };
  }));
  res.json(result);
}));

export default router;

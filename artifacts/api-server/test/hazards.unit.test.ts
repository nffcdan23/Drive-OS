// Road hazard request rules (src/lib/hazards.ts): no database, no network.
// The database rules themselves (merging, votes, lifetimes, limits) are in
// supabase/tests/local/20_rls_security.sql; the routes end to end in api.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HAZARD_KINDS,
  MAX_REPORT_ACCURACY_M,
  presentHazard,
  reportAnswer,
  reportFixProblem,
  round5,
  viewAreaProblem,
  voteAnswer,
} from "../src/lib/hazards.ts";

test("hazards: the six kinds, matching the database's check", async () => {
  assert.deepEqual([...HAZARD_KINDS], ["accident", "hazard", "broken_down", "roadworks", "flooding", "police"]);
  const { readFileSync } = await import("node:fs");
  const migration = readFileSync(new URL("../../../supabase/migrations/20261011000100_road_hazards.sql", import.meta.url), "utf8");
  const check = /constraint road_hazards_kind\s+check \(kind in \(([^)]*)\)\)/.exec(migration)?.[1];
  assert.deepEqual(check?.split(",").map((s) => s.trim().replace(/'/g, "")), [...HAZARD_KINDS]);
});

test("hazards: a map area must be real and at most about 110 km across", () => {
  assert.equal(viewAreaProblem({ minLat: 54.4, minLng: -3.2, maxLat: 54.6, maxLng: -2.9 }), null);
  assert.equal(viewAreaProblem({ minLat: 54, minLng: -3.8, maxLat: 55, maxLng: -2.2 }), null, "exactly the limit");
  assert.equal(viewAreaProblem({ minLat: 54, minLng: -3, maxLat: 55.2, maxLng: -2.5 }), "area_too_large");
  assert.equal(viewAreaProblem({ minLat: 54, minLng: -4, maxLat: 54.5, maxLng: -2 }), "area_too_large");
  assert.equal(viewAreaProblem({ minLat: 54.6, minLng: -3, maxLat: 54.4, maxLng: -2.9 }), "invalid_area", "inverted");
  assert.equal(viewAreaProblem({ minLat: 54.4, minLng: -3, maxLat: 54.4, maxLng: -2.9 }), "invalid_area", "empty");
  assert.equal(viewAreaProblem({ minLat: 89.5, minLng: 0, maxLat: 91, maxLng: 1 }), "invalid_area", "off the globe");
  assert.equal(viewAreaProblem({ minLat: Number.NaN, minLng: 0, maxLat: 1, maxLng: 1 }), "invalid_area");
});

test("hazards: only a current, accurate fix can mark a hazard (no stale queued reports)", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(reportFixProblem({}, now), null, "accuracy and time are optional");
  assert.equal(reportFixProblem({ accuracyM: 8, capturedAt: new Date(now - 5_000) }, now), null);
  assert.equal(reportFixProblem({ accuracyM: MAX_REPORT_ACCURACY_M + 1 }, now), "inaccurate_fix");
  assert.equal(reportFixProblem({ capturedAt: new Date(now - 3 * 60_000) }, now), "stale_fix", "three minutes old");
  assert.equal(reportFixProblem({ capturedAt: new Date(now - 6 * 3600_000) }, now), "stale_fix", "hours old");
  assert.equal(reportFixProblem({ capturedAt: new Date(now + 10 * 60_000) }, now), "stale_fix", "from the future");
  assert.equal(round5(54.1234567), 54.12346);
  assert.equal(round5(-3.000004), -3);
});

test("hazards: the database's outcomes become stable HTTP answers", () => {
  assert.deepEqual(reportAnswer("created"), { status: 201 });
  assert.deepEqual(reportAnswer("merged"), { status: 200 });
  assert.deepEqual(reportAnswer("already_reported"), { status: 200 });
  assert.equal(reportAnswer("rate_limited").status, 429);
  assert.equal(reportAnswer("rate_limited").code, "hazard_rate_limited");
  assert.equal(reportAnswer("nonsense").status, 500);
  assert.deepEqual(voteAnswer("counted"), { status: 200 });
  assert.equal(voteAnswer("already_voted").status, 409);
  assert.equal(voteAnswer("own_report").code, "own_report");
  assert.equal(voteAnswer("not_found").status, 404);
  assert.equal(voteAnswer("not_found").code, "hazard_gone");
  assert.equal(voteAnswer("rate_limited").status, 429);
});

test("hazards: a hazard as a driver sees it — the map's fields and their own vote, nothing else", () => {
  const db = {
    id: "h1", kind: "accident", latitude: 54.5, longitude: -3, reportedAt: "a", lastConfirmedAt: "b", expiresAt: "c",
    expiresInMs: 1000, confirmations: 2, reporterId: "someone", support: 3, dismissals: 1,
  };
  const out = presentHazard(db, "still_there");
  assert.deepEqual(Object.keys(out).sort(), ["confirmations", "expiresAt", "expiresInMs", "id", "kind", "lastConfirmedAt", "latitude", "longitude", "myVote", "reportedAt"]);
  assert.equal(out.myVote, "still_there");
  assert.equal(presentHazard(db, "something else").myVote, null);
  assert.equal(presentHazard(db, null).myVote, null);
});

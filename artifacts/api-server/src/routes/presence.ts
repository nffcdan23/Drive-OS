import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireUser } from "../middleware/auth";
import { badRequest, handler } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first, type Tx } from "../lib/userDb";
import { rateLimit } from "../lib/rateLimit";
import type { PresenceStatus } from "../lib/presence";

const router = Router();
// The app sends a heartbeat about once a minute, plus one per state change.
const heartbeatLimit = rateLimit({ name: "presence", windowMs: 60_000, max: 30 });

interface PresenceRow {
  app_state: "foreground" | "background" | "signed_out";
  driving: boolean;
  journey_id: string | null;
  last_seen_at: Date | string;
  status: PresenceStatus;
}

function present(r: PresenceRow | undefined) {
  if (!r) return { status: "offline" as const, appState: null, driving: false, journeyId: null, lastSeenAt: null };
  return {
    status: r.status,
    appState: r.app_state,
    driving: r.driving,
    journeyId: r.journey_id,
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  };
}

async function load(tx: Tx, userId: string) {
  return first<PresenceRow>(await tx.execute(sql`
    select app_state, driving, journey_id, last_seen_at,
           private.presence_status(app_state, driving, last_seen_at) as status
    from public.user_presence where user_id = ${userId}`));
}

// GET /api/me/presence — your own presence, as friends see it
router.get("/me/presence", requireUser, handler(async (req, res) => {
  res.json(present(await asUser(req.userId, (tx) => load(tx, req.userId))));
}));

// PUT /api/me/presence — heartbeat and state changes
//   appState   foreground | background | signed_out (required)
//   driving    true while a drive is being recorded; omitted = unchanged
//   journeyId  the server journey being recorded, if known (it may not exist
//              yet when the drive started offline); omitted = unchanged
// last_seen_at is always the server's clock, never the phone's.
router.put("/me/presence", requireUser, heartbeatLimit, handler(async (req, res) => {
  const b = Body.of(req);
  const appState = b.oneOf("appState", ["foreground", "background", "signed_out"] as const)!;
  const drivingIn = b.bool("driving", { optional: true });
  const journeyIn = b.uuid("journeyId", { optional: true, nullable: true });

  const row = await asUser(req.userId, async (tx) => {
    const prev = first<{ driving: boolean; journey_id: string | null }>(await tx.execute(sql`
      select driving, journey_id from public.user_presence where user_id = ${req.userId} for update`));

    // Signing out ends everything, whatever else was sent.
    const signedOut = appState === "signed_out";
    const driving = signedOut ? false : drivingIn ?? prev?.driving ?? false;
    if (journeyIn != null && !driving && !signedOut) throw badRequest("invalid_input", "journeyId: only while driving");
    const journeyId = !driving ? null : journeyIn === undefined ? (prev?.journey_id ?? null) : journeyIn;
    if (journeyId && journeyId !== prev?.journey_id) {
      const own = first(await tx.execute(sql`
        select 1 from public.journeys where id = ${journeyId} and owner_id = ${req.userId} and status = 'active'`));
      if (!own) throw badRequest("invalid_journey", "Not one of your drives in progress.");
    }

    await tx.execute(sql`
      insert into public.user_presence (user_id, app_state, driving, journey_id, last_seen_at)
      values (${req.userId}, ${appState}, ${driving}, ${journeyId}, now())
      on conflict (user_id) do update
        set app_state = excluded.app_state, driving = excluded.driving,
            journey_id = excluded.journey_id, last_seen_at = now()`);
    return load(tx, req.userId);
  });
  res.json(present(row));
}));

export default router;

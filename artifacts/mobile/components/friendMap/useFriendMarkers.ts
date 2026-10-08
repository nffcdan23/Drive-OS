// The data side of the friend-marker layer, shared by both map providers:
// the shared positions (Phase 4A's store, nothing else), who each sharer is,
// and how a marker glides between updates. Kept out of the Drive screen so a
// live update re-renders only the layer and the one marker that moved.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useSharedLocations } from "@/context/AppContext";
import {
  MOVE_TWEEN_MS,
  STALE_AFTER_MS,
  buildMarkerModels,
  initialsOf,
  shouldTween,
  tweenPoint,
  type FriendMarkerModel,
  type LatLngPoint,
  type SharerIdentity,
} from "@/lib/liveMap";

/** Re-check staleness this often (only while someone is sharing). */
const STALE_CHECK_MS = 15_000;
/** Look up Convoy members' names at most this often. */
const CONVOY_LOOKUP_EVERY_MS = 60_000;

/**
 * Names and avatars for sharers, from what the app already has: friends,
 * and (for someone visible only through a Convoy) the participants of
 * Convoys this user is in. Never a lookup by user id.
 */
export function useSharerIdentities(sharerIds: readonly string[]): ReadonlyMap<string, SharerIdentity> {
  const { friends, convoys, loadConvoyParticipants } = useApp();
  const [convoyMembers, setConvoyMembers] = useState<ReadonlyMap<string, SharerIdentity>>(new Map());
  const lastLookup = useRef(0);

  const known = useMemo(() => {
    const m = new Map<string, SharerIdentity>(convoyMembers);
    for (const f of friends) m.set(f.id, { name: f.name, initials: f.initials, avatarUrl: f.avatarUrl ?? null });
    return m;
  }, [friends, convoyMembers]);

  const missing = sharerIds.some((id) => !known.has(id));
  useEffect(() => {
    if (!missing || Date.now() - lastLookup.current < CONVOY_LOOKUP_EVERY_MS) return;
    const mine = convoys.filter((c) => c.isJoined && (c.status === "forming" || c.status === "active"));
    if (!mine.length) return;
    lastLookup.current = Date.now();
    let cancelled = false;
    void Promise.allSettled(mine.map((c) => loadConvoyParticipants(c.id))).then((results) => {
      if (cancelled) return;
      const next = new Map<string, SharerIdentity>();
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        for (const p of r.value) next.set(p.id, { name: p.name, initials: p.initials || initialsOf(p.name) });
      }
      setConvoyMembers(next);
    });
    return () => { cancelled = true; };
  }, [missing, convoys, loadConvoyParticipants]);

  return known;
}

/** One model per shared position, recomputed when positions, names or staleness change. */
export function useFriendMarkerModels(): FriendMarkerModel[] {
  const locations = useSharedLocations();
  const ids = useMemo(() => locations.map((l) => l.userId), [locations]);
  const identities = useSharerIdentities(ids);
  // Staleness is re-checked on a slow tick (only while someone is sharing)
  // and whenever positions change; nothing else depends on the clock.
  const [tick, setTick] = useState(0);
  const hasAny = locations.length > 0;
  useEffect(() => {
    if (!hasAny) return;
    const t = setInterval(() => setTick((n) => n + 1), STALE_CHECK_MS);
    return () => clearInterval(t);
  }, [hasAny]);
  return useMemo(
    () => buildMarkerModels(locations, identities, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locations, identities, tick],
  );
}

/**
 * A marker's drawn position: placed at once the first time (or after a big
 * jump), otherwise glided over MOVE_TWEEN_MS so it doesn't snap. Updated at
 * about 20 fps during the glide only; nothing runs between updates.
 */
export function useGlidedPosition(target: LatLngPoint): LatLngPoint {
  const [drawn, setDrawn] = useState(target);
  const drawnRef = useRef<LatLngPoint | null>(null);
  const frame = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (frame.current != null) clearTimeout(frame.current);
    frame.current = null;
  }, []);

  useEffect(() => {
    stop();
    const from = drawnRef.current;
    if (!shouldTween(from, target)) {
      drawnRef.current = target;
      setDrawn(target);
      return;
    }
    const start = Date.now();
    const step = () => {
      const t = (Date.now() - start) / MOVE_TWEEN_MS;
      const p = tweenPoint(from!, target, t);
      drawnRef.current = p;
      setDrawn(p);
      frame.current = t < 1 ? setTimeout(step, 50) : null;
    };
    step();
    return stop;
    // A new target is a new latitude/longitude pair, not a new object
  }, [target.latitude, target.longitude]);

  return drawn;
}

export { STALE_AFTER_MS };

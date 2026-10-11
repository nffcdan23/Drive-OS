/**
 * Live road hazards (migration 0020) for the signed-in driver: the hazards
 * near them (HazardStore, in memory only), kept current by HazardFeed while
 * the app is on screen, and the two things a driver can do: report one where
 * they are, or say whether one is still there.
 *
 * Realtime: the feed joins the hazard area topics (`hazards:<lat>:<lng>`,
 * 0.5° cells) around the driver as private channels. The database lets any
 * signed-in user receive on them and nobody publish; each message is an
 * anonymous hazard. This is the same Realtime client and token as the
 * private inbox (lib/realtimePresence); the inbox itself is untouched.
 *
 * Reports are never queued: one that can't be sent says so and is dropped.
 * Nothing about where the driver is or what they reported is logged.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { ep, supabase } from "@/lib/backendClient";
import { ApiError, describeError } from "@/lib/backend/http";
import { journal } from "@/lib/diagnostics";
import { HazardFeed, type HazardChannelStatus } from "@/lib/hazards/feed";
import { parseHazard, type HazardKind, type RoadHazard } from "@/lib/hazards/model";
import { FIX_PROBLEM_MESSAGE, reportBody, reportedMessage, reportFixProblem, type ReportFix } from "@/lib/hazards/report";
import { HazardStore } from "@/lib/hazards/store";

interface HazardsValue {
  store: HazardStore;
  /** The running feed (null before it starts, or without a backend) */
  feed: React.RefObject<HazardFeed | null>;
}

const HazardsContext = createContext<HazardsValue | null>(null);

/** A report or vote that didn't happen, with what to tell the driver */
export class HazardActionError extends Error {}

export function HazardsProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const store = useMemo(() => new HazardStore(), [userId]);
  const feedRef = useRef<HazardFeed | null>(null);

  // Created and stopped by the same effect (so a remount starts a fresh one)
  useEffect(() => {
    if (!ep || !supabase) return;
    const api = ep;
    const client = supabase;
    const feed = new HazardFeed({
      store,
      load: async (area) => {
        const receivedAt = Date.now();
        const raw = await api.hazardsInView(area);
        return (Array.isArray(raw) ? raw : []).map((h) => parseHazard(h, receivedAt)).filter((h): h is RoadHazard => h != null);
      },
      openTopics: async (topics, { onEvent, onStatus }) => {
        // A current token first (refreshed if it expired in the background)
        const { data } = await client.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("not signed in");
        await client.realtime.setAuth(token);
        const joined = new Set<string>();
        let reported: HazardChannelStatus | null = null;
        // supabase.channel() returns an existing channel for the same topic:
        // remove any left over first, so there is only ever one
        for (const old of client.getChannels()) {
          if (topics.some((topic) => old.topic === `realtime:${topic}`)) await client.removeChannel(old);
        }
        const channels = topics.map((topic) => {
          const channel = client.channel(topic, { config: { private: true } });
          channel.on("broadcast", { event: "hazard" }, (message) => onEvent(message.payload));
          channel.subscribe((status) => {
            if (status === "SUBSCRIBED") {
              joined.add(topic);
              // One "subscribed" once every area is joined
              if (joined.size === topics.length && reported !== "subscribed") {
                reported = "subscribed";
                onStatus("subscribed");
              }
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
              joined.delete(topic);
              if (reported !== "error") {
                reported = "error";
                onStatus(status === "CLOSED" ? "closed" : "error");
              }
            }
          });
          return channel;
        });
        return { close: () => { for (const c of channels) void client.removeChannel(c); } };
      },
      log: __DEV__ ? (message) => console.log(`[hazards] ${message}`) : undefined,
    });
    feedRef.current = feed;
    const sub = AppState.addEventListener("change", (s) => feed.setActive(s !== "background"));
    feed.setActive(AppState.currentState !== "background");
    return () => {
      sub.remove();
      feed.stop();
      if (feedRef.current === feed) feedRef.current = null;
    };
  }, [store]);

  const value = useMemo(() => ({ store, feed: feedRef }), [store]);
  return <HazardsContext.Provider value={value}>{children}</HazardsContext.Provider>;
}

function useHazardsValue(): HazardsValue {
  const v = useContext(HazardsContext);
  if (!v) throw new Error("Hazards hooks must be used inside HazardsProvider");
  return v;
}

/** The store itself (stable), for the map layer to read without re-rendering the screen */
export function useHazardStore(): HazardStore {
  return useHazardsValue().store;
}

/** The hazards near the driver; re-renders the caller (only) when they change */
export function useHazardList(): readonly RoadHazard[] {
  const { store } = useHazardsValue();
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribe(fn), [store]),
    () => store.list,
  );
}

/** The hazard whose card is open, if any */
export function useSelectedHazard(): RoadHazard | null {
  const { store } = useHazardsValue();
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribe(fn), [store]),
    () => store.selected,
  );
}

export function useHazardActions() {
  const { store, feed } = useHazardsValue();

  /** The Drive screen's accepted fixes: loads hazards only when needed (never per fix) */
  const notePosition = useCallback((lat: number, lng: number) => feed.current?.notePosition(lat, lng), [feed]);

  const select = useCallback((id: string | null) => store.select(id), [store]);

  /** Reports at the driver's current fix. Resolves with what to tell them; throws HazardActionError. */
  const report = useCallback(async (kind: HazardKind, fix: ReportFix | null): Promise<string> => {
    const problem = reportFixProblem(fix, Date.now());
    if (problem) {
      journal.log("hazard_report", { kind, outcome: problem });
      throw new HazardActionError(FIX_PROBLEM_MESSAGE[problem]);
    }
    if (!ep) throw new HazardActionError("Reporting isn't available right now.");
    try {
      const receivedAt = Date.now();
      const res = await ep.reportHazard(reportBody(kind, fix!));
      const hazard = parseHazard(res.hazard, receivedAt);
      if (hazard) store.upsertOwn(hazard.id, hazard);
      journal.log("hazard_report", { kind, outcome: res.outcome });
      return reportedMessage(res.outcome);
    } catch (err) {
      journal.log("hazard_report", { kind, outcome: err instanceof ApiError ? err.code : "network" });
      throw new HazardActionError(
        err instanceof ApiError ? err.message : `${describeError(err)} The report wasn't sent.`,
      );
    }
  }, [store]);

  /** "Still there" / "Not there". Throws HazardActionError with what to tell the driver. */
  const vote = useCallback(async (id: string, choice: "still_there" | "not_there"): Promise<void> => {
    if (!ep) throw new HazardActionError("This isn't available right now.");
    try {
      const receivedAt = Date.now();
      const res = await ep.voteHazard(id, choice);
      store.upsertOwn(id, res.hazard ? parseHazard(res.hazard, receivedAt) : null);
      journal.log("hazard_vote", { vote: choice, outcome: res.outcome });
    } catch (err) {
      journal.log("hazard_vote", { vote: choice, outcome: err instanceof ApiError ? err.code : "network" });
      if (err instanceof ApiError && err.code === "hazard_gone") store.upsertOwn(id, null);
      throw new HazardActionError(err instanceof ApiError ? err.message : describeError(err));
    }
  }, [store]);

  return { notePosition, select, report, vote };
}

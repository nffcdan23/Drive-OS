/**
 * The turn-by-turn banner at the top of the Drive screen while navigating
 * (Navigation Phase 3): the next manoeuvre's arrow, how far to it, what to do
 * in Mapbox's en-GB words, the junction and signposts, a "then" for one
 * straight after, and the road the car is on.
 *
 * It reads the navigation state itself, so its updates on every GPS fix
 * re-render this banner only, never the Drive screen. Off route it says so
 * and offers Update Route (one tap, one request); it never reroutes itself.
 */
import React, { memo, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassSurface } from "@/components/Glass";
import { ARRIVAL_ICON, ManeuverIcon } from "@/components/navigation/ManeuverIcon";
import { useNavigationState, useRerouteNavigation } from "@/context/NavigationContext";
import { formatGuidanceDistance, NOW_WITHIN_M } from "@/lib/navigation/format";
import type { Maneuver } from "@/lib/navigation/maneuver";
import type { ResolvedUnitSystem } from "@/lib/units";

const FG = "#F3F5F7";
const MUTED = "rgba(243,245,247,0.68)";
const ACCENT = "#00CFE8";
const WARN = "#F5B73B";

/** "Junction 36 · Keswick", from the manoeuvre's own signage */
function signage(m: Maneuver): string | null {
  const parts = [m.junctionRef ? `Junction ${m.junctionRef}` : null, m.signposts].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const Status = memo(function Status({ icon, text, busy }: { icon?: keyof typeof Ionicons.glyphMap; text: string; busy?: boolean }) {
  return (
    <View style={styles.statusRow}>
      {busy ? <ActivityIndicator size="small" color={MUTED} /> : icon ? <Ionicons name={icon} size={15} color={MUTED} /> : null}
      <Text style={styles.statusText} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
});

export function GuidanceBanner({
  unitSystem,
  onHeight,
}: {
  unitSystem: ResolvedUnitSystem;
  /** The banner's height (for laying out what sits below it) */
  onHeight?: (height: number) => void;
}) {
  const state = useNavigationState();
  const reroute = useRerouteNavigation();
  const [problem, setProblem] = useState<string | null>(null);
  const key = state.phase === "idle" ? null : state.sessionId;
  useEffect(() => setProblem(null), [key]);
  if (state.phase === "idle") return null;

  const layout = onHeight ? (e: LayoutChangeEvent) => onHeight(e.nativeEvent.layout.height) : undefined;
  const updateRoute = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setProblem(null);
    reroute().catch((err: unknown) => setProblem(err instanceof Error ? err.message : "Couldn't find where you are."));
  };

  if (state.phase === "arrived" || state.phase === "error") {
    const arrived = state.phase === "arrived";
    return (
      <GlassSurface material="dense" style={styles.banner} onLayout={layout}>
        <View style={styles.row}>
          {arrived ? (
            <ManeuverIcon maneuver={ARRIVAL_ICON} size={48} color={ACCENT} />
          ) : (
            <Ionicons name="alert-circle" size={44} color={WARN} />
          )}
          <View style={styles.text}>
            <Text style={styles.title} accessibilityRole="header">
              {arrived ? "You've arrived" : "Can't navigate this route"}
            </Text>
            <Text style={styles.road} numberOfLines={2}>
              {arrived ? state.destination.name : state.message}
            </Text>
          </View>
        </View>
      </GlassSurface>
    );
  }

  const { progress, gps, notice } = state;
  const gpsNote =
    gps === "lost" || gps === "waiting"
      ? <Status icon="locate-outline" text={gps === "waiting" ? "Waiting for GPS…" : "GPS signal lost. Waiting for it to come back…"} />
      : gps === "weak"
        ? <Status icon="cellular-outline" text="Weak GPS signal" />
        : null;

  // Off the route: say so, and offer Update Route
  if (state.phase === "offRoute" || (state.phase === "rerouting" && !progress)) {
    const busy = state.phase === "rerouting";
    return (
      <GlassSurface material="dense" style={styles.banner} onLayout={layout}>
        <View style={styles.row}>
          <Ionicons name="git-branch-outline" size={42} color={WARN} />
          <View style={styles.text}>
            <Text style={styles.title} accessibilityRole="header">
              {progress ? "You're off route" : "You're away from the route"}
            </Text>
            <Text style={styles.road} numberOfLines={2}>
              {problem ?? notice ?? "Get back on the highlighted route, or update it from here."}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Update route from here"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onPress={updateRoute}
          style={styles.action}
        >
          {busy ? <ActivityIndicator color="#10161C" /> : <Ionicons name="refresh" size={18} color="#10161C" />}
          <Text style={styles.actionText}>{busy ? "Updating route…" : "Update Route"}</Text>
        </TouchableOpacity>
        {gpsNote}
      </GlassSurface>
    );
  }

  // Starting (or just rerouted): finding the car on the route
  if (!progress) {
    return (
      <GlassSurface material="dense" style={styles.banner} onLayout={layout}>
        <View style={styles.row}>
          <ActivityIndicator color={ACCENT} />
          <View style={styles.text}>
            <Text style={styles.title} accessibilityRole="header">
              {state.starting === "refreshing" ? "Updating your route…" : "Starting navigation…"}
            </Text>
            <Text style={styles.road} numberOfLines={2}>
              {notice ?? `To ${state.destination.name}`}
            </Text>
          </View>
        </View>
        {gpsNote}
      </GlassSurface>
    );
  }

  const next = progress.next;
  const distance = progress.distanceToNextM < NOW_WITHIN_M ? "Now" : formatGuidanceDistance(progress.distanceToNextM, unitSystem);
  const sign = signage(next);
  const label = `${distance === "Now" ? "Now" : `In ${distance}`}, ${next.instruction}${sign ? `. ${sign}` : ""}`;
  return (
    <GlassSurface material="dense" style={styles.banner} onLayout={layout}>
      <View style={styles.row} accessible accessibilityRole="summary" accessibilityLabel={label} accessibilityLiveRegion="polite">
        <ManeuverIcon maneuver={next} size={56} color={FG} />
        <View style={styles.text}>
          <Text style={styles.distance}>{distance}</Text>
          <Text style={styles.instruction} numberOfLines={2}>
            {next.instruction}
          </Text>
          {sign ? (
            <Text style={styles.sign} numberOfLines={1}>
              {sign}
            </Text>
          ) : null}
        </View>
      </View>
      {progress.then ? (
        <View style={styles.thenRow} accessible accessibilityLabel={`Then ${progress.then.instruction}`}>
          <Text style={styles.thenText}>Then</Text>
          <ManeuverIcon maneuver={progress.then} size={24} color={FG} />
        </View>
      ) : null}
      {progress.currentRoad ? (
        <Text style={styles.current} numberOfLines={1}>
          On {progress.currentRoad}
        </Text>
      ) : null}
      {state.phase === "rerouting" ? <Status busy text="Updating route…" /> : null}
      {problem ?? notice ? <Status icon="information-circle-outline" text={(problem ?? notice)!} /> : null}
      {gpsNote}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 12,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 14 },
  text: { flex: 1, minWidth: 0 },
  distance: { color: FG, fontSize: 30, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  instruction: { color: FG, fontSize: 17, fontWeight: "600", lineHeight: 22 },
  sign: { color: MUTED, fontSize: 13, marginTop: 2 },
  title: { color: FG, fontSize: 20, fontWeight: "700" },
  road: { color: MUTED, fontSize: 14, marginTop: 2 },
  thenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  thenText: { color: FG, fontSize: 13, fontWeight: "600" },
  current: { color: MUTED, fontSize: 13 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusText: { color: MUTED, fontSize: 13, flexShrink: 1 },
  action: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 44,
    borderRadius: 14,
    backgroundColor: ACCENT,
  },
  actionText: { color: "#10161C", fontSize: 16, fontWeight: "700" },
});

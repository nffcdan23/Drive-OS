/**
 * The turn-by-turn card at the top of the Drive screen while navigating
 * (Navigation Phase 3, restyled after the reference design): one compact
 * card with the next manoeuvre's arrow and how far to it (the strongest
 * things on it), the road or place it leads to, what to do in Mapbox's en-GB
 * words, the junction or road number on a shield, and the lanes along its
 * bottom edge. A small separate "Then" card sits under it, on the left, for
 * a manoeuvre straight after. Every text line is one line, truncated, so the
 * card never grows tall.
 *
 * It reads the navigation state itself, so its updates on every GPS fix
 * re-render this banner only, never the Drive screen.
 *
 * Off route it only says what is happening, with nothing to press: "You're
 * off route", then "Updating route…" while the session fetches a new one by
 * itself, then guidance on the new route; or "Route update unavailable" if
 * that failed (the old route stays). After several failures in a row a small
 * Try Again is offered too.
 */
import React, { memo } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassSurface } from "@/components/Glass";
import { ARRIVAL_ICON, LaneIcon, ManeuverIcon } from "@/components/navigation/ManeuverIcon";
import type { LaneView } from "@/lib/navigation/lanes";
import { useNavigationState, useRetryReroute } from "@/context/NavigationContext";
import { formatGuidanceDistance, NOW_WITHIN_M } from "@/lib/navigation/format";
import { guidanceLines, guidanceShield } from "@/lib/navigation/guidanceText";
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

const Shield = memo(function Shield({ text, motorway }: { text: string; motorway: boolean }) {
  return (
    <View style={[styles.shield, motorway ? styles.shieldMotorway : styles.shieldRoad]}>
      <Text style={[styles.shieldText, !motorway && styles.shieldRoadText]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
});

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

/**
 * Lane guidance along the card's bottom edge: one arrow per lane, left to
 * right, the lanes to use bright on a soft highlight, the others faint. Only the
 * provider's lane data; re-renders only when the lanes change.
 */
const LaneStrip = memo(function LaneStrip({ view }: { view: LaneView }) {
  const use = view.lanes.map((l, i) => (l.recommended ? i + 1 : 0)).filter(Boolean);
  const label = `Lanes: use ${use.length === 1 ? `lane ${use[0]}` : `lanes ${use.join(", ")}`} of ${view.lanes.length}, counting from the left`;
  return (
    <View style={styles.lanes} accessible accessibilityLabel={label}>
      {view.lanes.map((lane, i) => (
        <View key={i} style={[styles.lane, i > 0 && styles.laneDivider, lane.recommended && styles.laneUse]}>
          <LaneIcon lane={lane} drivingSide={view.drivingSide} size={28} color={FG} />
        </View>
      ))}
    </View>
  );
});

export function GuidanceBanner({
  unitSystem,
  onHeight,
  onCardHeight,
}: {
  unitSystem: ResolvedUnitSystem;
  /** The whole banner's height, the Then card included (for what sits below it) */
  onHeight?: (height: number) => void;
  /** The main card's height alone (for the controls beside the Then card) */
  onCardHeight?: (height: number) => void;
}) {
  const state = useNavigationState();
  const retry = useRetryReroute();
  if (state.phase === "idle") return null;

  const layout = onHeight ? (e: LayoutChangeEvent) => onHeight(e.nativeEvent.layout.height) : undefined;
  const cardLayout = onCardHeight ? (e: LayoutChangeEvent) => onCardHeight(e.nativeEvent.layout.height) : undefined;
  const banner = (card: React.ReactNode, below?: React.ReactNode) => (
    <View pointerEvents="box-none" onLayout={layout}>
      <GlassSurface material="dense" style={styles.card} onLayout={cardLayout}>
        {card}
      </GlassSurface>
      {below}
    </View>
  );

  if (state.phase === "arrived" || state.phase === "error") {
    const arrived = state.phase === "arrived";
    return banner(
      <View style={styles.row}>
        {arrived ? (
          <ManeuverIcon maneuver={ARRIVAL_ICON} size={44} color={ACCENT} />
        ) : (
          <Ionicons name="alert-circle" size={40} color={WARN} />
        )}
        <View style={styles.text}>
          <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
            {arrived ? "You've arrived" : "Can't navigate this route"}
          </Text>
          <Text style={styles.secondary} numberOfLines={2}>
            {arrived ? state.destination.name : state.message}
          </Text>
        </View>
      </View>,
    );
  }

  const { progress, gps, notice } = state;
  const gpsNote =
    gps === "lost" || gps === "waiting"
      ? <Status icon="locate-outline" text={gps === "waiting" ? "Waiting for GPS…" : "GPS signal lost. Waiting for it to come back…"} />
      : gps === "weak"
        ? <Status icon="cellular-outline" text="Weak GPS signal" />
        : null;

  // Off the route: passive, nothing to press (the session updates the route itself)
  if (state.phase === "offRoute" || state.phase === "rerouting") {
    const updating = state.phase === "rerouting";
    const title = updating ? "Updating route…" : "You're off route";
    const detail = updating
      ? "You're off route"
      : state.updateFailed
        ? "Route update unavailable"
        : "Your route will update automatically";
    return banner(
      <>
        <View style={styles.row} accessible accessibilityRole="summary" accessibilityLabel={`${title}. ${detail}`} accessibilityLiveRegion="polite">
          {updating ? (
            <View style={styles.offIcon}>
              <ActivityIndicator color={ACCENT} />
            </View>
          ) : (
            <Ionicons name="git-branch-outline" size={38} color={WARN} />
          )}
          <View style={styles.text}>
            <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.secondary} numberOfLines={1}>
              {detail}
            </Text>
          </View>
          {!updating && state.canRetry ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Try updating the route again"
              onPress={() => {
                Haptics.selectionAsync();
                void retry();
              }}
              style={styles.retry}
              hitSlop={8}
            >
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {gpsNote}
      </>,
    );
  }

  // Starting (or just rerouted): finding the car on the route
  if (!progress) {
    return banner(
      <>
        <View style={styles.row}>
          <View style={styles.offIcon}>
            <ActivityIndicator color={ACCENT} />
          </View>
          <View style={styles.text}>
            <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
              {state.starting === "refreshing" ? "Updating your route…" : "Starting navigation…"}
            </Text>
            <Text style={styles.secondary} numberOfLines={1}>
              {notice ?? `To ${state.destination.name}`}
            </Text>
          </View>
        </View>
        {gpsNote}
      </>,
    );
  }

  const next = progress.next;
  const distance = progress.distanceToNextM < NOW_WITHIN_M ? "Now" : formatGuidanceDistance(progress.distanceToNextM, unitSystem);
  const sign = signage(next);
  const { primary, secondary } = guidanceLines(next);
  const shield = guidanceShield(next);
  const label = `${distance === "Now" ? "Now" : `In ${distance}`}, ${next.instruction}${sign ? `. ${sign}` : ""}`;
  const then = progress.then;
  return banner(
    <>
      <View style={styles.row} accessible accessibilityRole="summary" accessibilityLabel={label} accessibilityLiveRegion="polite">
        <ManeuverIcon maneuver={next} size={50} color={FG} />
        <View style={styles.text}>
          <Text style={styles.distance} numberOfLines={1}>
            {distance}
          </Text>
          <Text style={styles.primary} numberOfLines={1}>
            {primary}
          </Text>
          {secondary ? (
            <Text style={styles.secondary} numberOfLines={1}>
              {secondary}
            </Text>
          ) : null}
        </View>
        {shield ? <Shield text={shield.text} motorway={shield.motorway} /> : null}
      </View>
      {state.lanes && state.lanes.stepIndex === next.stepIndex ? <LaneStrip view={state.lanes} /> : null}
      {notice ? <Status icon="information-circle-outline" text={notice} /> : null}
      {gpsNote}
    </>,
    then ? (
      <GlassSurface material="dense" style={styles.then} accessible accessibilityLabel={`Then ${then.instruction}`}>
        <Text style={styles.thenText}>Then</Text>
        <ManeuverIcon maneuver={then} size={22} color={FG} />
        {progress.thenAfterM != null ? (
          <Text style={styles.thenDistance}>{formatGuidanceDistance(progress.thenAfterM, unitSystem)}</Text>
        ) : null}
      </GlassSurface>
    ) : null,
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 10,
    overflow: "hidden",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  text: { flex: 1, minWidth: 0 },
  // The distance and the arrow carry the card
  distance: { color: FG, fontSize: 32, fontWeight: "800", letterSpacing: -0.6, lineHeight: 36, fontVariant: ["tabular-nums"] },
  primary: { color: FG, fontSize: 18, fontWeight: "700", lineHeight: 22 },
  secondary: { color: MUTED, fontSize: 14, lineHeight: 18, marginTop: 1 },
  title: { color: FG, fontSize: 19, fontWeight: "700" },
  shield: {
    minWidth: 44,
    maxWidth: 88,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
    marginTop: 4,
  },
  // UK road signs: motorways white on blue, other roads yellow on green
  shieldMotorway: { backgroundColor: "#1F58B5", borderWidth: 1.5, borderColor: "rgba(255,255,255,0.85)" },
  shieldRoad: { backgroundColor: "#0F6B3E", borderWidth: 1.5, borderColor: "rgba(255,255,255,0.85)" },
  shieldText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800", letterSpacing: 0.2 },
  shieldRoadText: { color: "#FFD43B" },
  // The lanes run along the card's bottom edge, under a hairline
  lanes: {
    flexDirection: "row",
    justifyContent: "center",
    marginHorizontal: -14,
    marginBottom: -12,
    paddingVertical: 5,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(0,0,0,0.22)",
  },
  lane: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8 },
  // A lane line between lanes, like the road markings
  laneDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: "rgba(255,255,255,0.28)" },
  laneUse: { backgroundColor: "rgba(0,207,232,0.22)" },
  // The small Then card, under the main card on the left
  then: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 7,
    marginLeft: 12,
    marginTop: 8,
    paddingHorizontal: 12,
    height: 36,
    borderRadius: 18,
  },
  thenText: { color: MUTED, fontSize: 14, fontWeight: "600" },
  thenDistance: { color: FG, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusText: { color: MUTED, fontSize: 13, flexShrink: 1 },
  offIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  // Secondary, after repeated failures only: small and quiet
  retry: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(243,245,247,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: { color: FG, fontSize: 14, fontWeight: "600" },
});

/**
 * The bottom of the Drive screen while navigating (Navigation Phase 3).
 *
 * GuidanceBar, with no drive being recorded: arrival time, time and distance
 * left, End, and the camera (Recenter / Overview) and Record buttons, in
 * place of the drive actions. Compact, so the map stays the screen.
 *
 * GuidanceStrip, while recording: one slim row (arrival, what's left, End)
 * that sits above the drive panel, rather than a second panel stacked on it.
 *
 * On arriving both say so, with Done, and Save Place where the destination
 * may be saved (not a search result: Mapbox's terms) and isn't already.
 *
 * Both read the navigation state themselves; the Drive screen doesn't
 * re-render as it changes. Ending navigation never touches a recording.
 */
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { SavePlaceSheet } from "@/components/places/SavePlaceSheet";
import { useApp } from "@/context/AppContext";
import { useEndNavigation, useNavigationState } from "@/context/NavigationContext";
import { arrivalTime, formatClock, formatDuration, formatGuidanceDistance } from "@/lib/navigation/format";
import { saveability } from "@/lib/navigation/places";
import type { NavigationState } from "@/lib/navigation/session";
import type { ResolvedUnitSystem } from "@/lib/units";

const FG = "#F3F5F7";
const MUTED = "rgba(243,245,247,0.68)";
const END_RED = "#F07575";

/** Arrival times move on with the clock, even with no fixes coming in */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function remainingOf(state: NavigationState) {
  if (state.phase === "idle" || state.phase === "arrived" || state.phase === "error") return null;
  return state.progress;
}

function Arrived({ state, compact }: { state: Extract<NavigationState, { phase: "arrived" }>; compact: boolean }) {
  const end = useEndNavigation();
  const { places, addPlace } = useApp();
  const [saving, setSaving] = useState(false);
  const save = saveability(places, state.destination);
  return (
    <View style={[styles.row, compact && styles.compactRow]}>
      <View style={styles.grow}>
        <Text style={styles.arrived} numberOfLines={1}>
          You've arrived
        </Text>
        {!compact ? (
          <Text style={styles.sub} numberOfLines={1}>
            {state.destination.name}
          </Text>
        ) : null}
      </View>
      {save.kind === "can_save" ? (
        <GlassButton
          accessibilityLabel={`Save ${state.destination.name} to your places`}
          style={styles.pill}
          onPress={() => {
            Haptics.selectionAsync();
            setSaving(true);
          }}
        >
          <Ionicons name="bookmark-outline" size={16} color={FG} />
          <Text style={styles.pillText}>Save Place</Text>
        </GlassButton>
      ) : null}
      <GlassButton
        material="accent"
        accessibilityLabel="Done: end navigation"
        style={styles.done}
        onPress={() => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          end("arrived");
        }}
      >
        <Text style={styles.doneText}>Done</Text>
      </GlassButton>
      <SavePlaceSheet
        visible={saving && save.kind === "can_save"}
        defaultKind="poi"
        destination={state.destination}
        onClose={() => setSaving(false)}
        onSave={addPlace}
      />
    </View>
  );
}

function EndButton({ compact }: { compact?: boolean }) {
  const end = useEndNavigation();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="End navigation"
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        end("user");
      }}
      style={[styles.end, compact && styles.endCompact]}
      hitSlop={8}
    >
      <Text style={styles.endText}>End</Text>
    </TouchableOpacity>
  );
}

function Summary({ state, unitSystem, compact }: { state: NavigationState; unitSystem: ResolvedUnitSystem; compact: boolean }) {
  const now = useClock();
  const progress = remainingOf(state);
  if (!progress) {
    return (
      <View style={styles.grow}>
        <Text style={styles.eta} numberOfLines={1}>
          --:--
        </Text>
        {!compact ? <Text style={styles.sub}>arrival</Text> : null}
      </View>
    );
  }
  const eta = formatClock(arrivalTime(Date.now() > now ? Date.now() : now, progress.durationRemainingS));
  const left = `${formatDuration(progress.durationRemainingS)} · ${formatGuidanceDistance(progress.distanceRemainingM, unitSystem)}`;
  return (
    <View
      style={[styles.grow, compact ? styles.compactSummary : null]}
      accessible
      accessibilityLabel={`Arrival ${eta}, ${left} to go`}
    >
      <Text style={[styles.eta, compact && styles.etaCompact]} numberOfLines={1}>
        {eta}
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {compact ? left : `arrival · ${left}`}
      </Text>
    </View>
  );
}

/** Navigation without a recording: in place of the drive actions */
export function GuidanceBar({
  unitSystem,
  following,
  onRecenter,
  onOverview,
  onRecord,
}: {
  unitSystem: ResolvedUnitSystem;
  /** Whether the camera is following the route (else the user moved the map) */
  following: boolean;
  onRecenter: () => void;
  onOverview: () => void;
  /** Start recording the drive too (never automatic) */
  onRecord: () => void;
}) {
  const state = useNavigationState();
  if (state.phase === "idle") return null;
  return (
    <GlassSurface material="dense" style={styles.bar}>
      {state.phase === "arrived" ? (
        <Arrived state={state} compact={false} />
      ) : (
        <>
          <View style={styles.row}>
            <Summary state={state} unitSystem={unitSystem} compact={false} />
            <EndButton />
          </View>
          {state.phase !== "error" ? (
            <View style={styles.actions}>
              <GlassButton
                accessibilityLabel={following ? "Show the whole route" : "Recenter on your position"}
                style={styles.pill}
                onPress={() => {
                  Haptics.selectionAsync();
                  if (following) onOverview();
                  else onRecenter();
                }}
              >
                <Ionicons name={following ? "map-outline" : "navigate"} size={16} color={FG} />
                <Text style={styles.pillText}>{following ? "Overview" : "Recenter"}</Text>
              </GlassButton>
              <GlassButton
                accessibilityLabel="Record this drive"
                accessibilityHint="Starts recording your drive. Navigation carries on."
                style={styles.pill}
                onPress={onRecord}
              >
                <View style={styles.recDot} />
                <Text style={styles.pillText}>Record</Text>
              </GlassButton>
            </View>
          ) : null}
        </>
      )}
    </GlassSurface>
  );
}

/** Navigation while recording: one slim row above the drive panel */
export function GuidanceStrip({ unitSystem }: { unitSystem: ResolvedUnitSystem }) {
  const state = useNavigationState();
  if (state.phase === "idle") return null;
  return (
    <GlassSurface material="dense" style={styles.strip}>
      {state.phase === "arrived" ? (
        <Arrived state={state} compact />
      ) : (
        <View style={[styles.row, styles.compactRow]}>
          <Summary state={state} unitSystem={unitSystem} compact />
          <EndButton compact />
        </View>
      )}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  bar: {
    marginHorizontal: 12,
    marginBottom: 12,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  strip: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  compactRow: { gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  compactSummary: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  eta: { color: FG, fontSize: 26, fontWeight: "800", fontVariant: ["tabular-nums"] },
  etaCompact: { fontSize: 20 },
  sub: { color: MUTED, fontSize: 14, fontVariant: ["tabular-nums"] },
  arrived: { color: FG, fontSize: 18, fontWeight: "700" },
  end: {
    height: 44,
    paddingHorizontal: 22,
    borderRadius: 22,
    backgroundColor: END_RED,
    alignItems: "center",
    justifyContent: "center",
  },
  endCompact: { height: 36, paddingHorizontal: 16, borderRadius: 18 },
  endText: { color: "#0A0D10", fontSize: 16, fontWeight: "700" },
  actions: { flexDirection: "row", gap: 10 },
  pill: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pillText: { color: FG, fontSize: 14, fontWeight: "600" },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#22c55e" },
  done: { height: 44, paddingHorizontal: 24, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  doneText: { color: "#10161C", fontSize: 16, fontWeight: "700" },
});

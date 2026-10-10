/**
 * The bottom of the Drive screen while navigating (Navigation Phase 3).
 *
 * GuidanceBar, with no drive being recorded: arrival time, time and distance
 * left, End, and the camera (Recenter / Overview) buttons, in place of the
 * drive actions, and Record when navigation has no recording alongside.
 * Compact, so the map stays the screen.
 *
 * GuidanceStrip, while recording (Start Navigation records the drive): one
 * slim row (arrival, what's left, End) that sits above the drive panel,
 * rather than a second panel stacked on it.
 *
 * End, when navigation started the drive being recorded, asks first: "End
 * navigation and finish drive" (the Drive screen's usual End Drive, so the
 * drive is saved and Drive Complete opens) or "Continue navigation". With a
 * drive the user started themselves, End ends navigation only.
 *
 * On arriving both say so, with Done, and Save Place where the destination
 * may be saved (not a search result: Mapbox's terms) and isn't already. (A
 * drive navigation started is finished by the Drive screen on arriving.)
 *
 * Both have a small voice button (Phase 4): mute stops guidance speaking at
 * once (and drops anything queued); unmute brings back the last choice, for
 * the prompts still ahead. It's the same preference as Settings.
 *
 * Both read the navigation state themselves; the Drive screen doesn't
 * re-render as it changes. They never start or stop a recording themselves.
 */
import React, { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { SavePlaceSheet } from "@/components/places/SavePlaceSheet";
import { useApp } from "@/context/AppContext";
import { useEndNavigation, useNavigationState, useNavigationVoice } from "@/context/NavigationContext";
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

/**
 * End. `onFinishDrive` is given only while a drive navigation started is
 * being recorded: then End asks before finishing it (never deleting it).
 */
function EndButton({ compact, ownsDrive, onFinishDrive }: { compact?: boolean; ownsDrive: boolean; onFinishDrive?: () => void }) {
  const end = useEndNavigation();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="End navigation"
      accessibilityHint={ownsDrive && onFinishDrive ? "Asks whether to finish the drive too" : undefined}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        if (ownsDrive && onFinishDrive) {
          Alert.alert(
            "End navigation?",
            "Your drive will be finished and saved.",
            [
              { text: "Continue navigation", style: "cancel" },
              { text: "End navigation and finish drive", onPress: onFinishDrive },
            ],
            { cancelable: true },
          );
          return;
        }
        end("user");
      }}
      style={[styles.end, compact && styles.endCompact]}
      hitSlop={8}
    >
      <Text style={styles.endText}>End</Text>
    </TouchableOpacity>
  );
}

/** Mute / unmute voice guidance: an icon, quiet by design */
function VoiceButton({ compact }: { compact?: boolean }) {
  const { mode, toggleMute } = useNavigationVoice();
  const muted = mode === "off";
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={muted ? "Unmute voice guidance" : "Mute voice guidance"}
      accessibilityState={{ selected: muted }}
      onPress={() => {
        Haptics.selectionAsync();
        toggleMute();
      }}
      style={[styles.voice, compact && styles.voiceCompact]}
      hitSlop={8}
    >
      <Ionicons name={muted ? "volume-mute" : "volume-high"} size={compact ? 18 : 20} color={muted ? MUTED : FG} />
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
  /** Start recording the drive (navigation has none alongside: Passenger Mode, or it was finished) */
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
            <VoiceButton />
            <EndButton ownsDrive={false} />
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
              {state.recording === "none" ? (
                <GlassButton
                  accessibilityLabel="Record this drive"
                  accessibilityHint="Starts recording your drive. Navigation carries on."
                  style={styles.pill}
                  onPress={onRecord}
                >
                  <View style={styles.recDot} />
                  <Text style={styles.pillText}>Record</Text>
                </GlassButton>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </GlassSurface>
  );
}

/** Navigation while recording: one slim row above the drive panel */
export function GuidanceStrip({
  unitSystem,
  onFinishDrive,
}: {
  unitSystem: ResolvedUnitSystem;
  /** End navigation and finish the drive navigation started (the Drive screen's End Drive) */
  onFinishDrive: () => void;
}) {
  const state = useNavigationState();
  if (state.phase === "idle") return null;
  return (
    <GlassSurface material="dense" style={styles.strip}>
      {state.phase === "arrived" ? (
        <Arrived state={state} compact />
      ) : (
        <View style={[styles.row, styles.compactRow]}>
          <Summary state={state} unitSystem={unitSystem} compact />
          <VoiceButton compact />
          <EndButton compact ownsDrive={state.recording === "navigation"} onFinishDrive={onFinishDrive} />
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
  voice: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  voiceCompact: { width: 36, height: 36, borderRadius: 18 },
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

/**
 * The bottom of the Drive screen while navigating (the navigation
 * presentation, lib/drivePresentation), whether or not a drive is being
 * recorded underneath. Map-first and compact:
 *
 *   [speed HUD]  [● Recording]                    (small, above the panel)
 *   ┌──────────────────────────────────────────┐
 *   │ (Overview)     48 min        (End)        │
 *   │              41 mi • 20:35               │
 *   └──────────────────────────────────────────┘
 *
 *  - the time left is the main figure; distance left and arrival time
 *    beneath it;
 *  - Overview / Recenter on the left (the screen's own camera actions: the
 *    whole route while following, back to the car otherwise);
 *  - End on the right, always there. When navigation started the drive being
 *    recorded it asks first: "End navigation and finish drive" (the Drive
 *    screen's usual End Drive, so the drive is saved and Drive Complete
 *    opens) or "Continue navigation". Otherwise it ends navigation only and a
 *    drive the user started carries on;
 *  - the speed HUD: the car's current GPS speed in the user's units, nothing
 *    else (no speed limit: the route's limits aren't reliable enough to show);
 *  - one quiet "Recording" mark while a drive records underneath. Never the
 *    recording dashboard (speedometer panel, Pause, End Drive, Save Point);
 *  - Report, on the right of that row (lower right, as in the reference
 *    design): opens the hazard report sheet.
 *
 * On arriving it says so, with Done, and Save Place where the destination
 * may be saved (not a search result: Mapbox's terms) and isn't already. (A
 * drive navigation started is finished by the Drive screen on arriving.)
 *
 * Voice and Record sit in the controls down the right
 * (NavigationControls). It reads the navigation state itself; the Drive
 * screen doesn't re-render as it changes. It never starts or stops a
 * recording itself.
 */
import React, { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { SavePlaceSheet } from "@/components/places/SavePlaceSheet";
import { ReportButton } from "@/components/hazards/ReportButton";
import { useApp } from "@/context/AppContext";
import { useEndNavigation, useNavigationSpeed, useNavigationSpeedLimit, useNavigationState } from "@/context/NavigationContext";
import { arrivalTime, formatClock, formatDuration, formatGuidanceDistance } from "@/lib/navigation/format";
import { saveability } from "@/lib/navigation/places";
import type { NavigationState } from "@/lib/navigation/session";
import { speedUnit, type ResolvedUnitSystem } from "@/lib/units";

const FG = "#F3F5F7";
const MUTED = "rgba(243,245,247,0.62)";
const ACCENT = "#00CFE8";
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

function Arrived({ state }: { state: Extract<NavigationState, { phase: "arrived" }> }) {
  const end = useEndNavigation();
  const { places, addPlace } = useApp();
  const [saving, setSaving] = useState(false);
  const save = saveability(places, state.destination);
  return (
    <View style={styles.arrivedRow}>
      <View style={styles.grow}>
        <Text style={styles.arrived} numberOfLines={1}>
          You've arrived
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {state.destination.name}
        </Text>
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

/** A round panel control with its label beneath (Overview, End) */
function RoundAction({
  label,
  accessibilityLabel,
  accessibilityHint,
  danger,
  onPress,
  children,
}: {
  label: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  danger?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.action}>
      <GlassButton
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        style={[styles.round, danger && styles.roundDanger]}
        onPress={onPress}
      >
        {children}
      </GlassButton>
      <Text style={[styles.actionLabel, danger && { color: END_RED }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/**
 * End. `ownsDrive`: navigation started the drive being recorded, so End
 * asks before finishing it (never deleting it).
 */
function EndButton({ ownsDrive, onFinishDrive }: { ownsDrive: boolean; onFinishDrive: () => void }) {
  const end = useEndNavigation();
  return (
    <RoundAction
      label="End"
      danger
      accessibilityLabel="End navigation"
      accessibilityHint={ownsDrive ? "Asks whether to finish the drive too" : undefined}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        if (ownsDrive) {
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
    >
      <Glyph sf="xmark" ion="close" size={22} color={END_RED} />
    </RoundAction>
  );
}

/** Time left (the main figure), then distance left and arrival time */
function Summary({ state, unitSystem }: { state: NavigationState; unitSystem: ResolvedUnitSystem }) {
  const now = useClock();
  const progress = remainingOf(state);
  if (!progress) {
    return (
      <View style={styles.summary}>
        <Text style={styles.time} numberOfLines={1}>
          --
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {state.phase === "error" ? "Route unavailable" : "Finding your route"}
        </Text>
      </View>
    );
  }
  const eta = formatClock(arrivalTime(Date.now() > now ? Date.now() : now, progress.durationRemainingS));
  const time = formatDuration(progress.durationRemainingS);
  const distance = formatGuidanceDistance(progress.distanceRemainingM, unitSystem);
  return (
    <View style={styles.summary} accessible accessibilityLabel={`${time} to go, ${distance}, arriving at ${eta}`}>
      <Text style={styles.time} numberOfLines={1} adjustsFontSizeToFit>
        {time}
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {distance} • {eta}
      </Text>
    </View>
  );
}

/**
 * The car's current speed, small, from the newest real GPS fix navigation has
 * (lib/navigation/speedHud.ts). Subscribed to the fixes themselves: reading
 * the latest fix during render left it showing its first value (usually 0,
 * parked at the start), because nothing made it render again. The road's
 * speed limit, when known, is its own sign beside it (SpeedLimitSign).
 */
function SpeedHud({ unitSystem }: { unitSystem: ResolvedUnitSystem }) {
  const value = useNavigationSpeed(unitSystem);
  const unit = speedUnit(unitSystem);
  return (
    <GlassSurface
      material="dense"
      style={styles.speed}
      accessible
      accessibilityLabel={value == null ? "Speed unavailable" : `Speed ${value} ${unit}`}
    >
      <Text style={styles.speedValue}>{value ?? "--"}</Text>
      <Text style={styles.speedUnit}>{unit}</Text>
    </GlassSurface>
  );
}

/**
 * The road's posted speed limit, as a UK sign: a red ring round the number
 * (lib/navigation/speedLimit.ts). Only when the route's data has the limit
 * for where the car is; otherwise nothing at all (never a guess).
 */
function SpeedLimitSign({ unitSystem }: { unitSystem: ResolvedUnitSystem }) {
  const limit = useNavigationSpeedLimit(unitSystem);
  if (limit == null) return null;
  return (
    <View
      style={styles.limit}
      accessible
      accessibilityLabel={`Speed limit ${limit} ${speedUnit(unitSystem)}`}
    >
      <Text style={[styles.limitValue, limit >= 100 && styles.limitValueSmall]} numberOfLines={1}>
        {limit}
      </Text>
    </View>
  );
}

/** The navigation bottom panel, in place of the drive actions (with or without a recording underneath) */
export function GuidanceBar({
  unitSystem,
  following,
  onRecenter,
  onOverview,
  recordingActive,
  onFinishDrive,
  onReport,
}: {
  unitSystem: ResolvedUnitSystem;
  /** Whether the camera is following the route (else the user moved the map) */
  following: boolean;
  onRecenter: () => void;
  onOverview: () => void;
  /** A drive is being recorded underneath (navigation's own, or one the user started) */
  recordingActive: boolean;
  /** End navigation and finish the drive navigation started (the Drive screen's End Drive) */
  onFinishDrive: () => void;
  /** Opens the hazard report sheet */
  onReport?: () => void;
}) {
  const state = useNavigationState();
  if (state.phase === "idle") return null;
  const ownsDrive = recordingActive && state.recording === "navigation";
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {state.phase !== "arrived" ? (
        <View style={styles.hud} pointerEvents="box-none">
          <SpeedHud unitSystem={unitSystem} />
          <SpeedLimitSign unitSystem={unitSystem} />
          {recordingActive ? (
            // One quiet mark: the drive is being saved, no second dashboard
            <View style={styles.recording} accessible accessibilityLabel="This drive is being recorded">
              <View style={styles.recDotLive} />
              <Text style={styles.recordingText}>Recording</Text>
            </View>
          ) : null}
          {onReport && state.phase !== "error" ? (
            <>
              <View style={styles.grow} pointerEvents="none" />
              <ReportButton onPress={onReport} />
            </>
          ) : null}
        </View>
      ) : null}
      <GlassSurface material="dense" style={styles.panel}>
        {state.phase === "arrived" ? (
          <Arrived state={state} />
        ) : (
          <View style={styles.row}>
            {state.phase !== "error" ? (
              <RoundAction
                label={following ? "Overview" : "Recenter"}
                accessibilityLabel={following ? "Show the whole route" : "Recenter on your position"}
                onPress={() => {
                  Haptics.selectionAsync();
                  if (following) onOverview();
                  else onRecenter();
                }}
              >
                {following ? (
                  <Glyph sf="point.topleft.down.to.point.bottomright.curvepath" ion="git-compare-outline" size={21} color={FG} />
                ) : (
                  <Glyph sf="location.fill" ion="navigate" size={20} color={ACCENT} />
                )}
              </RoundAction>
            ) : (
              <View style={styles.action} />
            )}
            <Summary state={state} unitSystem={unitSystem} />
            <EndButton ownsDrive={ownsDrive} onFinishDrive={onFinishDrive} />
          </View>
        )}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 12, marginBottom: 10, gap: 8 },
  hud: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  panel: {
    borderRadius: 26,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  arrivedRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2 },
  grow: { flex: 1, minWidth: 0 },
  summary: { flex: 1, minWidth: 0, alignItems: "center" },
  time: { color: FG, fontSize: 30, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  sub: { color: MUTED, fontSize: 15, fontWeight: "500", fontVariant: ["tabular-nums"], marginTop: 1 },
  action: { width: 64, alignItems: "center", gap: 4 },
  round: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  roundDanger: { borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(240,117,117,0.45)" },
  actionLabel: { color: MUTED, fontSize: 12, fontWeight: "600" },
  speed: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "rgba(0,207,232,0.55)",
  },
  speedValue: { color: FG, fontSize: 26, fontWeight: "800", fontVariant: ["tabular-nums"], lineHeight: 28 },
  speedUnit: { color: MUTED, fontSize: 11, fontWeight: "600" },
  // A UK limit sign: white disc, red ring, black number
  limit: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#FFFFFF",
    borderWidth: 6,
    borderColor: "#D7261E",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  limitValue: { color: "#111111", fontSize: 20, fontWeight: "800", fontVariant: ["tabular-nums"], letterSpacing: -0.5 },
  limitValueSmall: { fontSize: 16 },
  recording: { flexDirection: "row", alignItems: "center", gap: 5, paddingBottom: 6 },
  recDotLive: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: END_RED },
  recordingText: { color: MUTED, fontSize: 12, fontWeight: "600" },
  arrived: { color: FG, fontSize: 18, fontWeight: "700" },
  pill: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pillText: { color: FG, fontSize: 14, fontWeight: "600" },
  done: { height: 44, paddingHorizontal: 24, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  doneText: { color: "#10161C", fontSize: 16, fontWeight: "700" },
});

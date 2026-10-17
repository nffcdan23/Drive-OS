// The floating panel at the bottom of the recording screen: the drive's
// time, distance and top speed (all from the recording itself), Save Point
// and Stop Drive. Stop Drive asks once, then hands over to the usual end of
// a drive (Drive Complete); repeated taps never end it twice.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Haptics from "expo-haptics";
import { GlassSurface } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { distanceParts, driveTimeParts } from "@/lib/driveDisplay";
import { convertSpeed, speedUnit, type ResolvedUnitSystem } from "@/lib/units";

const TEXT = "#F3F5F7";
const MUTED = "rgba(214,224,234,0.62)";
const PAUSED = "#F5B73B";
const STOP_RED = "#E5484D";
const SAVED = "#34D399";

/** How long a tap on Stop Drive stays locked after it is confirmed */
const STOP_LOCK_MS = 2_000;

interface Props {
  driveSeconds: number;
  isPaused: boolean;
  /** km, as recorded */
  distanceKm: number;
  /** km/h: the highest speed the recording accepted */
  topSpeedKmh: number;
  unitSystem: ResolvedUnitSystem;
  bottomInset: number;
  /** Saves a point at the car's position: null when saved, else why not */
  onSavePoint: () => Promise<string | null>;
  onEndDrive: () => void;
}

type SaveState = "idle" | "saving" | "saved";

function Stat({ label, value, units, labelColour }: { label: string; value: string; units: string; labelColour?: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label} ${value} ${units}`}>
      <Text style={[styles.statLabel, labelColour ? { color: labelColour } : null]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.1}>
        {value}
      </Text>
      <Text style={styles.statUnits} numberOfLines={1} maxFontSizeMultiplier={1.2}>
        {units}
      </Text>
    </View>
  );
}

export default function DriveStatsPanel({
  driveSeconds,
  isPaused,
  distanceKm,
  topSpeedKmh,
  unitSystem,
  bottomInset,
  onSavePoint,
  onEndDrive,
}: Props) {
  const time = driveTimeParts(driveSeconds);
  const distance = distanceParts(distanceKm, unitSystem);
  const topSpeed = String(Math.round(convertSpeed(Math.max(0, topSpeedKmh || 0), unitSystem)));

  // ── Save Point ──
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const mounted = useRef(true);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      mounted.current = false;
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );
  const handleSave = useCallback(async () => {
    if (saveState === "saving") return;
    setSaveState("saving");
    let problem: string | null;
    try {
      problem = await onSavePoint();
    } catch {
      problem = "The point couldn't be saved. Try again.";
    }
    if (!mounted.current) return;
    if (problem) {
      setSaveState("idle");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Point not saved", problem);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSaveState("saved");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => mounted.current && setSaveState("idle"), 1_800);
  }, [onSavePoint, saveState]);

  // ── Stop Drive ──
  const confirming = useRef(false);
  const stopLockedUntil = useRef(0);
  const handleStop = useCallback(() => {
    if (confirming.current || Date.now() < stopLockedUntil.current) return;
    confirming.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      "End Drive?",
      "This will finalise and save your journey.",
      [
        { text: "Cancel", style: "cancel", onPress: () => (confirming.current = false) },
        {
          text: "End Drive",
          style: "destructive",
          onPress: () => {
            confirming.current = false;
            if (Date.now() < stopLockedUntil.current) return;
            stopLockedUntil.current = Date.now() + STOP_LOCK_MS;
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onEndDrive();
          },
        },
      ],
      { cancelable: true, onDismiss: () => (confirming.current = false) },
    );
  }, [onEndDrive]);

  return (
    <GlassSurface material="dense" style={[styles.panel, { marginBottom: Math.max(bottomInset, 10) + 6 }]}>
      <View style={styles.stats}>
        <Stat
          label={isPaused ? "Paused" : "Drive Time"}
          labelColour={isPaused ? PAUSED : undefined}
          value={time.value}
          units={time.units}
        />
        <View style={styles.divider} />
        <Stat label="Distance" value={distance.value} units={distance.units} />
        <View style={styles.divider} />
        <Stat label="Top Speed" value={topSpeed} units={speedUnit(unitSystem).toUpperCase()} />
      </View>

      <View style={styles.actions}>
        {/* Save Point */}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={saveState === "saved" ? "Point saved" : "Save point"}
          accessibilityHint="Saves where you are now to your places"
          accessibilityState={{ busy: saveState === "saving", disabled: saveState === "saving" }}
          disabled={saveState === "saving"}
          onPress={handleSave}
          style={[styles.saveButton, saveState === "saved" && { borderColor: SAVED }]}
          activeOpacity={0.75}
        >
          {saveState === "saving" ? (
            <ActivityIndicator color={TEXT} />
          ) : (
            <Glyph
              sf={saveState === "saved" ? "checkmark" : "bookmark"}
              ion={saveState === "saved" ? "checkmark" : "bookmark-outline"}
              size={21}
              color={saveState === "saved" ? SAVED : TEXT}
            />
          )}
        </TouchableOpacity>

        {/* Stop Drive */}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Stop drive"
          accessibilityHint="Asks to end and save this drive"
          onPress={handleStop}
          style={styles.stopButton}
          activeOpacity={0.85}
        >
          <View style={styles.stopIcon} />
          <Text style={styles.stopText}>Stop Drive</Text>
        </TouchableOpacity>
        {/* Balances Save Point so Stop Drive sits in the middle */}
        <View style={styles.saveSpacer} />
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 12,
    borderRadius: 28,
    paddingTop: 14,
    paddingBottom: 14,
    paddingHorizontal: 14,
    gap: 14,
  },
  stats: { flexDirection: "row", alignItems: "stretch" },
  stat: { flex: 1, alignItems: "center", gap: 1 },
  statLabel: { color: MUTED, fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
  statValue: {
    color: TEXT,
    fontSize: 26,
    lineHeight: 32,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.4,
  },
  statUnits: { color: MUTED, fontSize: 11.5, fontWeight: "500" },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: "rgba(214,224,234,0.2)", marginVertical: 6 },
  actions: { flexDirection: "row", alignItems: "center", gap: 12 },
  saveButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(214,224,234,0.22)",
  },
  saveSpacer: { width: 52 },
  stopButton: {
    flex: 1,
    height: 52,
    borderRadius: 26,
    backgroundColor: STOP_RED,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  stopIcon: { width: 13, height: 13, borderRadius: 3, backgroundColor: "#FFFFFF" },
  stopText: { color: "#FFFFFF", fontSize: 17, fontWeight: "700", letterSpacing: 0.2 },
});

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { GlassButton } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { rec } from "./shared";

/** Asks before finishing; the drive is only saved after this. */
export function confirmFinishDrive(onConfirm: () => void) {
  const title = "Finish drive?";
  const message = "This will end recording and save your journey.";
  if (Platform.OS === "web") {
    // react-native-web's Alert ignores buttons.
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`))
      onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Keep Recording", style: "cancel" },
    { text: "Finish Drive", style: "destructive", onPress: onConfirm },
  ]);
}

/** Pause or resume, finish (with confirmation), and add a marker. */
export default function RecordingControls({
  isPaused,
  onPause,
  onResume,
  onFinish,
  onAddMarker,
}: {
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  /** Resolves true once the marker is saved. */
  onAddMarker: () => Promise<boolean> | boolean;
}) {
  const [marker, setMarker] = useState<"idle" | "saving" | "saved">("idle");
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const togglePause = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (isPaused) onResume();
    else onPause();
  }, [isPaused, onPause, onResume]);

  const finish = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    confirmFinishDrive(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onFinish();
    });
  }, [onFinish]);

  const addMarker = useCallback(async () => {
    if (marker !== "idle") return;
    setMarker("saving");
    let problem: string | null = null;
    try {
      if (!(await onAddMarker()))
        problem = "Your position isn't known yet. Try again once GPS has a fix.";
    } catch {
      problem = "The marker couldn't be saved. Please try again.";
    }
    if (problem) {
      setMarker("idle");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Couldn't add a marker", problem);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setMarker("saved");
    resetRef.current = setTimeout(() => setMarker("idle"), 1800);
  }, [marker, onAddMarker]);

  return (
    <View style={styles.row}>
      <GlassButton
        accessibilityLabel={isPaused ? "Resume recording" : "Pause recording"}
        onPress={togglePause}
        style={styles.side}
      >
        <View style={[styles.well, isPaused && styles.wellResume]}>
          <Glyph
            sf={isPaused ? "play.fill" : "pause.fill"}
            ion={isPaused ? "play" : "pause"}
            size={15}
            color={isPaused ? "#04121B" : rec.text}
          />
        </View>
        <Text numberOfLines={1} style={styles.sideText} maxFontSizeMultiplier={1.1}>
          {isPaused ? "Resume" : "Pause"}
        </Text>
      </GlassButton>

      <View style={styles.finishGlow}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Finish Drive"
          accessibilityHint="Asks you to confirm, then ends and saves this drive"
          activeOpacity={0.85}
          onPress={finish}
          style={styles.finish}
        >
          <LinearGradient
            colors={rec.finish}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.stopIcon} />
          <Text numberOfLines={1} style={styles.finishText} maxFontSizeMultiplier={1.15}>
            Finish Drive
          </Text>
        </TouchableOpacity>
      </View>

      <GlassButton
        accessibilityLabel="Add Marker"
        accessibilityHint="Saves your current position to Saved Places"
        accessibilityState={{ busy: marker === "saving" }}
        onPress={addMarker}
        style={[styles.side, styles.marker]}
      >
        <View pointerEvents="none" style={styles.markerTint} />
        <View style={styles.markerIcon}>
          <Glyph
            sf={marker === "saved" ? "checkmark.circle.fill" : "mappin.and.ellipse"}
            ion={marker === "saved" ? "checkmark-circle" : "location"}
            size={22}
            color={marker === "saved" ? rec.green : rec.marker}
          />
        </View>
        <Text numberOfLines={1} style={styles.sideText} maxFontSizeMultiplier={1.1}>
          {marker === "saved" ? "Added" : "Add Marker"}
        </Text>
      </GlassButton>
    </View>
  );
}

const HEIGHT = 60;
const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  // Icon over label, so the labels fit beside a wide Finish button.
  side: {
    flex: 1,
    height: HEIGHT,
    borderRadius: 20,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  well: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(0,207,232,0.45)",
  },
  wellResume: { backgroundColor: rec.cyan, borderColor: rec.cyanBright },
  sideText: { color: rec.text, fontSize: 12.5, fontWeight: "600" },
  markerIcon: { height: 30, alignItems: "center", justifyContent: "center" },
  finishGlow: {
    flex: 1.75,
    borderRadius: 20,
    shadowColor: "#FF4B3A",
    shadowOpacity: 0.55,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  finish: {
    height: HEIGHT,
    borderRadius: 20,
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: "rgba(255,190,170,0.55)",
  },
  stopIcon: {
    width: 18,
    height: 18,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  finishText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  marker: {
    borderColor: "rgba(255,159,69,0.55)",
    borderTopColor: "rgba(255,190,130,0.65)",
  },
  // GlassButton keeps its own background transparent, so the tint is a layer.
  markerTint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(255,159,69,0.14)",
  },
});

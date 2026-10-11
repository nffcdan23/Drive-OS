/**
 * The small round controls down the right of the map while navigating (the
 * navigation presentation, lib/drivePresentation). Only controls that work:
 *
 *  - voice: mute / unmute guidance (the same preference as Settings);
 *  - Record: only with nothing recording (Passenger Mode, or the drive was
 *    finished), the screen's usual Start Drive.
 *
 * No compass / north-up toggle: guidance always turns the map with the car
 * (the Drive screen's follow camera ignores the heading choice while
 * guiding), so it would do nothing. No report or options buttons either:
 * there is nothing behind them yet.
 */
import React, { memo } from "react";
import { StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { GlassButton } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { useNavigationState, useNavigationVoice } from "@/context/NavigationContext";

const FG = "#F3F5F7";
const MUTED = "rgba(243,245,247,0.6)";

/** Mute / unmute voice guidance */
export const VoiceToggle = memo(function VoiceToggle() {
  const { mode, toggleMute } = useNavigationVoice();
  const muted = mode === "off";
  return (
    <GlassButton
      accessibilityRole="button"
      accessibilityLabel={muted ? "Unmute voice guidance" : "Mute voice guidance"}
      accessibilityState={{ selected: muted }}
      style={styles.button}
      onPress={() => {
        Haptics.selectionAsync();
        toggleMute();
      }}
    >
      <Glyph
        sf={muted ? "speaker.slash.fill" : "speaker.wave.2.fill"}
        ion={muted ? "volume-mute" : "volume-high"}
        size={19}
        color={muted ? MUTED : FG}
      />
    </GlassButton>
  );
});

export function NavigationControls({
  recordingActive,
  onRecord,
}: {
  /** A drive is being recorded underneath */
  recordingActive: boolean;
  /** Start recording (the screen's usual Start Drive) */
  onRecord: () => void;
}) {
  const state = useNavigationState();
  if (state.phase === "idle" || state.phase === "arrived") return null;
  const canRecord = state.phase !== "error" && !recordingActive && state.recording === "none";
  return (
    <View style={styles.stack} pointerEvents="box-none">
      <VoiceToggle />
      {canRecord ? (
        <GlassButton
          accessibilityRole="button"
          accessibilityLabel="Record this drive"
          accessibilityHint="Starts recording your drive. Navigation carries on."
          style={styles.button}
          onPress={onRecord}
        >
          <View style={styles.recDot} />
        </GlassButton>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10, alignItems: "center" },
  button: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  recDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: "#22c55e" },
});

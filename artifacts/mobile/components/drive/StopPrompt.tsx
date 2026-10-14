// "Looks like you've stopped": shown on the Drive screen once the car has
// been stationary for about five minutes (lib/backend/driveLifecycle.ts).
// Continue Drive keeps the drive open; End Drive saves it ending where the
// car stopped (not now). Doing nothing is fine too: driving on carries the
// drive on by itself, and after the grace period it is saved, ending where
// it stopped.
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { GlassButton, GlassSurface } from "@/components/Glass";

const FG = "#FFFFFF";
const MUTED = "rgba(236,240,244,0.72)";
const END_RED = "#FF453A";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function StopPrompt({
  stoppedAt,
  graceEndsAt,
  onContinue,
  onEnd,
  bottom,
}: {
  /** When the car stopped (ms): where the drive ends with End Drive */
  stoppedAt: number;
  /** When it is saved by itself if nothing happens (ms) */
  graceEndsAt: number | null;
  onContinue: () => void;
  onEnd: () => void;
  /** Distance from the bottom of the screen */
  bottom: number;
}) {
  return (
    <View style={[styles.wrap, { bottom }]} pointerEvents="box-none">
      <GlassSurface material="dense" style={styles.card} accessibilityRole="alert">
        <Text style={styles.title}>Looks like you've stopped</Text>
        <Text style={styles.body}>
          {`Stopped since ${clock(stoppedAt)}. `}
          {graceEndsAt != null
            ? `If you don't drive on, this drive is saved at ${clock(graceEndsAt)}, ending where you stopped.`
            : "If you don't drive on, this drive is saved ending where you stopped."}
        </Text>
        <View style={styles.row}>
          <GlassButton
            accessibilityLabel="Continue Drive"
            accessibilityHint="Keeps this drive going"
            onPress={onContinue}
            style={styles.button}
          >
            <Text style={styles.continueText}>Continue Drive</Text>
          </GlassButton>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="End Drive"
            accessibilityHint={`Saves the drive ending at ${clock(stoppedAt)}, where you stopped`}
            onPress={onEnd}
            activeOpacity={0.85}
            style={[styles.button, styles.end]}
          >
            <Text style={styles.endText}>End Drive</Text>
          </TouchableOpacity>
        </View>
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12 },
  card: { borderRadius: 24, padding: 16, gap: 8 },
  title: { color: FG, fontSize: 19, fontWeight: "700" },
  body: { color: MUTED, fontSize: 14.5, lineHeight: 20 },
  row: { flexDirection: "row", gap: 10, marginTop: 6 },
  button: { flex: 1, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  end: { backgroundColor: END_RED },
  continueText: { color: FG, fontSize: 16, fontWeight: "600" },
  endText: { color: FG, fontSize: 16, fontWeight: "700" },
});

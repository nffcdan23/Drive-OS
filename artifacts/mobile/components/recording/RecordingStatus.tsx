import React, { memo, useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { GlassButton, GlassSurface, useReducedMotion } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { formatElapsed, rec } from "./shared";

export type RecordingState = "recording" | "paused" | "passenger";

/** Signal strength from the reported horizontal accuracy (metres). */
function gpsSignal(
  locationMode: "live" | "simulated",
  accuracy: number | null,
): { bars: number; color: string; label: string; description: string } {
  if (locationMode === "simulated")
    return {
      bars: 0,
      color: rec.amber,
      label: "SIM",
      description: "No GPS: simulated location",
    };
  if (accuracy == null)
    return {
      bars: 0,
      color: rec.textMuted,
      label: "GPS",
      description: "Searching for GPS",
    };
  if (accuracy < 10)
    return { bars: 4, color: rec.green, label: "GPS", description: "Strong" };
  if (accuracy < 25)
    return { bars: 3, color: rec.green, label: "GPS", description: "Good" };
  if (accuracy < 50)
    return { bars: 2, color: rec.amber, label: "GPS", description: "Moderate" };
  return { bars: 1, color: rec.red, label: "GPS", description: "Weak" };
}

const RecDot = memo(function RecDot({ state }: { state: RecordingState }) {
  const reduceMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  const pulsing = state === "recording" && !reduceMotion;

  useEffect(() => {
    if (!pulsing) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulsing, opacity]);

  const color =
    state === "recording"
      ? rec.red
      : state === "paused"
        ? rec.amber
        : rec.textMuted;
  return (
    <Animated.View
      style={[
        styles.dot,
        {
          opacity,
          backgroundColor: color,
          shadowColor: color,
        },
      ]}
    />
  );
});

/** Top row: close, the REC pill with the live timer, and the GPS signal. */
export default function RecordingStatus({
  state,
  seconds,
  locationMode,
  gpsAccuracy,
  top,
  onClose,
}: {
  state: RecordingState;
  seconds: number;
  locationMode: "live" | "simulated";
  gpsAccuracy: number | null;
  top: number;
  onClose: () => void;
}) {
  const gps = gpsSignal(locationMode, gpsAccuracy);
  const elapsed = formatElapsed(seconds);
  const label =
    state === "recording" ? "REC" : state === "paused" ? "PAUSED" : "NOT REC";
  const labelColor =
    state === "recording"
      ? rec.red
      : state === "paused"
        ? rec.amber
        : rec.textMuted;
  const stateDescription =
    state === "recording"
      ? "Recording"
      : state === "paused"
        ? "Recording paused"
        : "Passenger Mode, not recording";

  return (
    <View style={[styles.row, { top }]} pointerEvents="box-none">
      <GlassButton
        accessibilityLabel="Close recording"
        accessibilityHint="Asks before finishing and saving this drive"
        onPress={onClose}
        style={styles.round}
      >
        <Glyph sf="xmark" ion="close" size={20} color={rec.text} />
      </GlassButton>

      <GlassSurface
        accessible
        accessibilityRole="timer"
        accessibilityLabel={`${stateDescription}, ${elapsed}`}
        style={[styles.pill, state === "recording" && styles.pillLive]}
      >
        <RecDot state={state} />
        <Text
          numberOfLines={1}
          style={[styles.pillLabel, { color: labelColor }]}
          maxFontSizeMultiplier={1.2}
        >
          {label}
        </Text>
        <Text style={styles.pillTime} maxFontSizeMultiplier={1.2}>
          {elapsed}
        </Text>
      </GlassSurface>

      <GlassSurface
        accessible
        accessibilityLabel={`GPS signal: ${gps.description}`}
        style={styles.gps}
      >
        <View style={styles.bars}>
          {[1, 2, 3, 4].map((i) => (
            <View
              key={i}
              style={[
                styles.bar,
                {
                  height: 4 + i * 3,
                  backgroundColor:
                    i <= gps.bars ? gps.color : "rgba(214,224,234,0.22)",
                },
              ]}
            />
          ))}
        </View>
        <Text
          style={[
            styles.gpsLabel,
            gps.label === "SIM" && { color: rec.amber },
          ]}
          maxFontSizeMultiplier={1.1}
        >
          {gps.label}
        </Text>
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  round: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  pillLive: {
    borderColor: "rgba(255,90,90,0.35)",
    borderTopColor: "rgba(255,140,140,0.45)",
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  pillLabel: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  pillTime: {
    color: rec.text,
    fontSize: 19,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.2,
  },
  gps: {
    width: 52,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2.5, height: 16 },
  bar: { width: 3.5, borderRadius: 1.5 },
  gpsLabel: {
    color: rec.text,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.6,
  },
});

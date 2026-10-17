// The car's current speed, top centre: the same filtered figure as the
// navigation speed HUD (lib/navigation/speedHud.ts: the newest accepted GPS
// fix; a missing, implausible or stale reading shows "--", never a false 0).
import React from "react";
import { StyleSheet, Text } from "react-native";
import { GlassSurface } from "@/components/Glass";
import { useNavigationSpeed } from "@/context/NavigationContext";
import { speedUnit, type ResolvedUnitSystem } from "@/lib/units";

export default function SpeedCard({ unitSystem }: { unitSystem: ResolvedUnitSystem }) {
  const value = useNavigationSpeed(unitSystem);
  const unit = speedUnit(unitSystem);
  return (
    <GlassSurface
      material="dense"
      accessible
      accessibilityRole="text"
      accessibilityLabel={value == null ? "Speed unavailable" : `Speed ${value} ${unit}`}
      style={styles.card}
    >
      <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1}>
        {value ?? "--"}
      </Text>
      <Text style={styles.unit} maxFontSizeMultiplier={1.1}>{unit.toUpperCase()}</Text>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    minWidth: 104,
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 9,
    borderRadius: 22,
    alignItems: "center",
  },
  value: {
    color: "#FFFFFF",
    fontSize: 46,
    lineHeight: 52,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    letterSpacing: -1,
  },
  unit: { color: "rgba(226,232,238,0.82)", fontSize: 12, fontWeight: "600", letterSpacing: 2.5 },
});

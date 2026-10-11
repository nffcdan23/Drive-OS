/**
 * The upcoming hazard warning while navigating: one small amber pill under
 * the turn card (never on it), e.g. "Accident ahead · 800 yd". Only the most
 * relevant hazard ahead on the route (lib/hazards/warnings); it goes once the
 * car has passed it, it has gone, or a new route no longer passes it.
 * Silent: no voice, no notification.
 */
import React, { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useHazardWarning } from "@/context/HazardsContext";
import { formatGuidanceDistance } from "@/lib/navigation/format";
import { kindInfo } from "@/lib/hazards/model";
import type { ResolvedUnitSystem } from "@/lib/units";

const AMBER = "#F5A524";
const FG = "#F3F5F7";

export const HazardWarningPill = memo(function HazardWarningPill({ unitSystem }: { unitSystem: ResolvedUnitSystem }) {
  const warning = useHazardWarning();
  if (!warning) return null;
  const info = kindInfo(warning.kind);
  // Under 50 m it is here: no distance (it would only count down noise)
  const distance = warning.distanceAheadM >= 50 ? formatGuidanceDistance(warning.distanceAheadM, unitSystem) : null;
  const text = `${info.label} ahead`;
  return (
    // Clear of the controls down the right
    <View style={styles.wrap} pointerEvents="none">
      <View
        style={styles.pill}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={distance ? `${text}, ${distance}` : text}
        accessibilityLiveRegion="polite"
      >
        <View style={[styles.badge, { backgroundColor: info.color }]}>
          <Ionicons name={info.icon as keyof typeof Ionicons.glyphMap} size={13} color="#fff" />
        </View>
        <Text style={styles.text} numberOfLines={1}>
          {text}
          {distance ? <Text style={styles.distance}>{` · ${distance}`}</Text> : null}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { marginTop: 8, marginLeft: 12, marginRight: 70, alignItems: "flex-start" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    height: 34,
    paddingLeft: 6,
    paddingRight: 12,
    borderRadius: 17,
    maxWidth: "100%",
    backgroundColor: "rgba(40,30,8,0.88)",
    borderWidth: 1,
    borderColor: "rgba(245,165,36,0.75)",
  },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  text: { color: FG, fontSize: 14, fontWeight: "700", flexShrink: 1 },
  distance: { color: AMBER, fontWeight: "700", fontVariant: ["tabular-nums"] },
});

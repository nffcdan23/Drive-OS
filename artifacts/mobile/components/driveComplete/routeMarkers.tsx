import React from "react";
import { StyleSheet, View } from "react-native";
import { Glyph } from "@/components/Glyph";

// The Drive map's trail colours (components/MapboxDriveMap.tsx)
export const ROUTE_COLOR = "#00CFE8";
export const ROUTE_GLOW = "rgba(0,207,232,0.28)";

export function StartMarker() {
  return (
    <View accessibilityLabel="Start" style={styles.start}>
      <View style={styles.startDot} />
    </View>
  );
}

export function FinishMarker() {
  return (
    <View accessibilityLabel="Finish" style={styles.finish}>
      <Glyph sf="flag.checkered" ion="flag" size={16} color="#0B0F14" />
    </View>
  );
}

const styles = StyleSheet.create({
  start: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(255,255,255,0.92)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  startDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: "#34C77B" },
  finish: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#FFFFFF",
    borderWidth: 2,
    borderColor: "#0B0F14",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
});

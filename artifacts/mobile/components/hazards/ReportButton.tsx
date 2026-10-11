/**
 * The Report control (navigation and Free Drive): opens the report sheet.
 * One tap here, one on a hazard type, and it is sent.
 */
import React from "react";
import { StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { GlassButton } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";

export function ReportButton({ onPress, style }: { onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <GlassButton
      accessibilityRole="button"
      accessibilityLabel="Report a hazard"
      accessibilityHint="Opens the hazard types. One tap on a type reports it where you are."
      style={[styles.button, style]}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
    >
      <Glyph sf="exclamationmark.triangle.fill" ion="warning" size={17} color="#F5B73B" />
      <Text style={styles.text}>Report</Text>
    </GlassButton>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 46,
    paddingHorizontal: 16,
    borderRadius: 23,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  text: { color: "#F3F5F7", fontSize: 15, fontWeight: "600" },
});

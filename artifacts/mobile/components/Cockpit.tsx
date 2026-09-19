import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import colors, { cockpit } from "@/constants/colors";
const c = colors.dark;
export function ScreenTitle({
  title,
  eyebrow,
}: {
  title: string;
  eyebrow: string;
}) {
  return (
    <View style={{ flexShrink: 1 }}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}
export function Disclosure({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.disclosure}
      >
        <Text style={styles.label}>{title}</Text>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
          color={c.mutedForeground}
        />
      </TouchableOpacity>
      {open && children}
    </View>
  );
}
const styles = StyleSheet.create({
  eyebrow: {
    color: c.primary,
    fontFamily: cockpit.type.label,
    fontSize: 11,
    letterSpacing: 2,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  title: {
    color: c.foreground,
    fontFamily: cockpit.type.display,
    fontSize: 32,
    letterSpacing: -1,
  },
  disclosure: {
    minHeight: cockpit.touch,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  label: {
    color: c.mutedForeground,
    fontFamily: cockpit.type.label,
    fontSize: 13,
  },
});

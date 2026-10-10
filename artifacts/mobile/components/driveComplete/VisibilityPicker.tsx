import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { GlassSurface } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import type { Visibility } from "@/lib/backend/endpoints";

const CYAN = "#3FD6F5";

/** The journey's own visibility values (journeys.visibility on the server). */
export const VISIBILITY_OPTIONS: {
  value: Visibility;
  title: string;
  sf: React.ComponentProps<typeof Glyph>["sf"];
  ion: React.ComponentProps<typeof Glyph>["ion"];
}[] = [
  { value: "private", title: "Only me", sf: "lock", ion: "lock-closed-outline" },
  { value: "friends", title: "Friends", sf: "person.2", ion: "people-outline" },
  { value: "public", title: "Everyone", sf: "globe", ion: "globe-outline" },
];

/** "Who can see this drive?": one choice of three, side by side. */
export default function VisibilityPicker({
  value,
  onChange,
  disabled,
}: {
  value: Visibility;
  onChange: (next: Visibility) => void;
  disabled?: boolean;
}) {
  return (
    <GlassSurface style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">Who can see this drive?</Text>
      <View accessibilityRole="radiogroup" style={styles.options}>
        {VISIBILITY_OPTIONS.map((o) => {
          const selected = o.value === value;
          return (
            <TouchableOpacity
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled }}
              accessibilityLabel={o.title}
              disabled={disabled}
              activeOpacity={0.8}
              onPress={() => onChange(o.value)}
              style={[styles.option, selected && styles.optionOn]}
            >
              <View style={styles.top}>
                <View style={[styles.icon, selected && styles.iconOn]}>
                  <Glyph sf={o.sf} ion={o.ion} size={18} color="#FFFFFF" />
                </View>
                <View style={[styles.radio, selected && styles.radioOn]}>
                  {selected && <View style={styles.radioDot} />}
                </View>
              </View>
              <Text style={styles.optionTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                {o.title}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 22, padding: 13, paddingTop: 15 },
  title: { color: "#FFFFFF", fontSize: 17.5, fontWeight: "600" },
  options: { flexDirection: "row", gap: 10, marginTop: 11 },
  option: {
    flex: 1,
    minHeight: 78,
    padding: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(220,232,244,0.12)",
    backgroundColor: "rgba(255,255,255,0.03)",
    justifyContent: "space-between",
  },
  optionOn: {
    borderColor: CYAN,
    backgroundColor: "rgba(63,214,245,0.10)",
    shadowColor: CYAN,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  iconOn: { backgroundColor: "rgba(63,214,245,0.22)" },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "rgba(214,224,234,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { borderColor: CYAN },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: CYAN },
  optionTitle: { color: "#FFFFFF", fontSize: 14.5, fontWeight: "600", marginTop: 9 },
});

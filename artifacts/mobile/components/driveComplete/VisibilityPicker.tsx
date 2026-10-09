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
  detail: string;
  sf: React.ComponentProps<typeof Glyph>["sf"];
  ion: React.ComponentProps<typeof Glyph>["ion"];
}[] = [
  { value: "private", title: "Only me", detail: "Keep this drive private.", sf: "lock", ion: "lock-closed-outline" },
  { value: "friends", title: "Friends", detail: "Visible to your friends.", sf: "person.2", ion: "people-outline" },
  { value: "public", title: "Everyone", detail: "Visible to the community.", sf: "globe", ion: "globe-outline" },
];

/** "Who can see this drive?": one choice of three. */
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
      <Text style={styles.subtitle}>
        Choose who can see this drive on your profile and in the community.
      </Text>
      <View accessibilityRole="radiogroup" style={styles.options}>
        {VISIBILITY_OPTIONS.map((o) => {
          const selected = o.value === value;
          return (
            <TouchableOpacity
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled }}
              accessibilityLabel={`${o.title}. ${o.detail}`}
              disabled={disabled}
              activeOpacity={0.8}
              onPress={() => onChange(o.value)}
              style={[styles.option, selected && styles.optionOn]}
            >
              <View style={[styles.icon, selected && styles.iconOn]}>
                <Glyph sf={o.sf} ion={o.ion} size={22} color="#FFFFFF" />
              </View>
              <View style={styles.text}>
                <Text style={styles.optionTitle}>{o.title}</Text>
                <Text style={styles.optionDetail}>{o.detail}</Text>
              </View>
              <View style={[styles.radio, selected && styles.radioOn]}>
                {selected && <View style={styles.radioDot} />}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 26, padding: 18, paddingTop: 20 },
  title: { color: "#FFFFFF", fontSize: 21, fontWeight: "600" },
  subtitle: { color: "rgba(214,224,234,0.72)", fontSize: 14.5, lineHeight: 20, marginTop: 6 },
  options: { gap: 10, marginTop: 16 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 64,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(220,232,244,0.12)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  optionOn: { borderColor: CYAN, backgroundColor: "rgba(63,214,245,0.10)" },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  iconOn: { backgroundColor: "rgba(63,214,245,0.22)" },
  text: { flex: 1 },
  optionTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  optionDetail: { color: "rgba(214,224,234,0.72)", fontSize: 13.5, marginTop: 2 },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "rgba(214,224,234,0.5)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
  },
  radioOn: { borderColor: CYAN, backgroundColor: CYAN },
  radioDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#04121B" },
});

import React, { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Glyph } from "@/components/Glyph";
import { rec } from "./shared";

type GlyphProps = React.ComponentProps<typeof Glyph>;

/** One live figure in the HUD: icon, value and a short label. */
function DriveStat({
  sf,
  ion,
  value,
  label,
}: {
  sf: GlyphProps["sf"];
  ion: GlyphProps["ion"];
  value: string;
  label: string;
}) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={styles.stat}>
      <Glyph sf={sf} ion={ion} size={17} color={rec.cyan} />
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        style={styles.value}
        maxFontSizeMultiplier={1.15}
      >
        {value}
      </Text>
      <Text numberOfLines={1} style={styles.label} maxFontSizeMultiplier={1.15}>
        {label}
      </Text>
    </View>
  );
}

export default memo(DriveStat);

const styles = StyleSheet.create({
  stat: { alignItems: "center", paddingVertical: 6, gap: 3 },
  value: {
    color: rec.text,
    fontSize: 18,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    marginTop: 2,
  },
  label: { color: rec.textMuted, fontSize: 11.5 },
});

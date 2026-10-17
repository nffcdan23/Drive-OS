// Current weather from Apple WeatherKit (hooks/useDriveWeather.ts): the
// condition's icon and the temperature in °C. Hidden when there is none.
// Apple's attribution (the Apple Weather mark and the legal link to its
// data sources) is one tap away on the chip, so it doesn't clutter the map.
import React, { useState } from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Image } from "expo-image";
import type { SFSymbol } from "expo-symbols";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { fetchWeatherAttribution, type WeatherAttribution } from "@/modules/derwent-weather";
import { formatTemperatureC, type CurrentWeather } from "@/lib/weather/driveWeather";

// Apple's published legal attribution page, if WeatherKit's own link can't be fetched
const FALLBACK_LEGAL_URL = "https://weatherkit.apple.com/legal-attribution.html";

export default function WeatherChip({ weather }: { weather: CurrentWeather | null }) {
  const [open, setOpen] = useState(false);
  const [attribution, setAttribution] = useState<WeatherAttribution | null>(null);
  if (!weather) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !attribution) {
      fetchWeatherAttribution().then(setAttribution).catch(() => {});
    }
  };

  const temperature = formatTemperatureC(weather.temperatureC);
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <GlassButton
        accessibilityLabel={`${weather.condition}, ${temperature}`}
        accessibilityHint="Shows the weather data attribution"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        style={styles.chip}
      >
        <Glyph sf={(weather.symbolName || "cloud") as SFSymbol} ion="cloud-outline" size={22} color="#F3F5F7" />
        <Text style={styles.temp} maxFontSizeMultiplier={1.15}>{temperature}</Text>
      </GlassButton>
      {open && (
        <GlassSurface material="dense" style={styles.popover}>
          {attribution?.combinedMarkDarkURL ? (
            <Image
              source={{ uri: attribution.combinedMarkDarkURL }}
              style={styles.mark}
              contentFit="contain"
              accessibilityLabel="Apple Weather"
            />
          ) : (
            <Text style={styles.markText}>{""} Weather</Text>
          )}
          <Text style={styles.condition}>{weather.condition}</Text>
          <TouchableOpacity
            accessibilityRole="link"
            onPress={() => void Linking.openURL(attribution?.legalPageURL || FALLBACK_LEGAL_URL)}
            hitSlop={8}
          >
            <Text style={styles.link}>Other data sources</Text>
          </TouchableOpacity>
        </GlassSurface>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-end" },
  chip: {
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  temp: { color: "#F3F5F7", fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  popover: { marginTop: 8, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 6, alignItems: "flex-end" },
  mark: { width: 96, height: 20 },
  markText: { color: "#F3F5F7", fontSize: 14, fontWeight: "600" },
  condition: { color: "rgba(226,232,238,0.8)", fontSize: 13 },
  link: { color: "#3FD6F5", fontSize: 13, fontWeight: "600" },
});

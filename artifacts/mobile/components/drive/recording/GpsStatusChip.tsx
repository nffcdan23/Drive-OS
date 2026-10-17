// Live GPS quality (lib/gpsQuality.ts) from the newest fix the Drive screen
// accepted (the same fix feed navigation and the speed read; no listener of
// its own), re-checked every few seconds so a fix that stops coming shows.
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { GlassSurface } from "@/components/Glass";
import { useLatestNavigationFix } from "@/context/NavigationContext";
import { GPS_QUALITY, gpsQuality, type GpsLevel, type GpsQuality } from "@/lib/gpsQuality";

const LEVEL_COLOUR: Record<GpsLevel, string> = {
  excellent: "#34D399",
  strong: "#34D399",
  fair: "#F5B73B",
  weak: "#FF8A3D",
  lost: "#FF5A5A",
};

export default function GpsStatusChip({ locationMode }: { locationMode: "live" | "simulated" }) {
  const latestFix = useLatestNavigationFix();
  const [quality, setQuality] = useState<GpsQuality>(() =>
    gpsQuality({ locationMode, fix: null, now: Date.now() }),
  );

  useEffect(() => {
    const tick = () => {
      const f = latestFix();
      const next = gpsQuality({
        locationMode,
        fix: f ? { accuracyM: f.accuracyM ?? null, timestamp: f.timestamp } : null,
        now: Date.now(),
      });
      setQuality((prev) => (prev.level === next.level ? prev : next));
    };
    tick();
    const timer = setInterval(tick, GPS_QUALITY.recheckMs);
    return () => clearInterval(timer);
  }, [latestFix, locationMode]);

  const colour = LEVEL_COLOUR[quality.level];
  return (
    <GlassSurface
      accessible
      accessibilityRole="text"
      accessibilityLabel={`GPS ${quality.label}`}
      style={styles.chip}
    >
      <View style={styles.top}>
        <Text style={styles.gps} maxFontSizeMultiplier={1.15}>GPS</Text>
        <View style={styles.bars}>
          {[1, 2, 3, 4].map((i) => (
            <View
              key={i}
              style={[
                styles.bar,
                { height: 4 + i * 2.5, backgroundColor: i <= quality.bars ? colour : "rgba(214,224,234,0.22)" },
              ]}
            />
          ))}
        </View>
      </View>
      <Text style={[styles.label, { color: colour }]} numberOfLines={1} maxFontSizeMultiplier={1.15}>
        {quality.label}
      </Text>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  // Two short lines, so the chip stays clear of the speed card on any phone
  chip: {
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  top: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  gps: { color: "#F3F5F7", fontSize: 13, lineHeight: 15, fontWeight: "700", letterSpacing: 0.4 },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 14, paddingBottom: 1.5 },
  bar: { width: 3.5, borderRadius: 1.25 },
  label: { fontSize: 11, lineHeight: 13, fontWeight: "600", marginTop: 1 },
});

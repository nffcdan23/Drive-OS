import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { GlassSurface } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { LEVEL_XP } from "@/lib/driveRewards";

const RING = 78;
const STROKE = 6.5;

/** Thousands separators without relying on the JS engine's Intl support. */
function grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * XP from this drive (ring: its share of a level), the level with progress to
 * the next, and the day streak.
 */
export default function RewardsCard({
  xpEarned,
  level,
  levelFraction,
  xp,
  nextLevelXp,
  streakDays,
}: {
  /** null until the server has worked it out (the drive is still uploading) */
  xpEarned: number | null;
  level: number;
  levelFraction: number;
  xp: number;
  nextLevelXp: number;
  streakDays: number;
}) {
  const r = (RING - STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  const ringFraction = xpEarned == null ? 0 : Math.min(1, xpEarned / LEVEL_XP);

  return (
    <GlassSurface style={styles.card}>
      <View
        accessible
        accessibilityLabel={xpEarned == null ? "XP is added once this drive has synced" : `${xpEarned} XP earned`}
        style={styles.ring}
      >
        <Svg width={RING} height={RING} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id="xpRing" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#6FE6FF" />
              <Stop offset="1" stopColor="#1E8CFF" />
            </LinearGradient>
          </Defs>
          <Circle cx={RING / 2} cy={RING / 2} r={r} stroke="rgba(214,224,234,0.14)" strokeWidth={STROKE} fill="none" />
          <Circle
            cx={RING / 2}
            cy={RING / 2}
            r={r}
            stroke="url(#xpRing)"
            strokeWidth={STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - ringFraction)}
            transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
          />
        </Svg>
        <Text style={styles.xpValue} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.1}>
          {xpEarned == null ? "…" : `+${grouped(xpEarned)}`}
        </Text>
        <Text style={styles.xpLabel}>{xpEarned == null ? "XP soon" : "XP"}</Text>
      </View>

      <View
        accessible
        accessibilityLabel={`Level ${level}, ${grouped(xp)} of ${grouped(nextLevelXp)} XP`}
        style={styles.level}
      >
        <Text style={styles.levelTitle}>Level {level}</Text>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.round(levelFraction * 100)}%` }]} />
        </View>
        <Text style={styles.levelXp} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.1}>
          {grouped(xp)} / {grouped(nextLevelXp)} XP
        </Text>
      </View>

      <View
        accessible
        accessibilityLabel={`${streakDays} day streak`}
        style={styles.streak}
      >
        <Glyph sf="flame.fill" ion="flame" size={25} color="#FF8A3D" />
        <Text style={styles.streakValue}>{streakDays}</Text>
        <Text style={styles.streakLabel} numberOfLines={1}>Day Streak</Text>
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", borderRadius: 22, paddingVertical: 11, paddingLeft: 13, paddingRight: 8, gap: 13 },
  ring: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
  xpValue: { color: "#FFFFFF", fontSize: 18, fontWeight: "700", maxWidth: RING - 22, fontVariant: ["tabular-nums"] },
  xpLabel: { color: "rgba(214,224,234,0.72)", fontSize: 11, marginTop: 1 },
  level: { flex: 1, minWidth: 0, gap: 8 },
  levelTitle: { color: "#FFFFFF", fontSize: 15.5, fontWeight: "600" },
  bar: { height: 7, borderRadius: 4, backgroundColor: "rgba(214,224,234,0.14)", overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4, backgroundColor: "#3FD6F5" },
  levelXp: { color: "rgba(214,224,234,0.72)", fontSize: 12, fontVariant: ["tabular-nums"] },
  streak: {
    width: 92,
    alignItems: "center",
    gap: 2,
    paddingLeft: 8,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: "rgba(220,232,244,0.18)",
  },
  streakValue: { color: "#FFFFFF", fontSize: 20, fontWeight: "700", marginTop: 4, fontVariant: ["tabular-nums"] },
  streakLabel: { color: "rgba(214,224,234,0.78)", fontSize: 12 },
});

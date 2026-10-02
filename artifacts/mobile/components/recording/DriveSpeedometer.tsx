import React, { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import Svg, {
  Defs,
  Line,
  LinearGradient,
  Path,
  Stop,
} from "react-native-svg";
import { useReducedMotion } from "@/components/Glass";
import { speedUnit, type ResolvedUnitSystem } from "@/lib/units";
import { rec, toDisplaySpeed } from "./shared";

// react-native-svg on the web passes Animated's props through to the DOM, so
// the web build draws the arc without easing.
const AnimatedPath = Animated.createAnimatedComponent(Path);
const ArcPath = (
  Platform.OS === "web" ? Path : AnimatedPath
) as typeof AnimatedPath;

// The dial opens downwards: 216° of arc, from lower left to lower right.
const START_DEG = 162;
const SWEEP_DEG = 216;

// 0–120 mph, or the same road speeds in km/h.
const SCALES: Record<
  ResolvedUnitSystem,
  { max: number; major: number; minor: number }
> = {
  imperial: { max: 120, major: 20, minor: 10 },
  metric: { max: 200, major: 40, minor: 20 },
};

function geometry(size: number) {
  const stroke = Math.round(size * 0.055);
  const r = size / 2 - stroke * 1.3;
  const cx = size / 2;
  const cy = r + stroke * 1.3;
  const height = Math.ceil(
    cy + r * Math.sin((START_DEG * Math.PI) / 180) + stroke * 1.4,
  );
  const point = (deg: number, radius: number) => ({
    x: cx + radius * Math.cos((deg * Math.PI) / 180),
    y: cy + radius * Math.sin((deg * Math.PI) / 180),
  });
  const s = point(START_DEG, r);
  const e = point(START_DEG + SWEEP_DEG, r);
  const arc = `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 1 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  const length = (r * SWEEP_DEG * Math.PI) / 180;
  return { stroke, r, cx, cy, height, point, arc, length };
}

/** Track and ticks: redrawn only when the size or units change. */
const Dial = memo(function Dial({
  size,
  unitSystem,
}: {
  size: number;
  unitSystem: ResolvedUnitSystem;
}) {
  const g = geometry(size);
  const { max, major, minor } = SCALES[unitSystem];
  const tickOuter = g.r - g.stroke / 2 - 4;
  const ticks = [];
  for (let v = 0; v <= max; v += minor) {
    const isMajor = v % major === 0;
    const deg = START_DEG + (v / max) * SWEEP_DEG;
    const a = g.point(deg, tickOuter);
    const b = g.point(deg, tickOuter - (isMajor ? 7 : 4));
    ticks.push(
      <Line
        key={v}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={isMajor ? "rgba(235,244,255,0.85)" : "rgba(214,224,234,0.4)"}
        strokeWidth={isMajor ? 1.6 : 1}
        strokeLinecap="round"
      />,
    );
  }
  return (
    <>
      <Path
        d={g.arc}
        fill="none"
        stroke="rgba(214,224,234,0.12)"
        strokeWidth={g.stroke}
        strokeLinecap="round"
      />
      {ticks}
    </>
  );
});

/** Scale numbers as app text (SVG text would use another font). */
const DialLabels = memo(function DialLabels({
  size,
  unitSystem,
}: {
  size: number;
  unitSystem: ResolvedUnitSystem;
}) {
  const g = geometry(size);
  const { max, major } = SCALES[unitSystem];
  const radius = g.r - g.stroke / 2 - 24;
  const font = Math.round(size * 0.06);
  const box = font * 2.4;
  const labels = [];
  for (let v = 0; v <= max; v += major) {
    const p = g.point(START_DEG + (v / max) * SWEEP_DEG, radius);
    labels.push(
      <Text
        key={v}
        maxFontSizeMultiplier={1}
        style={[
          styles.scale,
          {
            fontSize: font,
            lineHeight: font * 1.2,
            width: box,
            left: p.x - box / 2,
            top: p.y - font * 0.6,
          },
        ]}
      >
        {v}
      </Text>,
    );
  }
  return <>{labels}</>;
});

/**
 * Semi-circular speedometer. Speed comes straight from GPS (km/h) and is shown
 * in the user's units; the arc eases between fixes so it reads smoothly.
 */
function DriveSpeedometer({
  speedKmh,
  unitSystem,
  size,
}: {
  speedKmh: number;
  unitSystem: ResolvedUnitSystem;
  size: number;
}) {
  const reduceMotion = useReducedMotion();
  const g = useMemo(() => geometry(size), [size]);
  const speed = toDisplaySpeed(speedKmh, unitSystem);
  const rounded = Math.round(speed);
  const fraction = Math.min(1, speed / SCALES[unitSystem].max);
  const unit = speedUnit(unitSystem);

  const progress = useRef(new Animated.Value(fraction)).current;
  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(fraction);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: fraction,
      duration: 650,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [fraction, reduceMotion, progress]);
  const dashOffset =
    Platform.OS === "web"
      ? g.length * (1 - fraction)
      : progress.interpolate({
          inputRange: [0, 1],
          outputRange: [g.length, 0],
        });

  const numberSize = Math.round(size * 0.245);
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Speed ${rounded} ${unit === "mph" ? "miles per hour" : "kilometres per hour"}`}
      style={{ width: size, height: g.height }}
    >
      <Svg width={size} height={g.height}>
        <Defs>
          <LinearGradient id="speedArc" x1="0" y1="0" x2={size} y2="0" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={rec.cyanBright} />
            <Stop offset="0.55" stopColor={rec.cyan} />
            <Stop offset="1" stopColor={rec.blue} />
          </LinearGradient>
        </Defs>
        <Dial size={size} unitSystem={unitSystem} />
        {/* Soft glow under the live arc */}
        <ArcPath
          d={g.arc}
          fill="none"
          stroke="url(#speedArc)"
          strokeOpacity={0.22}
          strokeWidth={g.stroke * 2.4}
          strokeLinecap="round"
          strokeDasharray={[g.length, g.length]}
          strokeDashoffset={dashOffset}
        />
        <ArcPath
          d={g.arc}
          fill="none"
          stroke="url(#speedArc)"
          strokeWidth={g.stroke}
          strokeLinecap="round"
          strokeDasharray={[g.length, g.length]}
          strokeDashoffset={dashOffset}
        />
      </Svg>
      <DialLabels size={size} unitSystem={unitSystem} />
      <View
        pointerEvents="none"
        style={[styles.centre, { top: g.cy - numberSize * 0.5 - 17 }]}
      >
        <Text style={styles.caption} maxFontSizeMultiplier={1}>
          SPEED
        </Text>
        <Text
          style={[
            styles.value,
            { fontSize: numberSize, lineHeight: numberSize * 1.08 },
          ]}
          maxFontSizeMultiplier={1}
        >
          {rounded}
        </Text>
        <Text style={styles.unit} maxFontSizeMultiplier={1}>
          {unit}
        </Text>
      </View>
    </View>
  );
}

export default memo(DriveSpeedometer);

const styles = StyleSheet.create({
  centre: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  caption: {
    color: rec.textMuted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1.6,
    marginBottom: 2,
  },
  value: {
    color: rec.text,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    letterSpacing: -1,
    textShadowColor: "rgba(0,207,232,0.35)",
    textShadowRadius: 12,
  },
  unit: { color: rec.textMuted, fontSize: 14, fontWeight: "500" },
  scale: {
    position: "absolute",
    textAlign: "center",
    color: "rgba(226,234,242,0.8)",
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
});

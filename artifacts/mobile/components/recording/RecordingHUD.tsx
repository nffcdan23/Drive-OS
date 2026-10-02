import React, { useEffect, useRef } from "react";
import {
  Animated,
  StyleSheet,
  View,
  useWindowDimensions,
  type ViewProps,
} from "react-native";
import { GlassBackground, useReducedMotion } from "@/components/Glass";
import { formatDistance, formatSpeed, type ResolvedUnitSystem } from "@/lib/units";
import DriveSpeedometer from "./DriveSpeedometer";
import DriveStat from "./DriveStat";
import RecordingControls from "./RecordingControls";
import { formatElapsed, rec } from "./shared";

const RADIUS = 30;

/**
 * The bottom glass panel: speedometer between the live stats, then the drive
 * controls. Kept to roughly the bottom third so the map stays the focus.
 */
export default function RecordingHUD({
  speedKmh,
  seconds,
  distanceKm,
  avgSpeedKmh,
  topSpeedKmh,
  unitSystem,
  isPaused,
  bottomInset,
  onPause,
  onResume,
  onFinish,
  onAddMarker,
  onLayout,
}: {
  speedKmh: number;
  seconds: number;
  distanceKm: number;
  avgSpeedKmh: number;
  topSpeedKmh: number;
  unitSystem: ResolvedUnitSystem;
  isPaused: boolean;
  bottomInset: number;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  onAddMarker: () => Promise<boolean> | boolean;
  onLayout?: ViewProps["onLayout"];
}) {
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  // Fits between the two stat columns on a 375pt phone, smaller on short ones.
  const dialSize = Math.round(
    Math.min(206, Math.max(168, width * 0.5), height < 700 ? 172 : 206),
  );

  const enter = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(enter, {
      toValue: 1,
      stiffness: 180,
      damping: 24,
      mass: 0.9,
      useNativeDriver: true,
    }).start();
  }, [enter]);

  // Paused: the live figures step back so the state reads at a glance.
  const live = useRef(new Animated.Value(isPaused ? 0.45 : 1)).current;
  useEffect(() => {
    Animated.timing(live, {
      toValue: isPaused ? 0.45 : 1,
      duration: reduceMotion ? 0 : 260,
      useNativeDriver: true,
    }).start();
  }, [isPaused, reduceMotion, live]);

  return (
    <Animated.View
      onLayout={onLayout}
      style={[
        styles.panel,
        {
          paddingBottom: Math.max(bottomInset, 12) + 6,
          opacity: enter,
          transform: [
            {
              translateY: enter.interpolate({
                inputRange: [0, 1],
                outputRange: [48, 0],
              }),
            },
          ],
        },
      ]}
    >
      <GlassBackground
        material="dense"
        shape={{ borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS }}
      />
      <Animated.View style={[styles.readout, { opacity: live }]}>
        <View style={styles.column}>
          <DriveStat
            sf="clock"
            ion="time-outline"
            value={formatElapsed(seconds)}
            label="Elapsed Time"
          />
          <View style={styles.divider} />
          <DriveStat
            sf="point.topleft.down.to.point.bottomright.curvepath"
            ion="git-commit-outline"
            value={formatDistance(distanceKm, unitSystem)}
            label="Distance"
          />
        </View>
        <DriveSpeedometer
          speedKmh={speedKmh}
          unitSystem={unitSystem}
          size={dialSize}
        />
        <View style={styles.column}>
          <DriveStat
            sf="gauge.with.dots.needle.33percent"
            ion="speedometer-outline"
            value={formatSpeed(avgSpeedKmh, unitSystem)}
            label="Avg. Speed"
          />
          <View style={styles.divider} />
          <DriveStat
            sf="bolt.fill"
            ion="flash-outline"
            value={formatSpeed(topSpeedKmh, unitSystem)}
            label="Top Speed"
          />
        </View>
      </Animated.View>
      <RecordingControls
        isPaused={isPaused}
        onPause={onPause}
        onResume={onResume}
        onFinish={onFinish}
        onAddMarker={onAddMarker}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 14,
    paddingHorizontal: 14,
    borderTopLeftRadius: RADIUS,
    borderTopRightRadius: RADIUS,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(220,232,244,0.14)",
    borderTopColor: "rgba(235,244,255,0.26)",
  },
  readout: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  column: { flex: 1, minWidth: 0 },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 10,
    backgroundColor: rec.hairline,
  },
});

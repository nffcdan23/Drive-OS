/**
 * ActiveDriveOverlay
 *
 * Everything drawn over the map while a drive is recorded. The map stays the
 * focus (top two thirds); the open areas pass touches through to MapView so
 * it can still be panned, pinched and rotated. All values come from the live
 * drive: timer, GPS state, speed and stats. Recording, pausing and finishing
 * are the Drive screen's own handlers; this file only lays them out.
 */
import React, { useCallback, useState } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { useApp, type ActiveDrive } from "@/context/AppContext";
import { type ResolvedUnitSystem } from "@/lib/units";
import DriveInfoCard from "@/components/recording/DriveInfoCard";
import RecordingHUD from "@/components/recording/RecordingHUD";
import RecordingStatus from "@/components/recording/RecordingStatus";
import { confirmFinishDrive } from "@/components/recording/RecordingControls";
import { averageSpeedKmh, rec } from "@/components/recording/shared";

export type ActiveDriveMode = "navigation" | "tracking";

export interface NavInstruction {
  manoeuvreIcon: string; // Ionicons name
  distanceMetres: number;
  instruction: string;
  roadName: string;
}

interface Props {
  currentDrive: ActiveDrive | null;
  driveSeconds: number;
  isPaused: boolean;
  driveMode: ActiveDriveMode;
  locationMode: "live" | "simulated";
  gpsAccuracy: number | null;
  accuracyWarning: boolean;
  followMode: "following" | "free";
  headingMode: "heading-up" | "north-up";
  resolvedUnitSystem: ResolvedUnitSystem;
  isPassengerMode: boolean;
  navInstruction?: NavInstruction | null;
  insets: { top: number; bottom: number };

  onPause: () => void;
  onResume: () => void;
  onEndDrive: () => void;
  /** Saves the current position as a marker; resolves true when saved. */
  onSavePoint: () => Promise<boolean> | boolean;
  onLocateButton: () => void;
  onResumeFollowing: () => void;
  onToggleHeading: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

const STATUS_HEIGHT = 48;
const INFO_HEIGHT = 64;
const GAP = 10;

export default function ActiveDriveOverlay({
  currentDrive,
  driveSeconds,
  isPaused,
  driveMode,
  locationMode,
  gpsAccuracy,
  accuracyWarning,
  followMode,
  headingMode,
  resolvedUnitSystem,
  isPassengerMode,
  navInstruction,
  insets,
  onPause,
  onResume,
  onEndDrive,
  onSavePoint,
  onLocateButton,
  onResumeFollowing,
  onToggleHeading,
  onZoomIn,
  onZoomOut,
}: Props) {
  const { activeVehicle } = useApp();
  // Until the HUD has measured itself, assume roughly a third of an iPhone.
  const [hudHeight, setHudHeight] = useState(300);
  const onHudLayout = useCallback((e: LayoutChangeEvent) => {
    setHudHeight(Math.round(e.nativeEvent.layout.height));
  }, []);

  const close = useCallback(() => {
    confirmFinishDrive(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onEndDrive();
    });
  }, [onEndDrive]);

  const statusTop = insets.top + 6;
  const infoTop = statusTop + STATUS_HEIGHT + GAP;
  const belowInfo = infoTop + INFO_HEIGHT + 14;
  const showNav = driveMode === "navigation" && !!navInstruction;
  const noticesTop = belowInfo + (showNav ? 84 : 0);

  const vehicleName = activeVehicle
    ? activeVehicle.nickname ||
      `${activeVehicle.make} ${activeVehicle.model}`.trim() ||
      null
    : null;
  const state = isPassengerMode
    ? "passenger"
    : isPaused
      ? "paused"
      : "recording";

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <RecordingStatus
        state={state}
        seconds={driveSeconds}
        locationMode={locationMode}
        gpsAccuracy={gpsAccuracy}
        top={statusTop}
        onClose={close}
      />

      <View style={[styles.info, { top: infoTop }]} pointerEvents="box-none">
        <DriveInfoCard
          vehicleName={vehicleName}
          vehicleImageUri={activeVehicle?.imageUri ?? null}
          startTime={currentDrive?.startTime ?? null}
          isPassengerMode={isPassengerMode}
        />
      </View>

      {/* Turn-by-turn, only when a navigation instruction is supplied */}
      {showNav && navInstruction && (
        <GlassSurface
          material="dense"
          style={[styles.nav, { top: belowInfo }]}
        >
          <Ionicons
            name={navInstruction.manoeuvreIcon as never}
            size={30}
            color={rec.cyan}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.navDistance}>
              {Math.round(navInstruction.distanceMetres)} m
            </Text>
            <Text numberOfLines={1} style={styles.navText}>
              {navInstruction.instruction} · {navInstruction.roadName}
            </Text>
          </View>
        </GlassSurface>
      )}

      {/* Status notices, top left under the drive card */}
      <View
        style={[styles.notices, { top: noticesTop }]}
        pointerEvents="none"
      >
        {accuracyWarning && (
          <View style={[styles.notice, styles.noticeWarn]}>
            <Ionicons name="warning" size={12} color="#1C1500" />
            <Text style={styles.noticeWarnText}>Poor GPS signal</Text>
          </View>
        )}
        {isPassengerMode && (
          <View style={styles.notice}>
            <Ionicons name="walk-outline" size={12} color={rec.text} />
            <Text style={styles.noticeText}>Passenger Mode: not recording</Text>
          </View>
        )}
      </View>

      {/* Map controls, stacked on the right */}
      <View
        style={[styles.controls, { top: noticesTop }]}
        pointerEvents="box-none"
      >
        <GlassButton
          accessibilityLabel={
            headingMode === "heading-up"
              ? "Map follows your heading. Switch to north up"
              : "Map is north up. Switch to follow your heading"
          }
          onPress={onToggleHeading}
          style={styles.control}
        >
          <Glyph
            sf={headingMode === "heading-up" ? "location.north.line.fill" : "location.north.line"}
            ion={headingMode === "heading-up" ? "compass" : "compass-outline"}
            size={21}
            color={headingMode === "north-up" ? rec.cyan : rec.text}
          />
        </GlassButton>
        <GlassButton
          accessibilityLabel={
            followMode === "following" ? "Re-centre on your position" : "Follow your position"
          }
          accessibilityState={{ selected: followMode === "following" }}
          onPress={onLocateButton}
          style={styles.control}
        >
          <Glyph
            sf={followMode === "following" ? "location.fill" : "location"}
            ion={followMode === "following" ? "navigate" : "navigate-outline"}
            size={20}
            color={followMode === "following" ? rec.cyan : rec.text}
          />
        </GlassButton>
        <GlassSurface style={styles.zoom}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Zoom in"
            onPress={onZoomIn}
            style={styles.zoomHalf}
          >
            <Glyph sf="plus" ion="add" size={20} color={rec.text} />
          </TouchableOpacity>
          <View style={styles.zoomDivider} />
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Zoom out"
            onPress={onZoomOut}
            style={styles.zoomHalf}
          >
            <Glyph sf="minus" ion="remove" size={20} color={rec.text} />
          </TouchableOpacity>
        </GlassSurface>
      </View>

      {/* Back to following after the map was moved by hand */}
      {followMode === "free" && (
        <View
          style={[styles.resume, { bottom: hudHeight + 14 }]}
          pointerEvents="box-none"
        >
          <GlassButton
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onResumeFollowing();
            }}
            style={styles.resumeInner}
          >
            <Ionicons name="navigate" size={16} color={rec.cyan} />
            <Text style={styles.resumeText}>Resume following</Text>
          </GlassButton>
        </View>
      )}

      <RecordingHUD
        speedKmh={Math.max(0, currentDrive?.currentSpeed ?? 0)}
        seconds={driveSeconds}
        distanceKm={currentDrive?.estimatedDistance ?? 0}
        avgSpeedKmh={averageSpeedKmh(currentDrive)}
        topSpeedKmh={Math.max(0, currentDrive?.topSpeed ?? 0)}
        unitSystem={resolvedUnitSystem}
        isPaused={isPaused}
        bottomInset={insets.bottom}
        onPause={onPause}
        onResume={onResume}
        onFinish={onEndDrive}
        onAddMarker={onSavePoint}
        onLayout={onHudLayout}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  info: { position: "absolute", left: 16, right: 16 },
  nav: {
    position: "absolute",
    left: 16,
    right: 76,
    height: 70,
    borderRadius: 20,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  navDistance: { color: rec.text, fontSize: 22, fontWeight: "700" },
  navText: { color: rec.textMuted, fontSize: 13, marginTop: 2 },
  notices: { position: "absolute", left: 16, right: 76, gap: 8, alignItems: "flex-start" },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: "rgba(10,14,18,0.78)",
  },
  noticeText: { color: rec.text, fontSize: 12, fontWeight: "600" },
  noticeWarn: { backgroundColor: "rgba(245,184,61,0.94)" },
  noticeWarnText: { color: "#1C1500", fontSize: 12, fontWeight: "600" },
  controls: { position: "absolute", right: 16, gap: 12 },
  control: {
    width: 48,
    height: 48,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  zoom: { width: 48, borderRadius: 15 },
  zoomHalf: { height: 46, alignItems: "center", justifyContent: "center" },
  zoomDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 10,
    backgroundColor: "rgba(220,232,244,0.22)",
  },
  resume: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  resumeInner: {
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  resumeText: { color: rec.text, fontSize: 15, fontWeight: "600" },
});

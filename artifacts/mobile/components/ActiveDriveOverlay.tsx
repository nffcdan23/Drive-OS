/**
 * ActiveDriveOverlay
 *
 * The recording screen, drawn over the full-screen map during a free drive:
 * live GPS quality, the current speed and the weather along the top; the map
 * buttons down the right and Report at the lower left; and one floating panel
 * at the bottom with the drive's time, distance and top speed, Save Point and
 * Stop Drive. Everything else is open map, and touches there reach the map.
 */
import React, { useCallback } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassButton } from "@/components/Glass";
import { ReportButton } from "@/components/hazards/ReportButton";
import DriveStatsPanel from "@/components/drive/recording/DriveStatsPanel";
import GpsStatusChip from "@/components/drive/recording/GpsStatusChip";
import MapControlColumn, { type MapLayerOption } from "@/components/drive/recording/MapControlColumn";
import SpeedCard from "@/components/drive/recording/SpeedCard";
import WeatherChip from "@/components/drive/recording/WeatherChip";
import { ActiveDrive } from "@/context/AppContext";
import { useLatestNavigationFix } from "@/context/NavigationContext";
import { useDriveWeather } from "@/hooks/useDriveWeather";
import { ResolvedUnitSystem } from "@/lib/units";

interface Props<T extends string> {
  currentDrive: ActiveDrive | null;
  driveSeconds: number;
  isPaused: boolean;
  locationMode: "live" | "simulated";
  followMode: "following" | "free";
  resolvedUnitSystem: ResolvedUnitSystem;
  isPassengerMode: boolean;
  insets: { top: number; bottom: number };
  mapType: T;
  mapLayers: ReadonlyArray<MapLayerOption<T>>;
  onSelectMapType: (type: T) => void;

  onPause: () => void;
  onResume: () => void;
  onEndDrive: () => void;
  /** Saves a point where the car is: null when saved, else why it wasn't */
  onSavePoint: () => Promise<string | null>;
  onLocateButton: () => void;
  onResumeFollowing: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Height of the open map area above the drive panel (layout only) */
  onMapAreaLayout?: (height: number) => void;
  /** Opens the hazard report sheet: a Report button at the map area's lower left */
  onReport?: () => void;
}

/** Clear of the Mapbox logo and attribution, which sit just above the panel */
const CONTROLS_BOTTOM = 34;
const ACTIVE = "#3FD6F5";

export default function ActiveDriveOverlay<T extends string>({
  currentDrive,
  driveSeconds,
  isPaused,
  locationMode,
  followMode,
  resolvedUnitSystem,
  isPassengerMode,
  insets,
  mapType,
  mapLayers,
  onSelectMapType,
  onPause,
  onResume,
  onEndDrive,
  onSavePoint,
  onLocateButton,
  onResumeFollowing,
  onZoomIn,
  onZoomOut,
  onMapAreaLayout,
  onReport,
}: Props<T>) {
  // Weather where the car is, from the same accepted fixes as everything else
  const latestFix = useLatestNavigationFix();
  const weatherPosition = useCallback(() => {
    const f = latestFix();
    return f ? { latitude: f.latitude, longitude: f.longitude } : null;
  }, [latestFix]);
  const weather = useDriveWeather(true, weatherPosition);

  const free = followMode === "free";

  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: "box-none" as any }]}>
      {/* ── Open map area ── */}
      <View
        style={[styles.mapArea, { pointerEvents: "box-none" as any }]}
        onLayout={onMapAreaLayout ? (e) => onMapAreaLayout(e.nativeEvent.layout.height) : undefined}
      >
        {/* Top row: GPS · speed · weather */}
        <View style={[styles.topRow, { top: insets.top + 6, pointerEvents: "box-none" as any }]}>
          <View style={[styles.topSide, { pointerEvents: "box-none" as any }]}>
            <GpsStatusChip locationMode={locationMode} />
          </View>
          <SpeedCard unitSystem={resolvedUnitSystem} />
          <View style={[styles.topSide, styles.topRight, { pointerEvents: "box-none" as any }]}>
            <WeatherChip weather={weather} />
          </View>
        </View>

        {/* Report a hazard: lower left, opposite the map buttons */}
        {onReport ? (
          <View
            style={[
              styles.reportWrap,
              // Above the centred "Resume following" pill while it shows (narrow phones)
              { bottom: CONTROLS_BOTTOM + (free ? 56 : 0) },
            ]}
            pointerEvents="box-none"
          >
            <ReportButton onPress={onReport} />
          </View>
        ) : null}

        {/* Resume following pill */}
        {free && (
          <View style={styles.resumePill} pointerEvents="box-none">
            <GlassButton
              style={styles.resumePillInner}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onResumeFollowing();
              }}
            >
              <Ionicons name="navigate" size={16} color={ACTIVE} />
              <Text style={styles.resumePillText}>Resume following</Text>
            </GlassButton>
          </View>
        )}

        {/* Passenger mode note */}
        {isPassengerMode && (
          <View style={[styles.passengerNote, free && { bottom: CONTROLS_BOTTOM + 112 }]} pointerEvents="none">
            <Ionicons name="walk-outline" size={12} color="#fff" />
            <Text style={styles.passengerNoteText}>Passenger Mode — not recording</Text>
          </View>
        )}

        {/* Map buttons: style, recenter, more (Pause/Resume, zoom); last, so their menus open over the pill */}
        <View style={[styles.controls, { pointerEvents: "box-none" as any }]}>
          <MapControlColumn
            followMode={followMode}
            mapType={mapType}
            mapLayers={mapLayers}
            onSelectMapType={onSelectMapType}
            onLocateButton={onLocateButton}
            isPaused={isPaused}
            onPause={onPause}
            onResume={onResume}
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
          />
        </View>
      </View>

      {/* ── Drive panel ── */}
      <DriveStatsPanel
        driveSeconds={driveSeconds}
        isPaused={isPaused}
        distanceKm={currentDrive?.estimatedDistance ?? 0}
        topSpeedKmh={currentDrive?.topSpeed ?? 0}
        unitSystem={resolvedUnitSystem}
        bottomInset={insets.bottom}
        onSavePoint={onSavePoint}
        onEndDrive={onEndDrive}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  mapArea: { flex: 1 },
  topRow: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  // Equal sides keep the speed card in the middle whatever the chips hold
  topSide: { flex: 1, alignItems: "flex-start", paddingTop: 4 },
  topRight: { alignItems: "flex-end" },
  controls: {
    position: "absolute",
    zIndex: 2,
    right: 12,
    bottom: CONTROLS_BOTTOM,
  },
  reportWrap: {
    position: "absolute",
    left: 12,
    bottom: CONTROLS_BOTTOM,
  },
  resumePill: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    bottom: CONTROLS_BOTTOM,
  },
  resumePillInner: {
    height: 46,
    borderRadius: 23,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  resumePillText: { fontSize: 14, fontWeight: "700", color: "#F3F5F7" },
  passengerNote: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: CONTROLS_BOTTOM + 56,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
  },
  passengerNoteText: {
    fontSize: 12,
    color: "#fff",
    fontWeight: "500",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});

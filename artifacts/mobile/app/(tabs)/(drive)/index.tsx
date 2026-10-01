import { GlassSurface, GlassButton } from "@/components/Glass";
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Animated,
  type ViewProps,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { SafeAreaView as SystemSafeAreaView } from "react-native-screens/experimental";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Path, Ellipse, Circle } from "react-native-svg";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { CONFIG } from "@/constants/config";
import MapView, {
  MarkerAnimated,
  AnimatedRegion,
  MapType,
  Camera,
  Polyline,
} from "react-native-maps";
import ActiveDriveOverlay, {
  ActiveDriveMode,
} from "@/components/ActiveDriveOverlay";
import * as Location from "expo-location";
import { requestForegroundLocation } from "@/lib/locationPermission";

// SF Symbols on iOS, Ionicons elsewhere.
function Glyph({
  sf,
  ion,
  size,
  color,
}: {
  sf: SFSymbol;
  ion: React.ComponentProps<typeof Ionicons>["name"];
  size: number;
  color: string;
}) {
  if (Platform.OS !== "ios")
    return <Ionicons name={ion} size={size} color={color} />;
  return (
    <SymbolView
      name={sf}
      tintColor={color}
      style={{ width: size, height: size }}
      fallback={<Ionicons name={ion} size={size} color={color} />}
    />
  );
}

// Keeps the drive actions just above the tab bar. On iOS this pads by
// UIKit's own safe area, which includes the system tab bar.
function AboveTabBar({
  fallbackInset,
  style,
  ...props
}: ViewProps & { fallbackInset: number }) {
  return Platform.OS === "ios" ? (
    <SystemSafeAreaView {...props} style={style} edges={{ bottom: true }} />
  ) : (
    <View {...props} style={[style, { paddingBottom: fallbackInset }]} />
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────
const NAV_ZOOM = 17;
// Metres to shift camera during an active drive — keeps the vehicle visible
// above the telemetry panel (which covers the bottom ~35% of the screen).
// Outside an active drive the camera centres exactly on the vehicle.
const DRIVE_LOOK_AHEAD_M = 80;
// Zoom levels: below MIN_ZOOM_TO_PRESERVE the user is too far out, so we
// reset to STREET_ZOOM on locate.  Above MIN_ZOOM_TO_PRESERVE we keep theirs.
const MIN_ZOOM_TO_PRESERVE = 13;
const STREET_ZOOM = 16.5;
// iOS altitude equivalent for "too zoomed out" (> 8 km → reset to street level)
const MAX_ALTITUDE_TO_PRESERVE = 8000;
const STREET_ALTITUDE = 700;
// Minimum speed (km/h) before GPS course is trusted for heading
const MIN_SPEED_FOR_GPS_HEADING = 6;
// Heading smoothing factor (lower = smoother but laggier)
const HEADING_SMOOTH = 0.18;
// Minimum heading change (degrees) before the compass re-animates the camera.
// Without this, magnetometer noise re-animates the map constantly when still.
const COMPASS_CAMERA_MIN_DELTA_DEG = 2;
// Heading convergence per GPS fix.  Fixes arrive ~1/s, so a low factor would
// take many seconds to come round a corner; animateCamera eases the visuals.
const GPS_HEADING_SMOOTH = 0.5;
// Camera animation is stretched to cover the gap until the next fix, so the
// map is always mid-animation.  A duration shorter than the gap is what makes
// following look like hop-pause-hop rather than a glide.
const CAMERA_ANIM_MIN_MS = 400;
const CAMERA_ANIM_MAX_MS = 1500;
const CAMERA_ANIM_DEFAULT_MS = 1000;
// Rotation from the compass should feel immediate, so it uses a short fixed one
const COMPASS_ANIM_MS = 300;
// Camera tilt during an active drive, for the forward-looking 3D nav view.
// Apple sits near 60 and Google near 45; 50 splits them.  Only ever applied
// heading-up — a tilted north-up map is disorienting rather than useful.
const DRIVE_PITCH = 50;
// How long the tilt takes to come in at the start of a drive and drop at the end
const PITCH_TRANSITION_MS = 800;
// Camera altitude (metres) during a drive.  Tilt is only rendered by iOS below
// a certain altitude — too high and it silently flattens the camera instead.
const DRIVE_ALTITUDE = 450;
// Max plausible implied speed (km/h) between two GPS readings
const MAX_PLAUSIBLE_KMH = 300;
// Max accuracy (metres) to accept a reading; >50 m shows warning
const ACCURACY_WARNING_M = 50;
const ACCURACY_REJECT_M = 120;

// react-native-maps types timing() as requiring a full Region plus a `toValue`
// its implementation overwrites per key — it animates only the keys it is given.
type RegionTimingConfig = Parameters<AnimatedRegion["timing"]>[0];

type FollowMode = "following" | "free";
type HeadingMode = "heading-up" | "north-up";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Haversine distance in metres between two lat/lon pairs */
function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Camera tilt for a given state — flat unless driving heading-up */
function pitchFor(isDriving: boolean, headingMode: HeadingMode): number {
  return isDriving && headingMode === "heading-up" ? DRIVE_PITCH : 0;
}

/** Smooth heading transition that correctly wraps across 0/360 */
function smoothHeading(
  current: number,
  target: number,
  factor: number,
): number {
  const diff = ((target - current + 540) % 360) - 180; // [-180, 180]
  return (((current + diff * factor) % 360) + 360) % 360;
}

/**
 * Returns a map centre shifted *behind* the vehicle by offsetMeters so the
 * vehicle marker appears in the lower portion of the screen.
 */
function getOffsetCenter(
  lat: number,
  lon: number,
  headingDeg: number,
  offsetMeters: number,
): { latitude: number; longitude: number } {
  const R = 6371000;
  const reverseDeg = (headingDeg + 180) % 360;
  const revRad = reverseDeg * (Math.PI / 180);
  const dLat = (offsetMeters / R) * Math.cos(revRad) * (180 / Math.PI);
  const dLon =
    (offsetMeters / (R * Math.cos(lat * (Math.PI / 180)))) *
    Math.sin(revRad) *
    (180 / Math.PI);
  return { latitude: lat + dLat, longitude: lon + dLon };
}

// ─── Location Arrow ──────────────────────────────────────────────────────────
// Navigation arrow in place of a vehicle icon: white body, dark outline, and a
// shaded trailing half so the direction reads at a glance.  Rotated by the
// marker to point where the vehicle is heading.  Poor GPS accuracy is surfaced
// by the "Poor GPS signal" banner rather than anything on the marker itself.
const LocationArrow = React.memo(function LocationArrow({
  rotation,
}: {
  rotation: Animated.Value;
}) {
  const spin = rotation.interpolate({
    inputRange: [0, 360],
    outputRange: ["0deg", "360deg"],
  });
  return (
    <Animated.View
      style={{
        width: 40,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ rotate: spin }],
      }}
    >
      <Svg width={35} height={40} viewBox="0 0 34 40">
        {/* Soft ground shadow, offset down a touch to lift the arrow off the map */}
        <Path d="M17 5 L31 37 L17 29 L3 37 Z" fill="#000000" opacity={0.18} />
        <Path
          d="M17 3 L31 35 L17 27 L3 35 Z"
          fill="#FFFFFF"
          stroke="#1C1C1E"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Fold shading on the trailing half */}
        <Path d="M17 3 L31 35 L17 27 Z" fill="#1C1C1E" opacity={0.13} />
      </Svg>
    </Animated.View>
  );
});

// The whole marker is memoised so a heading tick never re-renders it.  On iOS
// the arrow turns via the Animated transform above, which updates the native
// view directly; re-rendering the annotation instead made it blink.  Android's
// Google provider rasterises marker content, so it uses the native map-relative
// rotation prop and leaves the content still.
const UserMarker = React.memo(function UserMarker({
  coordinate,
  rotationValue,
  nativeRotation,
}: {
  coordinate: AnimatedRegion;
  rotationValue: Animated.Value;
  nativeRotation: number;
}) {
  return (
    <MarkerAnimated
      // react-native-maps types coordinate as a plain LatLng even on the
      // animated marker, which is the one thing an AnimatedRegion cannot be
      coordinate={coordinate as never}
      anchor={{ x: 0.5, y: 0.5 }}
      rotation={nativeRotation}
      tracksViewChanges={false}
    >
      <LocationArrow rotation={rotationValue} />
    </MarkerAnimated>
  );
});

// ─── Demo map background (web only) ─────────────────────────────────────────
function DemoMapBackground({ mapType }: { mapType: MapType }) {
  const isSatellite = mapType === "satellite" || mapType === "hybrid";
  const bgColors: [string, string, string, string] = isSatellite
    ? ["#111D20", "#182627", "#142124", "#10191E"]
    : ["#10161C", "#17212A", "#131D25", "#10161C"];
  return (
    <View style={StyleSheet.absoluteFill}>
      <LinearGradient colors={bgColors} style={StyleSheet.absoluteFill} />
      <Svg
        style={StyleSheet.absoluteFill as any}
        viewBox="0 0 400 850"
        preserveAspectRatio="xMidYMid slice"
      >
        <Ellipse
          cx={75}
          cy={240}
          rx={72}
          ry={44}
          fill={isSatellite ? "#1a4a6e" : "#203D50"}
          opacity={isSatellite ? 0.85 : 0.65}
        />
        <Ellipse
          cx={50}
          cy={275}
          rx={35}
          ry={20}
          fill={isSatellite ? "#1a4a6e" : "#203D50"}
          opacity={isSatellite ? 0.75 : 0.55}
        />
        <Ellipse
          cx={320}
          cy={370}
          rx={45}
          ry={28}
          fill={isSatellite ? "#1a4a6e" : "#203D50"}
          opacity={isSatellite ? 0.7 : 0.5}
        />
        <Ellipse
          cx={290}
          cy={180}
          rx={80}
          ry={55}
          fill={isSatellite ? "#1d4a28" : "#233C32"}
          opacity={0.6}
        />
        <Ellipse
          cx={130}
          cy={520}
          rx={90}
          ry={60}
          fill={isSatellite ? "#1f5530" : "#233C32"}
          opacity={0.5}
        />
        <Path
          d="M 200 0 Q 190 150 195 300 Q 200 450 215 600 L 210 850"
          stroke={isSatellite ? "rgba(220,210,185,0.7)" : "#52616D"}
          strokeWidth={5}
          fill="none"
          strokeLinecap="round"
        />
        <Path
          d="M 0 380 Q 80 370 160 385 Q 250 400 350 390 L 400 388"
          stroke={isSatellite ? "rgba(220,210,185,0.55)" : "#475460"}
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
        />
        <Path
          d="M 0 480 Q 100 465 200 475 Q 290 485 370 470 L 400 465"
          stroke={isSatellite ? "rgba(220,210,185,0.4)" : "#35434E"}
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
        />
        <Path
          d="M 155 0 Q 160 120 155 250 Q 150 350 165 420"
          stroke={isSatellite ? "rgba(220,210,185,0.45)" : "#35434E"}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
        <Circle
          cx={198}
          cy={390}
          r={6}
          fill={
            isSatellite ? "rgba(240,230,200,0.35)" : "rgba(160,140,110,0.35)"
          }
        />
        <Circle
          cx={205}
          cy={395}
          r={4}
          fill={isSatellite ? "rgba(240,230,200,0.3)" : "rgba(160,140,110,0.3)"}
        />
      </Svg>
      <View
        style={{
          position: "absolute",
          top: "48%",
          left: 12,
          backgroundColor: "rgba(0,0,0,0.5)",
          borderRadius: 8,
          paddingHorizontal: 8,
          paddingVertical: 4,
        }}
      >
        <Text
          style={{
            color: "rgba(255,255,255,0.7)",
            fontSize: 10,
            fontWeight: "500",
          }}
        >
          ILLUSTRATIVE MAP / Native maps on device
        </Text>
      </View>
    </View>
  );
}

// ─── Main Map Screen ─────────────────────────────────────────────────────────
export default function MapScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    userProfile,
    isPassengerMode,
    isDriving,
    currentDrive,
    startDrive,
    endDrive,
    updateDriveCoordinate,
    resolvedUnitSystem,
    togglePassengerMode,
  } = useApp();

  // ── Map state ──
  const [mapType, setMapType] = useState<MapType>("standard");
  const [showLayerPicker, setShowLayerPicker] = useState(false);
  const [showMore, setShowMore] = useState(false);

  // ── Location state ──
  const [locationMode, setLocationMode] = useState<"live" | "simulated">(
    "simulated",
  );
  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [accuracyWarning, setAccuracyWarning] = useState(false);

  // ── Navigation camera state ──
  const [followMode, setFollowMode] = useState<FollowMode>("following");
  const [headingMode, setHeadingMode] = useState<HeadingMode>("heading-up");
  const [displayHeading, setDisplayHeading] = useState(0); // smoothed heading for UI
  // Heading the map itself is rotated to.  Needed because Apple Maps annotations
  // do not rotate with the map, so the arrow's on-screen angle is the difference.
  // Kept in a ref, not state: it changes as often as the compass reports, and
  // re-rendering the screen at that rate is what made the marker blink.
  const mapHeadingRef = useRef(0);
  const arrowRotation = useRef(new Animated.Value(0)).current;

  // ── Drive state ──
  const [driveSeconds, setDriveSeconds] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const isPausedRef = useRef(false);

  // ── Refs (avoid stale closures in callbacks) ──
  const mapRef = useRef<MapView>(null);
  const driveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webWatchIdRef = useRef<number | null>(null);
  const expoWatchRef = useRef<Location.LocationSubscription | null>(null);
  const headingSubRef = useRef<Location.LocationSubscription | null>(null);
  const smoothedHeadingRef = useRef(0);
  // Latest device-compass bearing, used whenever GPS course is untrustworthy
  const compassHeadingRef = useRef<number | null>(null);
  const lastSpeedKmhRef = useRef(0);
  // Heading the camera was last animated to, for the compass jitter threshold
  const lastCameraHeadingRef = useRef(0);
  // Wall-clock of the previous fix, used to size the next camera animation
  const lastFixTimeRef = useRef<number | null>(null);
  // Marker position is animated separately from the camera; if it snapped to
  // each fix while the camera glided, the car would visibly jump then settle.
  const markerCoordRef = useRef(
    new AnimatedRegion({
      latitude: CONFIG.DEMO_REGION.latitude,
      longitude: CONFIG.DEMO_REGION.longitude,
      latitudeDelta: 0,
      longitudeDelta: 0,
    }),
  );
  const hasMarkerPositionRef = useRef(false);
  // Distinguishes "a drive just ended" from "no drive has started yet"
  const wasDrivingRef = useRef(false);
  const lastPositionRef = useRef<{
    lat: number;
    lon: number;
    time: number;
  } | null>(null);
  const followModeRef = useRef<FollowMode>("following");
  const headingModeRef = useRef<HeadingMode>("heading-up");
  const userLocationRef = useRef<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const isDrivingRef = useRef(isDriving);
  const isPassengerModeRef = useRef(isPassengerMode);
  // Timestamp until which region changes are ours rather than the user's.  A
  // one-shot boolean was consumed by the first of the several events a single
  // animation emits, so the rest looked like gestures and cancelled follow mode.
  const programmaticUntilRef = useRef(0);
  // The zoom/altitude we intend to hold.  Asserted on every camera animation so
  // nothing can drift, and re-read from the map after a real pinch gesture.
  const desiredZoomRef = useRef(NAV_ZOOM);
  const desiredAltitudeRef = useRef(STREET_ALTITUDE);
  const resumeButtonAnim = useRef(new Animated.Value(0)).current;

  // Push the arrow's on-screen angle straight to the native view, bypassing
  // React entirely.  Apple Maps annotations stay upright as the map turns, so
  // the angle is where the phone points minus where the map is turned to.
  const syncArrowRotation = useCallback(() => {
    const angle =
      (((smoothedHeadingRef.current - mapHeadingRef.current) % 360) + 360) %
      360;
    arrowRotation.setValue(angle);
  }, [arrowRotation]);

  // Keep refs in sync
  useEffect(() => {
    isDrivingRef.current = isDriving;
  }, [isDriving]);
  useEffect(() => {
    isPassengerModeRef.current = isPassengerMode;
  }, [isPassengerMode]);
  useEffect(() => {
    followModeRef.current = followMode;
  }, [followMode]);
  useEffect(() => {
    headingModeRef.current = headingMode;
  }, [headingMode]);
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);
  // Reset pause state when a drive ends
  useEffect(() => {
    if (!isDriving) {
      setIsPaused(false);
    }
  }, [isDriving]);

  // Layout (points), measured from the approved Drive screen: search,
  // greeting and map controls float over the map; the drive actions sit just
  // above the tab bar.
  const headerTop = insets.top + 6;
  const SEARCH_TOP = headerTop;
  const SEARCH_HEIGHT = 52;
  const WELCOME_TOP = SEARCH_TOP + SEARCH_HEIGHT + 16;
  const CONTROLS_TOP = SEARCH_TOP + 144;
  // Non-iOS: the existing floating tab bar's footprint.
  const TAB_BAR_FOOTPRINT = 72 + Math.max(insets.bottom, 12);

  // ── Animate the resume-follow button in/out ──────────────────────────────
  useEffect(() => {
    Animated.spring(resumeButtonAnim, {
      toValue: followMode === "free" ? 1 : 0,
      useNativeDriver: Platform.OS !== "web",
      tension: 60,
      friction: 10,
    }).start();
  }, [followMode]);

  // ── Camera animation ─────────────────────────────────────────────────────
  const animateCameraToFollow = useCallback(
    (
      loc: { latitude: number; longitude: number },
      heading: number,
      offsetM = 0,
      durationMs = CAMERA_ANIM_DEFAULT_MS,
      resetZoom = false,
    ) => {
      if (!mapRef.current || Platform.OS === "web") return;
      programmaticUntilRef.current = Date.now() + durationMs + 300;

      if (resetZoom) {
        desiredZoomRef.current = NAV_ZOOM;
        desiredAltitudeRef.current = isDrivingRef.current
          ? DRIVE_ALTITUDE
          : STREET_ALTITUDE;
      }

      const isHeadingUp = headingModeRef.current === "heading-up";
      const mapHeading = isHeadingUp ? heading : 0;
      const center = isHeadingUp
        ? getOffsetCenter(loc.latitude, loc.longitude, heading, offsetM)
        : loc;

      mapHeadingRef.current = mapHeading;
      syncArrowRotation();

      const camera: Partial<Camera> = {
        center,
        heading: mapHeading,
        pitch: pitchFor(isDrivingRef.current, headingModeRef.current),
      };
      // The zoom is always stated outright.  Leaving it out let each call
      // re-derive altitude from the previous (often still animating) camera,
      // which ratcheted the map outward a little at a time.
      // iOS reads altitude and Android reads zoom; setting both lets them fight.
      if (Platform.OS === "ios") camera.altitude = desiredAltitudeRef.current;
      else camera.zoom = desiredZoomRef.current;

      mapRef.current.animateCamera(camera, { duration: durationMs });
    },
    [syncArrowRotation],
  );

  // ── Process a new GPS position ────────────────────────────────────────────
  const processPosition = useCallback(
    (
      lat: number,
      lon: number,
      speedMs: number | null,
      gpsHeading: number | null,
      accuracy: number | null,
      altitude: number | null = null,
      fixTime: number | null = null,
    ) => {
      const now = Date.now();

      // ── Accuracy filter ──
      if (accuracy != null && accuracy > ACCURACY_REJECT_M) return;
      setAccuracyWarning(accuracy != null && accuracy > ACCURACY_WARNING_M);
      if (accuracy != null) setGpsAccuracy(accuracy);

      // ── Plausibility filter ──
      const prev = lastPositionRef.current;
      if (prev) {
        const dt = (now - prev.time) / 1000;
        if (dt > 0) {
          const dist = haversineMeters(prev.lat, prev.lon, lat, lon);
          const impliedKmh = (dist / dt) * 3.6;
          if (impliedKmh > MAX_PLAUSIBLE_KMH) return; // reject implausible jump
        }
      }
      lastPositionRef.current = { lat, lon, time: now };

      // ── Update stored location ──
      const coord = { latitude: lat, longitude: lon };
      userLocationRef.current = coord;
      setUserLocation(coord);

      // ── Size this animation to the gap since the last fix ──
      const sinceLastFix =
        lastFixTimeRef.current != null
          ? now - lastFixTimeRef.current
          : CAMERA_ANIM_DEFAULT_MS;
      lastFixTimeRef.current = now;
      const animMs = Math.min(
        CAMERA_ANIM_MAX_MS,
        Math.max(CAMERA_ANIM_MIN_MS, sinceLastFix),
      );

      // ── Glide the marker to the new fix (first fix lands instantly) ──
      if (!hasMarkerPositionRef.current) {
        markerCoordRef.current.setValue({
          latitude: lat,
          longitude: lon,
          latitudeDelta: 0,
          longitudeDelta: 0,
        });
        hasMarkerPositionRef.current = true;
      } else {
        // Deltas are deliberately omitted so only the position animates
        markerCoordRef.current
          .timing({
            latitude: lat,
            longitude: lon,
            duration: animMs,
            useNativeDriver: false,
          } as unknown as RegionTimingConfig)
          .start();
      }

      // ── Record to active drive ──
      if (
        isDrivingRef.current &&
        !isPassengerModeRef.current &&
        !isPausedRef.current
      ) {
        const speedKmh = speedMs != null ? speedMs * 3.6 : 0;
        // Plausibility-checked speed before updating stats
        updateDriveCoordinate({
          latitude: lat,
          longitude: lon,
          speed: speedMs ?? 0,
          heading: gpsHeading,
          accuracy,
          altitude,
          timestamp: fixTime ?? now,
        });
      }

      // ── Smooth heading ──
      const speedKmh = speedMs != null ? speedMs * 3.6 : 0;
      lastSpeedKmhRef.current = speedKmh;
      let targetHeading = smoothedHeadingRef.current;

      if (
        gpsHeading != null &&
        gpsHeading >= 0 &&
        speedKmh >= MIN_SPEED_FOR_GPS_HEADING
      ) {
        // Trust GPS course when moving fast enough
        targetHeading = gpsHeading;
      } else if (compassHeadingRef.current != null) {
        // Stationary or crawling: GPS course is noise, so face where the phone faces
        targetHeading = compassHeadingRef.current;
      }
      // Smooth toward target heading.  animateCamera eases the rotation itself,
      // so this only needs to damp GPS jitter, not do the visual smoothing.
      const newHeading = smoothHeading(
        smoothedHeadingRef.current,
        targetHeading,
        GPS_HEADING_SMOOTH,
      );
      smoothedHeadingRef.current = newHeading;
      setDisplayHeading(Math.round(newHeading));
      syncArrowRotation();

      // ── Drive camera follow ──
      if (followModeRef.current === "following") {
        const offset = isDrivingRef.current ? DRIVE_LOOK_AHEAD_M : 0;
        animateCameraToFollow(coord, newHeading, offset, animMs);
        lastCameraHeadingRef.current = newHeading;
      }
    },
    [animateCameraToFollow, updateDriveCoordinate],
  );

  // ── Location watcher lifecycle ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function startWatcher() {
      if (Platform.OS === "web") {
        if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
          setUserLocation(CONFIG.DEMO_REGION);
          setLocationMode("simulated");
          return;
        }
        const watchId = navigator.geolocation.watchPosition(
          (pos) => {
            if (cancelled) return;
            setLocationMode("live");
            processPosition(
              pos.coords.latitude,
              pos.coords.longitude,
              pos.coords.speed,
              pos.coords.heading,
              pos.coords.accuracy,
              pos.coords.altitude,
              pos.timestamp,
            );
          },
          () => {
            if (cancelled) return;
            setUserLocation(CONFIG.DEMO_REGION);
            setLocationMode("simulated");
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        );
        webWatchIdRef.current = watchId;
      } else {
        const { status } = await requestForegroundLocation();
        if (cancelled) return;
        if (status !== "granted") {
          setUserLocation(CONFIG.DEMO_REGION);
          setLocationMode("simulated");
          return;
        }
        setLocationMode("live");
        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            // 0 = no distance filter.  A 3 m threshold stalled updates in slow
            // traffic, which read as the map freezing then lurching.
            distanceInterval: 0,
          },
          (loc) => {
            if (cancelled) return;
            processPosition(
              loc.coords.latitude,
              loc.coords.longitude,
              loc.coords.speed,
              loc.coords.heading,
              loc.coords.accuracy,
              loc.coords.altitude,
              loc.timestamp,
            );
          },
        );
        expoWatchRef.current = sub;
      }
    }

    startWatcher();

    return () => {
      cancelled = true;
      if (webWatchIdRef.current != null) {
        navigator.geolocation.clearWatch(webWatchIdRef.current);
        webWatchIdRef.current = null;
      }
      if (expoWatchRef.current) {
        expoWatchRef.current.remove();
        expoWatchRef.current = null;
      }
    };
    // processPosition is stable; re-run only when drive state changes so the
    // drive-recording closure sees fresh isDriving/isPassengerMode values.
  }, [processPosition]);

  // ── Compass heading watcher ───────────────────────────────────────────────
  // GPS only reports a course once you're actually moving, so while stationary
  // the map has no idea which way the phone points.  Apple/Google Maps read the
  // magnetometer instead — this does the same.  It drives the camera itself
  // because position updates stop arriving when you stand still.
  useEffect(() => {
    if (Platform.OS === "web") return;
    let cancelled = false;

    async function startCompass() {
      try {
        // watchHeadingAsync rejects if it runs before location access is
        // granted, so wait for the answer.  The position watcher asks at the
        // same moment; requestForegroundLocation shares one request between
        // them, because on iOS a second concurrent request leaves the first
        // waiting forever (the map then never got a position after "Allow").
        const { status } = await requestForegroundLocation();
        if (cancelled || status !== "granted") return;

        const sub = await Location.watchHeadingAsync((h) => {
          if (cancelled) return;
          // trueHeading is -1 until the compass calibrates; magHeading always works
          const raw =
            h.trueHeading != null && h.trueHeading >= 0
              ? h.trueHeading
              : h.magHeading;
          if (raw == null || raw < 0) return;
          compassHeadingRef.current = raw;

          // Once moving, GPS course is the better signal and processPosition drives
          if (lastSpeedKmhRef.current >= MIN_SPEED_FOR_GPS_HEADING) return;

          const newHeading = smoothHeading(
            smoothedHeadingRef.current,
            raw,
            HEADING_SMOOTH,
          );
          smoothedHeadingRef.current = newHeading;
          setDisplayHeading(Math.round(newHeading));
          syncArrowRotation();

          const delta = Math.abs(
            ((newHeading - lastCameraHeadingRef.current + 540) % 360) - 180,
          );
          if (
            delta >= COMPASS_CAMERA_MIN_DELTA_DEG &&
            followModeRef.current === "following" &&
            headingModeRef.current === "heading-up" &&
            userLocationRef.current
          ) {
            lastCameraHeadingRef.current = newHeading;
            animateCameraToFollow(
              userLocationRef.current,
              newHeading,
              isDrivingRef.current ? DRIVE_LOOK_AHEAD_M : 0,
              COMPASS_ANIM_MS,
            );
          }
        });
        if (cancelled) {
          sub.remove();
          return;
        }
        headingSubRef.current = sub;
      } catch {
        // No magnetometer (simulator, some Android hardware) — GPS course only
      }
    }

    startCompass();

    return () => {
      cancelled = true;
      if (headingSubRef.current) {
        headingSubRef.current.remove();
        headingSubRef.current = null;
      }
    };
  }, [animateCameraToFollow]);

  // When a drive starts, immediately enter follow mode and animate to location
  useEffect(() => {
    if (isDriving) {
      setFollowMode("following");
      if (userLocationRef.current) {
        animateCameraToFollow(
          userLocationRef.current,
          smoothedHeadingRef.current,
          DRIVE_LOOK_AHEAD_M,
          PITCH_TRANSITION_MS,
          true,
        );
      }
    } else if (
      wasDrivingRef.current &&
      mapRef.current &&
      Platform.OS !== "web"
    ) {
      // Drive over: drop the tilt back to flat, leaving position and zoom alone.
      // Guarded so mounting flat doesn't fire a pointless camera animation.
      programmaticUntilRef.current = Date.now() + PITCH_TRANSITION_MS + 300;
      mapRef.current.animateCamera(
        { pitch: 0 },
        { duration: PITCH_TRANSITION_MS },
      );
    }
    wasDrivingRef.current = isDriving;
  }, [isDriving, animateCameraToFollow]);

  // ── Drive timer ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isDriving && !isPaused) {
      driveTimerRef.current = setInterval(
        () => setDriveSeconds((s) => s + 1),
        1000,
      );
    } else {
      if (driveTimerRef.current) clearInterval(driveTimerRef.current);
      if (!isDriving) setDriveSeconds(0);
    }
    return () => {
      if (driveTimerRef.current) clearInterval(driveTimerRef.current);
    };
  }, [isDriving, isPaused]);

  // ── Follow mode resume ────────────────────────────────────────────────────
  const handleResumeFollowing = useCallback(() => {
    setFollowMode("following");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (userLocationRef.current) {
      animateCameraToFollow(
        userLocationRef.current,
        smoothedHeadingRef.current,
        isDrivingRef.current ? DRIVE_LOOK_AHEAD_M : 0,
        600,
        true,
      );
    }
  }, [animateCameraToFollow]);

  // ── Heading mode toggle ───────────────────────────────────────────────────
  const handleToggleHeadingMode = useCallback(() => {
    const next: HeadingMode =
      headingMode === "heading-up" ? "north-up" : "heading-up";
    setHeadingMode(next);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (followMode === "following" && userLocationRef.current) {
      const mapHeading = next === "heading-up" ? smoothedHeadingRef.current : 0;
      const center =
        next === "heading-up" && isDrivingRef.current
          ? getOffsetCenter(
              userLocationRef.current.latitude,
              userLocationRef.current.longitude,
              smoothedHeadingRef.current,
              DRIVE_LOOK_AHEAD_M,
            )
          : userLocationRef.current;
      mapHeadingRef.current = mapHeading;
      syncArrowRotation();
      if (mapRef.current && Platform.OS !== "web") {
        programmaticUntilRef.current = Date.now() + 900;
        mapRef.current.animateCamera(
          {
            center,
            heading: mapHeading,
            zoom: NAV_ZOOM,
            pitch: pitchFor(isDrivingRef.current, next),
            altitude: 800,
          },
          { duration: 600 },
        );
      }
    }
  }, [headingMode, followMode]);

  // ── Map user-interaction detection ────────────────────────────────────────
  const handleMapPanDrag = useCallback(() => {
    if (followModeRef.current === "following") {
      setFollowMode("free");
      Haptics.selectionAsync();
    }
  }, []);

  const handleRegionChangeComplete = useCallback(() => {
    // Adopt whatever zoom the map settled at, so a pinch is respected on the
    // next follow update instead of being overwritten by a stale target.
    if (Platform.OS !== "web" && mapRef.current) {
      mapRef.current
        .getCamera()
        .then((cam) => {
          if (cam.zoom != null) desiredZoomRef.current = cam.zoom;
          if (cam.altitude != null && cam.altitude > 0)
            desiredAltitudeRef.current = cam.altitude;
          if (cam.heading != null) {
            mapHeadingRef.current = cam.heading;
            syncArrowRotation();
          }
        })
        .catch(() => {});
    }

    if (Date.now() < programmaticUntilRef.current) return;

    // User triggered this change
    if (followModeRef.current === "following") {
      setFollowMode("free");
    }
  }, []);

  // ── Drive controls ────────────────────────────────────────────────────────
  function handleStartDrive() {
    startDrive();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleEndDrive() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push("/drive-summary");
  }

  function handlePause() {
    setIsPaused(true);
  }
  function handleResume() {
    setIsPaused(false);
  }

  function handleSavePoint() {
    // Store current location as a named marker — no-op if no location yet
    // Haptic feedback is handled inside the overlay
  }

  const handleZoomIn = useCallback(() => {
    if (!mapRef.current || Platform.OS === "web") return;
    mapRef.current
      .getCamera()
      .then((cam) => {
        programmaticUntilRef.current = Date.now() + 500;
        mapRef.current?.animateCamera(
          { zoom: (cam.zoom ?? 15) + 1 },
          { duration: 200 },
        );
      })
      .catch(() => {});
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!mapRef.current || Platform.OS === "web") return;
    mapRef.current
      .getCamera()
      .then((cam) => {
        programmaticUntilRef.current = Date.now() + 500;
        mapRef.current?.animateCamera(
          { zoom: (cam.zoom ?? 15) - 1 },
          { duration: 200 },
        );
      })
      .catch(() => {});
  }, []);

  // ── Location button ──────────────────────────────────────────────────────
  // Smoothly animates to the user's current position, restores follow mode,
  // and centres the vehicle slightly above the vertical midpoint to leave room
  // for the bottom navigation bar and Start Drive button.
  // Zoom is preserved unless the user is too far out (< MIN_ZOOM_TO_PRESERVE).
  const handleLocateButton = useCallback(async () => {
    const loc = userLocationRef.current;
    if (!loc) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Restore follow mode regardless of platform
    setFollowMode("following");

    if (Platform.OS === "web" || !mapRef.current) return;

    // Read the live camera so we can preserve the user's zoom level
    let targetZoom = STREET_ZOOM;
    let targetAlt = STREET_ALTITUDE;
    let preserveZoom = false;

    try {
      const cam = await mapRef.current.getCamera();
      // Android exposes `zoom`; iOS exposes `altitude` (and often both)
      if (cam.zoom != null && cam.zoom >= MIN_ZOOM_TO_PRESERVE) {
        targetZoom = cam.zoom;
        preserveZoom = true;
      }
      if (cam.altitude != null && cam.altitude < MAX_ALTITUDE_TO_PRESERVE) {
        targetAlt = cam.altitude;
        preserveZoom = true;
      }
      // A drive always uses the nav altitude, or iOS may refuse to tilt
      if (isDrivingRef.current) {
        targetZoom = NAV_ZOOM;
        targetAlt = DRIVE_ALTITUDE;
      }
      desiredZoomRef.current = targetZoom;
      desiredAltitudeRef.current = targetAlt;
    } catch {
      // getCamera() unavailable — fall through to street defaults
    }

    const heading = smoothedHeadingRef.current;
    const isHeadingUp = headingModeRef.current === "heading-up";

    // Centre exactly on the user.  The only exception is an active drive in
    // heading-up mode, where the telemetry panel covers the lower screen and
    // the vehicle needs to sit above it.
    const center =
      isHeadingUp && isDrivingRef.current
        ? getOffsetCenter(
            loc.latitude,
            loc.longitude,
            heading,
            DRIVE_LOOK_AHEAD_M,
          )
        : loc;

    mapHeadingRef.current = isHeadingUp ? heading : 0;
    syncArrowRotation();
    programmaticUntilRef.current = Date.now() + 900;
    mapRef.current.animateCamera(
      {
        center,
        heading: isHeadingUp ? heading : 0,
        zoom: targetZoom,
        pitch: pitchFor(isDrivingRef.current, headingModeRef.current),
        altitude: targetAlt,
      },
      { duration: 600 },
    );
    lastCameraHeadingRef.current = isHeadingUp ? heading : 0;
  }, []);

  // ── Formatters ────────────────────────────────────────────────────────────
  function formatDriveTime(sec: number) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0)
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // ─── Styles ────────────────────────────────────────────────────────────────

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#1a3d2a" },
    mapFull: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },

    // ── Passenger / accuracy banners ──
    passengerBanner: {
      position: "absolute",
      left: 0,
      right: 0,
      zIndex: 30,
      backgroundColor: colors.primary,
      paddingVertical: 7,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    },
    passengerBannerText: {
      fontSize: 13,
      fontWeight: "600",
      color: "#fff",
    },
    accuracyWarning: {
      position: "absolute",
      left: 12,
      zIndex: 20,
      backgroundColor: "rgba(234,179,8,0.9)",
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 5,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
    },
    accuracyWarningText: {
      fontSize: 11,
      color: colors.foreground,
      fontWeight: "600",
    },

    // ── Header ──
    scrim: { position: "absolute", left: 0, right: 0, zIndex: 10 },
    searchBarWrap: { position: "absolute", left: 16, right: 16, zIndex: 15 },
    searchBar: {
      height: 52,
      borderRadius: 20,
      paddingHorizontal: 18,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    searchPlaceholder: {
      flex: 1,
      fontSize: 16,
      color: "rgba(243,245,247,0.82)",
    },
    welcomeRow: {
      position: "absolute",
      left: 18,
      right: 16,
      zIndex: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    welcomeTitle: {
      color: "#FFFFFF",
      fontSize: 23,
      fontWeight: "600",
      letterSpacing: -0.4,
      textShadowColor: "rgba(0,0,0,0.5)",
      textShadowRadius: 10,
    },
    welcomeSubtitle: {
      color: "rgba(243,245,247,0.82)",
      fontSize: 15,
      marginTop: 3,
      textShadowColor: "rgba(0,0,0,0.5)",
      textShadowRadius: 8,
    },
    weather: {
      height: 62,
      minWidth: 132,
      maxWidth: 164,
      borderRadius: 20,
      paddingHorizontal: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    weatherTemp: { color: "#FFFFFF", fontSize: 18, fontWeight: "600" },
    weatherCondition: {
      color: "rgba(243,245,247,0.78)",
      fontSize: 12,
      marginTop: 1,
    },
    mapControls: { position: "absolute", right: 16, zIndex: 15, gap: 14 },
    mapControl: {
      width: 46,
      height: 46,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    menu: {
      position: "absolute",
      right: 74,
      zIndex: 20,
      minWidth: 220,
      borderRadius: 18,
      paddingHorizontal: 14,
    },
    menuRow: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    menuRowLast: { borderBottomWidth: 0 },
    menuText: { color: colors.foreground, fontSize: 15 },
    menuValue: {
      marginLeft: "auto",
      color: colors.mutedForeground,
      fontSize: 15,
    },
    bottomArea: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 15,
    },
    resumeBtn: { alignSelf: "center", marginBottom: 14 },
    resumeInner: {
      height: 44,
      borderRadius: 22,
      paddingHorizontal: 18,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    resumeBtnText: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.foreground,
    },
    actions: { marginHorizontal: 14, marginBottom: 14 },
    startGlow: {
      borderRadius: 24,
      shadowColor: "#08B4EA",
      shadowOpacity: 0.6,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 4 },
      elevation: 10,
    },
    startDrive: {
      height: 64,
      borderRadius: 24,
      overflow: "hidden",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 14,
      borderWidth: 1,
      borderColor: "rgba(190,246,255,0.75)",
    },
    startDriveText: {
      color: "#04121B",
      fontSize: 22,
      fontWeight: "600",
      letterSpacing: -0.3,
    },
    secondaryRow: { flexDirection: "row", gap: 10, marginTop: 11 },
    secondaryBtn: {
      flex: 1,
      height: 66,
      borderRadius: 20,
      paddingLeft: 18,
      paddingRight: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    secondaryText: {
      flex: 1,
      color: "#FFFFFF",
      fontSize: 16,
      fontWeight: "600",
      lineHeight: 20,
    },
  });

  const passengerOffset = isPassengerMode ? 34 : 0;

  const mapLayers: Array<{ type: MapType; label: string; icon: string }> = [
    { type: "standard", label: "Standard", icon: "map-outline" },
    { type: "terrain", label: "Terrain", icon: "earth-outline" },
    { type: "satellite", label: "Satellite", icon: "planet-outline" },
  ];

  // The marker rotation always equals the vehicle's actual heading.
  // In north-up mode: map bearing=0, marker points its heading direction.
  // In heading-up mode: map bearing=heading, marker counter-rotates back to
  //   "face screen-up" which also equals heading degrees.
  // Apple Maps ignores the Marker `rotation` prop entirely — it is only wired up
  // for the Google provider — and its annotations stay upright as the map turns.
  // So on iOS the arrow's own content is rotated by the difference between where
  // the phone points and where the map is turned to.  Android's rotation prop is
  // map-relative and works natively, which is cheaper, so it is kept there.
  // On iOS this stays constant so the memoised marker never re-renders; Android
  // needs the prop to change, which is cheap there because it is a native rotation.
  const markerRotation = Platform.OS === "ios" ? 0 : displayHeading;

  return (
    <View style={styles.container}>
      {/* ── Map ── */}
      {Platform.OS !== "web" ? (
        <MapView
          userInterfaceStyle="dark"
          ref={mapRef}
          style={styles.mapFull}
          // Muted standard keeps the map calm and premium on iOS.
          mapType={
            mapType === "standard" && Platform.OS === "ios"
              ? "mutedStandard"
              : mapType
          }
          showsCompass={false}
          showsScale={false}
          showsUserLocation={false}
          showsTraffic={false}
          rotateEnabled
          scrollEnabled
          zoomEnabled
          pitchEnabled
          onPanDrag={handleMapPanDrag}
          onRegionChangeComplete={handleRegionChangeComplete}
          initialRegion={
            userLocation
              ? { ...userLocation, latitudeDelta: 0.012, longitudeDelta: 0.012 }
              : {
                  ...CONFIG.DEMO_REGION,
                  latitudeDelta: 0.012,
                  longitudeDelta: 0.012,
                }
          }
        >
          {userLocation && (
            <UserMarker
              coordinate={markerCoordRef.current}
              rotationValue={arrowRotation}
              nativeRotation={markerRotation}
            />
          )}
          {/* Recorded route: a soft glow under the cyan line */}
          {isDriving && currentDrive && currentDrive.coordinates.length > 1 && (
            <Polyline
              coordinates={currentDrive.coordinates}
              strokeColor="rgba(0,207,232,0.28)"
              strokeWidth={12}
              lineCap="round"
              lineJoin="round"
            />
          )}
          {isDriving && currentDrive && currentDrive.coordinates.length > 1 && (
            <Polyline
              coordinates={currentDrive.coordinates}
              strokeColor={colors.primary}
              strokeWidth={4}
              lineCap="round"
              lineJoin="round"
            />
          )}
        </MapView>
      ) : (
        <DemoMapBackground mapType={mapType} />
      )}

      {/* ── Passenger banner ── */}
      {isPassengerMode && (
        <View style={[styles.passengerBanner, { top: headerTop }]}>
          <Ionicons name="walk-outline" size={14} color="#fff" />
          <Text style={styles.passengerBannerText}>
            Passenger Mode — Journey not recording
          </Text>
          <TouchableOpacity
            onPress={() => router.push("/settings")}
            style={{ marginLeft: 8 }}
          >
            <Text
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,0.7)",

                textDecorationLine: "underline",
              }}
            >
              Settings
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── GPS accuracy warning ── */}
      {accuracyWarning && (
        <View
          style={[
            styles.accuracyWarning,
            { top: CONTROLS_TOP + passengerOffset },
          ]}
        >
          <Ionicons
            name="warning-outline"
            size={12}
            color={colors.foreground}
          />
          <Text style={styles.accuracyWarningText}>Poor GPS signal</Text>
        </View>
      )}

      {/* ── Scrims keep the floating UI legible over any map ── */}
      {!isDriving && (
        <LinearGradient
          pointerEvents="none"
          colors={["rgba(5,8,12,0.85)", "rgba(5,8,12,0.45)", "rgba(5,8,12,0)"]}
          locations={[0, 0.6, 1]}
          style={[styles.scrim, { top: 0, height: insets.top + 210 }]}
        />
      )}
      {!isDriving && (
        <LinearGradient
          pointerEvents="none"
          colors={["rgba(5,8,12,0)", "rgba(5,8,12,0.8)"]}
          style={[styles.scrim, { bottom: 0, height: 360 }]}
        />
      )}

      {/* ── Search: the navigation entry point ── */}
      {!isDriving && (
        <View
          style={[styles.searchBarWrap, { top: SEARCH_TOP + passengerOffset }]}
        >
          <GlassButton
            accessibilityLabel="Where are we going? Search destinations"
            onPress={() => router.push("/search")}
            style={styles.searchBar}
          >
            <Glyph
              sf="magnifyingglass"
              ion="search"
              size={20}
              color="#F3F5F7"
            />
            <Text style={styles.searchPlaceholder}>Where are we going?</Text>
            <Glyph sf="mic" ion="mic-outline" size={20} color="#F3F5F7" />
          </GlassButton>
        </View>
      )}

      {/* ── Greeting and weather ── */}
      {!isDriving && (
        <View
          style={[styles.welcomeRow, { top: WELCOME_TOP + passengerOffset }]}
        >
          <View style={{ flex: 1 }}>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              style={styles.welcomeTitle}
            >
              Welcome back
              {userProfile.name ? `, ${userProfile.name.split(" ")[0]}` : ""}
            </Text>
            <Text numberOfLines={1} style={styles.welcomeSubtitle}>
              Great roads are calling.
            </Text>
          </View>
          {CONFIG.DEMO_MODE && (
            <GlassSurface
              accessible
              accessibilityLabel={`Demo weather: ${CONFIG.DEMO_WEATHER.temperature} degrees, ${CONFIG.DEMO_WEATHER.condition}`}
              style={styles.weather}
            >
              <Glyph sf="cloud.fill" ion="cloud" size={30} color="#EEF2F6" />
              <View style={{ flexShrink: 1 }}>
                <Text style={styles.weatherTemp}>
                  {CONFIG.DEMO_WEATHER.temperature}°C
                </Text>
                <Text numberOfLines={1} style={styles.weatherCondition}>
                  {CONFIG.DEMO_WEATHER.condition}
                </Text>
              </View>
              <Glyph
                sf="chevron.right"
                ion="chevron-forward"
                size={14}
                color={colors.mutedForeground}
              />
            </GlassSurface>
          )}
        </View>
      )}

      {/* ── Map controls: style, recenter, more ── */}
      {!isDriving && (
        <View
          style={[styles.mapControls, { top: CONTROLS_TOP + passengerOffset }]}
        >
          <GlassButton
            accessibilityLabel="Map style"
            accessibilityState={{ expanded: showLayerPicker }}
            style={styles.mapControl}
            onPress={() => {
              setShowMore(false);
              setShowLayerPicker(!showLayerPicker);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          >
            <Glyph
              sf="square.3.layers.3d"
              ion="layers-outline"
              size={22}
              color={showLayerPicker ? colors.primary : "#F3F5F7"}
            />
          </GlassButton>
          <GlassButton
            accessibilityLabel="Recenter map"
            accessibilityState={{ selected: followMode === "following" }}
            style={styles.mapControl}
            onPress={handleLocateButton}
          >
            <Glyph
              sf={followMode === "following" ? "location.fill" : "location"}
              ion={followMode === "following" ? "navigate" : "navigate-outline"}
              size={20}
              color="#F3F5F7"
            />
          </GlassButton>
          <GlassButton
            accessibilityLabel="More map options"
            accessibilityState={{ expanded: showMore }}
            style={styles.mapControl}
            onPress={() => {
              setShowLayerPicker(false);
              setShowMore(!showMore);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          >
            <Glyph
              sf="ellipsis"
              ion="ellipsis-horizontal"
              size={22}
              color={showMore ? colors.primary : "#F3F5F7"}
            />
          </GlassButton>
        </View>
      )}

      {/* ── Map style menu ── */}
      {!isDriving && showLayerPicker && (
        <GlassSurface
          material="dense"
          style={[styles.menu, { top: CONTROLS_TOP + passengerOffset }]}
        >
          {mapLayers.map((layer, i) => (
            <TouchableOpacity
              key={layer.type}
              accessibilityRole="button"
              accessibilityState={{ selected: mapType === layer.type }}
              style={[
                styles.menuRow,
                i === mapLayers.length - 1 && styles.menuRowLast,
              ]}
              onPress={() => {
                setMapType(layer.type);
                setShowLayerPicker(false);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
            >
              <Ionicons
                name={layer.icon as any}
                size={18}
                color={
                  mapType === layer.type
                    ? colors.primary
                    : colors.mutedForeground
                }
              />
              <Text
                style={[
                  styles.menuText,
                  mapType === layer.type && { color: colors.primary },
                ]}
              >
                {layer.label}
              </Text>
              {mapType === layer.type && (
                <Ionicons
                  name="checkmark"
                  size={16}
                  color={colors.primary}
                  style={{ marginLeft: "auto" }}
                />
              )}
            </TouchableOpacity>
          ))}
        </GlassSurface>
      )}

      {/* ── More: orientation, saved places, passenger mode ── */}
      {!isDriving && showMore && (
        <GlassSurface
          material="dense"
          style={[styles.menu, { top: CONTROLS_TOP + 120 + passengerOffset }]}
        >
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.menuRow}
            onPress={() => {
              handleToggleHeadingMode();
              setShowMore(false);
            }}
          >
            <Ionicons
              name="compass-outline"
              size={18}
              color={colors.mutedForeground}
            />
            <Text style={styles.menuText}>
              {headingMode === "heading-up"
                ? "Switch to North Up"
                : "Switch to Heading Up"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.menuRow}
            onPress={() => {
              setShowMore(false);
              router.push("/search");
            }}
          >
            <Ionicons
              name="bookmark-outline"
              size={18}
              color={colors.mutedForeground}
            />
            <Text style={styles.menuText}>Saved Places</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="switch"
            accessibilityState={{ checked: isPassengerMode }}
            style={[styles.menuRow, styles.menuRowLast]}
            onPress={() => {
              togglePassengerMode();
              setShowMore(false);
            }}
          >
            <Ionicons
              name="walk-outline"
              size={18}
              color={colors.mutedForeground}
            />
            <Text style={styles.menuText}>Passenger Mode</Text>
            <Text
              style={[
                styles.menuValue,
                isPassengerMode && { color: colors.primary },
              ]}
            >
              {isPassengerMode ? "On" : "Off"}
            </Text>
          </TouchableOpacity>
        </GlassSurface>
      )}

      {/* ── Active Drive Overlay ── */}
      {isDriving && (
        <ActiveDriveOverlay
          currentDrive={currentDrive}
          driveSeconds={driveSeconds}
          isPaused={isPaused}
          driveMode={"tracking" as ActiveDriveMode}
          locationMode={locationMode}
          gpsAccuracy={gpsAccuracy}
          accuracyWarning={accuracyWarning}
          followMode={followMode}
          resolvedUnitSystem={resolvedUnitSystem}
          isPassengerMode={isPassengerMode}
          insets={insets}
          onPause={handlePause}
          onResume={handleResume}
          onEndDrive={handleEndDrive}
          onSavePoint={handleSavePoint}
          onLocateButton={handleLocateButton}
          onResumeFollowing={handleResumeFollowing}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
        />
      )}

      {/* ── Drive actions, just above the tab bar ── */}
      {!isDriving && (
        <AboveTabBar
          pointerEvents="box-none"
          fallbackInset={TAB_BAR_FOOTPRINT}
          style={styles.bottomArea}
        >
          {/* Resume following (the drive overlay has its own) */}
          <Animated.View
            style={[
              styles.resumeBtn,
              {
                opacity: resumeButtonAnim,
                transform: [
                  {
                    translateY: resumeButtonAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [20, 0],
                    }),
                  },
                ],
                pointerEvents: followMode === "free" ? "auto" : "none",
              },
            ]}
          >
            <GlassButton
              onPress={handleResumeFollowing}
              style={styles.resumeInner}
            >
              <Ionicons name="navigate" size={17} color={colors.primary} />
              <Text style={styles.resumeBtnText}>Resume following</Text>
            </GlassButton>
          </Animated.View>
          <View style={styles.actions}>
            <View style={styles.startGlow}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Start Drive"
                accessibilityHint={
                  isPassengerMode
                    ? "Passenger Mode is on, so this drive will not be recorded"
                    : "Starts recording your drive"
                }
                activeOpacity={0.85}
                onPress={handleStartDrive}
                style={styles.startDrive}
              >
                <LinearGradient
                  colors={["#5BE8FF", "#13C8F2", "#08AEE6"]}
                  locations={[0, 0.55, 1]}
                  style={StyleSheet.absoluteFill}
                />
                <LinearGradient
                  colors={["rgba(255,255,255,0.5)", "rgba(255,255,255,0)"]}
                  end={{ x: 0, y: 0.5 }}
                  style={[StyleSheet.absoluteFill, { opacity: 0.55 }]}
                />
                <Glyph sf="play.fill" ion="play" size={26} color="#04121B" />
                <Text style={styles.startDriveText}>Start Drive</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.secondaryRow}>
              <GlassButton
                accessibilityLabel="Convoys"
                style={styles.secondaryBtn}
                onPress={() =>
                  router.push({
                    pathname: "/(tabs)/community",
                    params: { section: "convoys" },
                  })
                }
              >
                <Glyph
                  sf="person.3.fill"
                  ion="people"
                  size={26}
                  color="#F3F5F7"
                />
                <Text numberOfLines={1} style={styles.secondaryText}>
                  Convoys
                </Text>
                <Glyph
                  sf="chevron.right"
                  ion="chevron-forward"
                  size={15}
                  color="#F3F5F7"
                />
              </GlassButton>
              <GlassButton
                accessibilityLabel="Discover Route"
                style={styles.secondaryBtn}
                onPress={() => router.push("/(tabs)/(drive)/explore")}
              >
                <Glyph
                  sf="point.bottomleft.forward.to.point.topright.scurvepath"
                  ion="git-commit-outline"
                  size={26}
                  color="#F3F5F7"
                />
                <Text numberOfLines={2} style={styles.secondaryText}>
                  Discover Route
                </Text>
                <Glyph
                  sf="chevron.right"
                  ion="chevron-forward"
                  size={15}
                  color="#F3F5F7"
                />
              </GlassButton>
            </View>
          </View>
        </AboveTabBar>
      )}
    </View>
  );
}

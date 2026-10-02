import { GlassSurface, GlassButton } from "@/components/Glass";
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Animated,
  Alert,
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
  Polyline,
} from "react-native-maps";
import ActiveDriveOverlay, {
  ActiveDriveMode,
} from "@/components/ActiveDriveOverlay";
import * as Location from "expo-location";
import { requestForegroundLocation } from "@/lib/locationPermission";
import { buildFollowCamera } from "@/lib/followCamera";
import {
  FollowCameraController,
  type FollowFrameTarget,
} from "@/lib/followController";
import { MARKER_PERSPECTIVE, markerPerspective } from "@/lib/markerPerspective";
import {
  HeadingFilter,
  LatestReader,
  markerScreenRotation,
} from "@/lib/headingFilter";
import { isLongEnoughToSave } from "@/lib/backend/journeyRecorder";
import {
  lookAheadForSpeed,
  NAV_CAMERA,
  navPitch,
} from "@/lib/navigationCamera";
import {
  approach,
  type ReportedPose,
  LocationSmoother,
} from "@/lib/locationSmoothing";

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
// The follow camera's pitch, distance, zoom and look-ahead live in
// lib/navigationCamera.ts (NAV_CAMERA), shared by every way into follow mode.
// Minimum speed (km/h) before GPS course is trusted for heading.  Below it the
// compass is the only heading source; above it, the GPS course is.  The
// smoothing for both lives in lib/headingFilter.ts.
const MIN_SPEED_FOR_GPS_HEADING = 6;
// The heading readout and Android marker rotation are React state; refreshing
// them on every compass tick re-rendered the whole screen many times a second
const HEADING_UI_INTERVAL_MS = 100;
// Region-change events within this long of our last camera write are ours
const PROGRAMMATIC_GRACE_MS = 300;
// Longest frame step honoured, so a stall (app backgrounded) doesn't lurch
const MAX_FRAME_DT_MS = 100;
// Max plausible implied speed (km/h) between two GPS readings
const MAX_PLAUSIBLE_KMH = 300;
// Max accuracy (metres) to accept a reading; >50 m shows warning
const ACCURACY_WARNING_M = 50;
const ACCURACY_REJECT_M = 120;

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

// ─── Location Arrow ──────────────────────────────────────────────────────────
// Navigation arrow in place of a vehicle icon: white body, dark outline, and a
// shaded trailing half so the direction reads at a glance.  Rotated by the
// marker to point where the vehicle is heading.  Poor GPS accuracy is surfaced
// by the "Poor GPS signal" banner rather than anything on the marker itself.
//
// The rotating arrow sits inside a fixed square frame that never rotates.
// react-native-maps' Apple Maps marker sizes and centres its annotation view
// from its first child's frame on every layout, and a rotated view's frame is
// its bounding box, which changes with the angle.  With the arrow as that
// child, heading changes resized and re-centred the live annotation view
// (AIRMapMarker layoutSubviews → reactSetFrame), which is what made the
// marker blink as it turned.  The frame below is that child instead: its size
// fits the arrow at any angle (the 40×44 diagonal is 59.5) and never changes,
// so turning the arrow is a pure transform on a view MapKit never sees move.
// collapsable={false} keeps the new architecture from flattening it away,
// which would put the rotating view back in its place.
//
// On the tilted map the arrow is also laid onto the road (lib/
// markerPerspective.ts): the rotation is followed by a vertical squash, and a
// dark side wall and a ground shadow sit just below it in screen space.  All
// three layers live inside the same fixed frame and are driven by Animated
// values pushed straight to the native views, exactly like the rotation, so
// the flicker fix above still holds: nothing re-renders or resizes.
const ARROW_FRAME = 60;
const ARROW_W = 40;
const ARROW_H = 44;
const ARROW_PATH = "M17 3 L31 35 L17 27 L3 35 Z";
const arrowLayer = {
  position: "absolute",
  left: (ARROW_FRAME - ARROW_W) / 2,
  top: (ARROW_FRAME - ARROW_H) / 2,
  width: ARROW_W,
  height: ARROW_H,
  alignItems: "center",
  justifyContent: "center",
} as const;
const LocationArrow = React.memo(function LocationArrow({
  rotation,
  scaleY,
  edgeLift,
  shadowLift,
}: {
  rotation: Animated.Value;
  scaleY: Animated.Value;
  edgeLift: Animated.Value;
  shadowLift: Animated.Value;
}) {
  const spin = rotation.interpolate({
    inputRange: [0, 360],
    outputRange: ["0deg", "360deg"],
  });
  // Listed outermost first: rotate to the heading, squash onto the tilted
  // ground, then (for the lower layers) drop down the screen toward the viewer
  const onGround = [{ scaleY }, { rotate: spin }];
  return (
    <View
      collapsable={false}
      style={{ width: ARROW_FRAME, height: ARROW_FRAME }}
    >
      {/* Ground shadow */}
      <Animated.View
        style={[
          arrowLayer,
          { transform: [{ translateY: shadowLift }, ...onGround] },
        ]}
      >
        <Svg width={35} height={40} viewBox="0 0 34 40">
          <Path
            d={ARROW_PATH}
            fill="#000000"
            opacity={MARKER_PERSPECTIVE.shadowOpacity}
          />
        </Svg>
      </Animated.View>
      {/* Side wall: the arrow's thickness, seen as the map tilts */}
      <Animated.View
        style={[
          arrowLayer,
          { transform: [{ translateY: edgeLift }, ...onGround] },
        ]}
      >
        <Svg width={35} height={40} viewBox="0 0 34 40">
          <Path
            d={ARROW_PATH}
            fill={MARKER_PERSPECTIVE.wallFill}
            stroke={MARKER_PERSPECTIVE.wallStroke}
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
        </Svg>
      </Animated.View>
      {/* Top face */}
      <Animated.View style={[arrowLayer, { transform: onGround }]}>
        <Svg width={35} height={40} viewBox="0 0 34 40">
          <Path
            d={ARROW_PATH}
            fill="#FFFFFF"
            stroke="#1C1C1E"
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* Fold shading on the trailing half: two lit facets, not one */}
          <Path d="M17 3 L31 35 L17 27 Z" fill="#1C1C1E" opacity={0.16} />
        </Svg>
      </Animated.View>
    </View>
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
  perspective,
  nativeRotation,
}: {
  coordinate: AnimatedRegion;
  rotationValue: Animated.Value;
  perspective: {
    scaleY: Animated.Value;
    edgeLift: Animated.Value;
    shadowLift: Animated.Value;
  };
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
      <LocationArrow
        rotation={rotationValue}
        scaleY={perspective.scaleY}
        edgeLift={perspective.edgeLift}
        shadowLift={perspective.shadowLift}
      />
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
    discardDrive,
    setDrivePaused,
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
  // Pitch the map is tilted to, for laying the arrow onto the road.  Like the
  // heading, it's what we last set while following, or what the user left it
  // at, and it's display-only: nothing camera-related reads it.
  const mapPitchRef = useRef(0);
  const arrowPitchRef = useRef<number | null>(null);
  const arrowPerspective = useRef(
    (() => {
      const flat = markerPerspective(0);
      return {
        scaleY: new Animated.Value(flat.scaleY),
        edgeLift: new Animated.Value(flat.edgeLift),
        shadowLift: new Animated.Value(flat.shadowLift),
      };
    })(),
  ).current;

  // ── Drive state ──
  const [driveSeconds, setDriveSeconds] = useState(0);
  // The timer's latest value, for handlers that may run from a stale render
  const driveSecondsRef = useRef(0);
  driveSecondsRef.current = driveSeconds;
  const [isPaused, setIsPaused] = useState(false);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const isPausedRef = useRef(false);
  const lastAccuracyRef = useRef<number | null>(null);

  // ── Refs (avoid stale closures in callbacks) ──
  const mapRef = useRef<MapView>(null);
  const driveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webWatchIdRef = useRef<number | null>(null);
  const expoWatchRef = useRef<Location.LocationSubscription | null>(null);
  const headingSubRef = useRef<Location.LocationSubscription | null>(null);
  const lastSpeedKmhRef = useRef(0);
  // The one heading that's drawn (arrow, and the map's bearing heading-up).
  // Fed by exactly one source at a time: compass when stopped, GPS course
  // when moving.  drawnHeadingRef mirrors its output each frame.
  const [headingFilter] = useState(() => new HeadingFilter());
  const drawnHeadingRef = useRef(0);
  // ── Visual smoothing layer ──
  // Raw fixes still go to recording untouched; these only decide what's drawn.
  // The marker and follow camera are both written every frame from the same
  // smoothed position, so the car stays put on screen while the map glides.
  const [locationSmoother] = useState(() => new LocationSmoother());
  const frameIdRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);
  const lastHeadingUiAtRef = useRef(0);
  const seedingCameraRef = useRef(false);
  // Speed (km/h) the look-ahead is sized from, eased from the GPS speed
  const lookAheadSpeedRef = useRef(0);
  const mapTypeRef = useRef<MapType>("standard");
  const markerDrawnAtRef = useRef<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const markerCoordRef = useRef(
    new AnimatedRegion({
      latitude: CONFIG.DEMO_REGION.latitude,
      longitude: CONFIG.DEMO_REGION.longitude,
      latitudeDelta: 0,
      longitudeDelta: 0,
    }),
  );
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
  // The zoom/distance we intend to hold.  Asserted on every camera animation so
  // nothing can drift, and only ever re-read from the map after a user gesture,
  // never after our own animations (see lib/followCamera.ts).
  // The follow camera: the single authoritative follow distance/zoom (only
  // ever set from NAV_CAMERA), the eased camera state, and the one-read-per-
  // entry rule for MapKit's camera (see lib/followController.ts).
  const [followCamera] = useState(
    () =>
      new FollowCameraController(
        { zoom: NAV_CAMERA.androidZoom, distance: NAV_CAMERA.distanceM },
        { min: NAV_CAMERA.minDistanceM, max: NAV_CAMERA.maxDistanceM },
      ),
  );
  const zoomTarget = followCamera.zoom;
  const resumeButtonAnim = useRef(new Animated.Value(0)).current;

  // Push the arrow's on-screen angle straight to the native view, bypassing
  // React entirely.  Apple Maps annotations stay upright as the map turns, so
  // the angle is where the phone points minus where the map is turned to.
  const syncArrowRotation = useCallback(() => {
    arrowRotation.setValue(
      markerScreenRotation(drawnHeadingRef.current, mapHeadingRef.current),
    );
    // Lay it onto the tilted map; only pushed when the tilt actually moves
    const pitch = mapPitchRef.current;
    const last = arrowPitchRef.current;
    if (last == null || Math.abs(pitch - last) > 0.05) {
      arrowPitchRef.current = pitch;
      const view = markerPerspective(pitch);
      arrowPerspective.scaleY.setValue(view.scaleY);
      arrowPerspective.edgeLift.setValue(view.edgeLift);
      arrowPerspective.shadowLift.setValue(view.shadowLift);
    }
  }, [arrowRotation, arrowPerspective]);

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

  // ── Smoothed marker + follow camera, drawn every frame ───────────────────
  // GPS fixes and compass steps only move targets; this loop draws toward
  // them each frame.  It writes the marker and the camera from the same
  // smoothed position in the same frame, so the vehicle holds still on screen
  // while the map glides, and it stops itself once nothing is moving.
  const followTargetFor = useCallback(
    (position: { latitude: number; longitude: number }): FollowFrameTarget => {
      const isHeadingUp = headingModeRef.current === "heading-up";
      // No distance or zoom here: those are the controller's alone
      return {
        position,
        heading: isHeadingUp ? drawnHeadingRef.current : 0,
        pitch: navPitch(isHeadingUp, mapTypeRef.current),
        // Heading-up, the centre sits ahead of the vehicle so the view is
        // mostly road in front; north-up centres exactly on it
        lookAheadM: isHeadingUp
          ? lookAheadForSpeed(lookAheadSpeedRef.current)
          : 0,
      };
    },
    [],
  );

  const frameLoopRef = useRef<() => void>(() => {});
  const wakeFrameLoop = useCallback(() => {
    if (frameIdRef.current != null) return;
    lastFrameAtRef.current = Date.now();
    frameIdRef.current = requestAnimationFrame(() => frameLoopRef.current());
  }, []);

  // Entering follow from a map the user moved: read its camera once, so the
  // ease-in starts from what's on screen.  The only time follow reads MapKit.
  const requestCameraSeed = useCallback(() => {
    const token = followCamera.beginSeed();
    if (token == null || !mapRef.current) return;
    const targetNow = () => {
      const position = locationSmoother.sample(Date.now());
      return position ? followTargetFor(position) : null;
    };
    mapRef.current
      .getCamera()
      .then((cam) => followCamera.completeSeed(token, cam, targetNow()))
      // No live camera to start from: start from the target itself
      .catch(() => followCamera.completeSeed(token, {}, targetNow()))
      .finally(wakeFrameLoop);
  }, [followCamera, locationSmoother, followTargetFor, wakeFrameLoop]);

  frameLoopRef.current = () => {
    frameIdRef.current = null;
    const now = Date.now();
    const dt = Math.min(
      Math.max(now - lastFrameAtRef.current, 0),
      MAX_FRAME_DT_MS,
    );
    lastFrameAtRef.current = now;

    // ── Heading: ease the drawn heading toward its target ──
    drawnHeadingRef.current = headingFilter.step(dt);
    const headingSettled = headingFilter.settled;

    // ── Speed for look-ahead: smoothed slowly so it drifts, never nudges ──
    lookAheadSpeedRef.current = approach(
      lookAheadSpeedRef.current,
      lastSpeedKmhRef.current,
      dt,
      NAV_CAMERA.lookAhead.speedTauMs,
    );
    const speedSettled =
      Math.abs(lookAheadSpeedRef.current - lastSpeedKmhRef.current) < 0.1;
    if (speedSettled) lookAheadSpeedRef.current = lastSpeedKmhRef.current;

    const position = locationSmoother.sample(now);
    let cameraSettled = true;
    if (position) {
      // ── Marker ── (skipped when only the heading is moving)
      const drawn = markerDrawnAtRef.current;
      if (
        !drawn ||
        drawn.latitude !== position.latitude ||
        drawn.longitude !== position.longitude
      ) {
        markerDrawnAtRef.current = position;
        markerCoordRef.current.setValue({
          latitude: position.latitude,
          longitude: position.longitude,
          latitudeDelta: 0,
          longitudeDelta: 0,
        });
      }

      // ── Follow camera ──
      if (
        followModeRef.current === "following" &&
        mapRef.current &&
        Platform.OS !== "web"
      ) {
        const frame = followCamera.frame(
          followTargetFor(position),
          dt,
          zoomTarget.gestureActive(now),
        );
        if (frame.kind === "paused") {
          // Hands off while the user touches the map
          cameraSettled = false;
        } else if (frame.kind === "needsSeed") {
          requestCameraSeed();
          cameraSettled = false;
        } else {
          const { pose } = frame;
          programmaticUntilRef.current = now + PROGRAMMATIC_GRACE_MS;
          mapHeadingRef.current = pose.heading;
          mapPitchRef.current = pose.pitch;
          // A plain (unanimated) set: the motion comes from this loop.  A
          // native animation per fix is what produced hop-pause-hop.
          mapRef.current.setCamera(
            buildFollowCamera(
              pose.center,
              pose.heading,
              pose.pitch,
              pose,
              Platform.OS,
            ),
          );
          cameraSettled = frame.settled;
        }
      }
    }
    syncArrowRotation();

    const settled =
      headingSettled &&
      speedSettled &&
      cameraSettled &&
      locationSmoother.isSettled(now);
    // The readout is React state, so it's refreshed at a modest rate
    if (settled || now - lastHeadingUiAtRef.current >= HEADING_UI_INTERVAL_MS) {
      lastHeadingUiAtRef.current = now;
      setDisplayHeading(Math.round(drawnHeadingRef.current) % 360);
    }
    if (!settled) {
      frameIdRef.current = requestAnimationFrame(() => frameLoopRef.current());
    }
  };

  useEffect(
    () => () => {
      if (frameIdRef.current != null) cancelAnimationFrame(frameIdRef.current);
      frameIdRef.current = null;
    },
    [],
  );

  // Enter follow mode.  With the live camera in hand it eases from there;
  // otherwise the loop fetches it first.
  const startFollowing = useCallback(
    (resetZoom: boolean, current?: ReportedPose) => {
      zoomTarget.clearGesture();
      if (resetZoom) {
        zoomTarget.set({
          zoom: NAV_CAMERA.androidZoom,
          distance: NAV_CAMERA.distanceM,
        });
      }
      const wasFollowing = followModeRef.current === "following";
      followModeRef.current = "following";
      setFollowMode("following");
      // Already following (mid-transition included): carry on untouched.
      // From free: start over, from `current` or a one-off camera read.
      const position = locationSmoother.sample(Date.now());
      followCamera.enter(
        wasFollowing,
        current,
        position ? followTargetFor(position) : undefined,
      );
      wakeFrameLoop();
    },
    [
      zoomTarget,
      followCamera,
      locationSmoother,
      followTargetFor,
      wakeFrameLoop,
    ],
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
      // Only the drive overlay shows the figure; outside a drive, setting it on
      // every fix re-rendered the screen each second for nothing
      if (accuracy != null) {
        lastAccuracyRef.current = accuracy;
        if (isDrivingRef.current) setGpsAccuracy(accuracy);
      }

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
      const firstFix = userLocationRef.current == null;
      userLocationRef.current = coord;
      // The state only gates the marker's first render.  Setting it on every
      // fix re-rendered the whole screen each second for nothing.
      if (firstFix) setUserLocation(coord);

      // ── Visual smoothing (display only; recording below gets the raw fix) ──
      locationSmoother.addFix(
        {
          latitude: lat,
          longitude: lon,
          speed: speedMs,
          course: gpsHeading,
          accuracy,
          time: fixTime ?? now,
        },
        now,
      );
      // The first fix lands as-is; place the marker before it first renders so
      // it never flashes at the placeholder coordinate
      if (firstFix) {
        markerDrawnAtRef.current = coord;
        markerCoordRef.current.setValue({
          ...coord,
          latitudeDelta: 0,
          longitudeDelta: 0,
        });
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

      // ── Heading ──
      // Moving: the GPS course is the heading.  Stopped or crawling, the course
      // is noise and the compass handler supplies the heading instead; this
      // path no longer touches it, so the two never fight.
      const speedKmh = speedMs != null ? speedMs * 3.6 : 0;
      lastSpeedKmhRef.current = speedKmh;
      if (
        gpsHeading != null &&
        gpsHeading >= 0 &&
        speedKmh >= MIN_SPEED_FOR_GPS_HEADING
      ) {
        headingFilter.update(gpsHeading, "course");
      }

      // ── Draw: marker, heading and follow camera glide from here ──
      wakeFrameLoop();
    },
    [locationSmoother, headingFilter, updateDriveCoordinate, wakeFrameLoop],
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

          // Once moving, GPS course is the better signal and processPosition drives
          if (lastSpeedKmhRef.current >= MIN_SPEED_FOR_GPS_HEADING) return;

          // Raw reading straight in: the filter drops sub-0.4° noise and the
          // frame loop eases toward it, so turning the phone is one smooth
          // motion rather than a run of small steps
          if (headingFilter.update(raw, "compass")) wakeFrameLoop();
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
  }, [wakeFrameLoop]);

  // When a drive starts, immediately enter follow mode; the frame loop eases
  // in the navigation camera.  The camera itself is the same in and out of a
  // drive, so ending one leaves it as it is.
  useEffect(() => {
    if (isDriving) {
      setGpsAccuracy(lastAccuracyRef.current);
      startFollowing(true);
    }
  }, [isDriving, startFollowing]);

  // Satellite and hybrid can't tilt, so a layer change can change the pitch
  useEffect(() => {
    mapTypeRef.current = mapType;
    wakeFrameLoop();
  }, [mapType, wakeFrameLoop]);

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
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Back to the nav zoom, eased over from wherever the user left the map
    startFollowing(true);
  }, [startFollowing]);

  // ── Heading mode toggle ───────────────────────────────────────────────────
  const handleToggleHeadingMode = useCallback(() => {
    const next: HeadingMode =
      headingMode === "heading-up" ? "north-up" : "heading-up";
    setHeadingMode(next);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // The ref is normally synced by an effect after render; the camera needs
    // the new mode now.  Zoom stays at the held target — switching modes only
    // changes rotation, tilt and look-ahead, which the frame loop eases over.
    headingModeRef.current = next;
    const position = locationSmoother.sample(Date.now());
    if (followMode === "following" && position) {
      followCamera.retarget(followTargetFor(position));
    }
    wakeFrameLoop();
  }, [
    headingMode,
    followMode,
    locationSmoother,
    followCamera,
    followTargetFor,
    wakeFrameLoop,
  ]);

  // ── Map user-interaction detection ────────────────────────────────────────
  const handleMapPanDrag = useCallback(() => {
    zoomTarget.gestureMoved(Date.now());
    if (followModeRef.current === "following") {
      followModeRef.current = "free";
      followCamera.leave();
      setFollowMode("free");
      Haptics.selectionAsync();
    }
  }, [zoomTarget, followCamera]);

  const handleMapTouchStart = useCallback(() => {
    zoomTarget.touchStart(Date.now());
  }, [zoomTarget]);

  const handleMapTouchEnd = useCallback(() => {
    zoomTarget.touchEnd(Date.now());
  }, [zoomTarget]);

  // The map's bearing and tilt, read live for the arrow.  Apple Maps keeps
  // annotations upright while the map turns, and react-native-maps' region
  // events carry no bearing, so while the user rotates or tilts the map the
  // camera is read on every region change (one read in flight, the latest
  // always followed up).  Display only: nothing here reaches the camera.
  const [bearingReader] = useState(
    () =>
      new LatestReader(
        () =>
          mapRef.current
            ? mapRef.current.getCamera()
            : Promise.reject(new Error("no map")),
        (cam) => {
          // While following outside a gesture the loop sets these itself
          if (
            followModeRef.current === "following" &&
            !zoomTarget.gestureActive(Date.now())
          ) {
            return;
          }
          if (cam.heading != null) mapHeadingRef.current = cam.heading;
          if (cam.pitch != null) mapPitchRef.current = cam.pitch;
          syncArrowRotation();
        },
      ),
  );
  const readMapBearing = useCallback(() => {
    if (Platform.OS !== "web") bearingReader.request();
  }, [bearingReader]);

  // Fires continuously while the map moves, including during a gesture
  const handleRegionChange = useCallback(() => {
    if (
      followModeRef.current !== "following" ||
      zoomTarget.gestureActive(Date.now())
    ) {
      readMapBearing();
    }
  }, [zoomTarget, readMapBearing]);

  const handleRegionChangeComplete = useCallback(() => {
    // While following, the frame loop writes the camera every frame, so this
    // fires every frame too.  Nothing here is fed back into the follow camera:
    // MapKit doesn't report a tilted camera's altitude back exactly (and
    // reports mid-flight values), and adopting it on each heading change is
    // what compounded into the map zooming out to a view of the country.
    const now = Date.now();
    // One last bearing read as a gesture settles
    if (zoomTarget.gestureActive(now)) readMapBearing();

    if (now < programmaticUntilRef.current) return;

    // The user moved the map (pan, pinch or rotate): follow mode ends, and
    // Continue Following brings the navigation camera back
    if (followModeRef.current === "following") {
      followModeRef.current = "free";
      followCamera.leave();
      setFollowMode("free");
    }
  }, [zoomTarget, followCamera, readMapBearing]);

  // ── Drive controls ────────────────────────────────────────────────────────
  function handleStartDrive() {
    startDrive();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleEndDrive() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Under 10 s of active driving, by the on-screen drive timer (paused time
    // doesn't count): thrown away, not saved.  The summary screen saves on
    // open, so the check has to happen before going there.  Read through a
    // ref: this runs from the End Drive confirmation, which may have been
    // open for a while since the button was pressed.
    if (!isLongEnoughToSave(driveSecondsRef.current * 1000)) {
      void discardDrive();
      Alert.alert(
        "Drive too short to save",
        "Drives must be at least 10 seconds long.",
      );
      return;
    }
    router.push("/drive-summary");
  }

  function handlePause() {
    setIsPaused(true);
    setDrivePaused(true);
  }
  function handleResume() {
    setIsPaused(false);
    setDrivePaused(false);
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
        const zoom = (cam.zoom ?? 15) + 1;
        // An explicit zoom pick becomes the zoom follow mode holds
        zoomTarget.set({ zoom });
        // While following, the frame loop owns the camera and eases to it
        if (followModeRef.current === "following") {
          wakeFrameLoop();
          return;
        }
        programmaticUntilRef.current = Date.now() + 500;
        mapRef.current?.animateCamera({ zoom }, { duration: 200 });
      })
      .catch(() => {});
  }, [zoomTarget, wakeFrameLoop]);

  const handleZoomOut = useCallback(() => {
    if (!mapRef.current || Platform.OS === "web") return;
    mapRef.current
      .getCamera()
      .then((cam) => {
        const zoom = (cam.zoom ?? 15) - 1;
        // An explicit zoom pick becomes the zoom follow mode holds
        zoomTarget.set({ zoom });
        // While following, the frame loop owns the camera and eases to it
        if (followModeRef.current === "following") {
          wakeFrameLoop();
          return;
        }
        programmaticUntilRef.current = Date.now() + 500;
        mapRef.current?.animateCamera({ zoom }, { duration: 200 });
      })
      .catch(() => {});
  }, [zoomTarget, wakeFrameLoop]);

  // ── Location button ──────────────────────────────────────────────────────
  // Same as Continue Following: back into follow mode with the navigation
  // camera, eased over from wherever the map is now.
  const handleLocateButton = useCallback(async () => {
    const loc = userLocationRef.current;
    if (!loc) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Already following: nothing to read; the camera carries on as it is.
    // From a moved map, its camera is where the ease-in starts.
    let liveCamera: ReportedPose | undefined;
    if (
      followModeRef.current !== "following" &&
      Platform.OS !== "web" &&
      mapRef.current
    ) {
      try {
        liveCamera = await mapRef.current.getCamera();
      } catch {
        // No live camera: the loop fetches one, or starts from the target
      }
    }
    startFollowing(true, liveCamera);
  }, [startFollowing]);

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
          onTouchStart={handleMapTouchStart}
          onTouchEnd={handleMapTouchEnd}
          onTouchCancel={handleMapTouchEnd}
          onRegionChange={handleRegionChange}
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
              perspective={arrowPerspective}
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

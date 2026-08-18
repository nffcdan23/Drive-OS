import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, ScrollView, Image, Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Ellipse, Rect, Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { CONFIG } from '@/constants/config';
import MapView, { Marker, MapType, Camera, Polyline } from 'react-native-maps';
import ActiveDriveOverlay, { ActiveDriveMode } from '@/components/ActiveDriveOverlay';
import * as Location from 'expo-location';

const MINI_IMAGE = require('@/assets/images/mini-cooper.png');

// ─── Constants ────────────────────────────────────────────────────────────────
const NAV_ZOOM = 17;
// Metres to shift camera centre behind vehicle so it appears ~65% down the screen
// At zoom 17 the vertical FOV is ~960 m, so 15 % ≈ 144 m; use 160 m for comfort.
const CAMERA_LOOK_AHEAD_M = 160;
// Metres to shift camera during an active drive — smaller so the vehicle stays
// visible above the telemetry panel (which covers the bottom ~35% of the screen)
const DRIVE_LOOK_AHEAD_M = 80;
// Metres to shift map centre south of the vehicle when the location button is
// tapped in north-up mode.  At zoom 16 this ≈ 80 px — just enough to sit the
// vehicle above the bottom navigation bar and Start Drive button.
const LOCATE_VERTICAL_OFFSET_M = 120;
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
// Max plausible implied speed (km/h) between two GPS readings
const MAX_PLAUSIBLE_KMH = 300;
// Max accuracy (metres) to accept a reading; >50 m shows warning
const ACCURACY_WARNING_M = 50;
const ACCURACY_REJECT_M = 120;

type FollowMode = 'following' | 'free';
type HeadingMode = 'heading-up' | 'north-up';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Haversine distance in metres between two lat/lon pairs */
function haversineMeters(
  lat1: number, lon1: number, lat2: number, lon2: number,
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

/** Smooth heading transition that correctly wraps across 0/360 */
function smoothHeading(current: number, target: number, factor: number): number {
  const diff = ((target - current + 540) % 360) - 180; // [-180, 180]
  return ((current + diff * factor) % 360 + 360) % 360;
}

/**
 * Returns a map centre shifted *behind* the vehicle by offsetMeters so the
 * vehicle marker appears in the lower portion of the screen.
 */
function getOffsetCenter(
  lat: number, lon: number, headingDeg: number, offsetMeters: number,
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

// ─── Car Marker SVG ──────────────────────────────────────────────────────────
function CarMarker({ accuracyWarning }: { accuracyWarning: boolean }) {
  return (
    <View style={{ width: 36, height: 50, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{
        position: 'absolute', width: 52, height: 52, borderRadius: 26,
        backgroundColor: accuracyWarning
          ? 'rgba(234,179,8,0.22)'
          : 'rgba(244, 99, 26, 0.18)',
        borderWidth: 1.5,
        borderColor: accuracyWarning
          ? 'rgba(234,179,8,0.45)'
          : 'rgba(244, 99, 26, 0.35)',
      }} />
      <Svg width={28} height={44} viewBox="0 0 28 44">
        <Rect x="6" y="6" width="16" height="32" rx="4" fill="white" stroke="#1C1C1E" strokeWidth="1.5" />
        <Rect x="8" y="8" width="12" height="10" rx="2" fill="#A8D4F0" opacity="0.9" />
        <Rect x="9" y="26" width="10" height="7" rx="1.5" fill="#A8D4F0" opacity="0.7" />
        <Rect x="2" y="10" width="4" height="8" rx="2" fill="#444" />
        <Rect x="22" y="10" width="4" height="8" rx="2" fill="#444" />
        <Rect x="2" y="26" width="4" height="8" rx="2" fill="#444" />
        <Rect x="22" y="26" width="4" height="8" rx="2" fill="#444" />
        <Ellipse cx="9" cy="6" rx="2.5" ry="1.5" fill="#FFEFC0" />
        <Ellipse cx="19" cy="6" rx="2.5" ry="1.5" fill="#FFEFC0" />
        <Ellipse cx="9" cy="38" rx="2.5" ry="1.5" fill="#FFB0B0" />
        <Ellipse cx="19" cy="38" rx="2.5" ry="1.5" fill="#FFB0B0" />
        <Rect x="9" y="20" width="10" height="6" rx="1" fill="#E0E0E0" opacity="0.6" />
      </Svg>
    </View>
  );
}

// ─── Demo map background (web only) ─────────────────────────────────────────
function DemoMapBackground({ mapType }: { mapType: MapType }) {
  const isSatellite = mapType === 'satellite' || mapType === 'hybrid';
  const bgColors: [string, string, string, string] = isSatellite
    ? ['#1a3d2a', '#2d5a3c', '#254e34', '#1e4530']
    : ['#c8d8b0', '#b2cb96', '#9aba7a', '#aec98e'];
  return (
    <View style={StyleSheet.absoluteFill}>
      <LinearGradient colors={bgColors} style={StyleSheet.absoluteFill} />
      <Svg style={StyleSheet.absoluteFill as any} viewBox="0 0 400 850" preserveAspectRatio="xMidYMid slice">
        <Ellipse cx={75} cy={240} rx={72} ry={44} fill={isSatellite ? '#1a4a6e' : '#5a9fc4'} opacity={isSatellite ? 0.85 : 0.65} />
        <Ellipse cx={50} cy={275} rx={35} ry={20} fill={isSatellite ? '#1a4a6e' : '#5a9fc4'} opacity={isSatellite ? 0.75 : 0.55} />
        <Ellipse cx={320} cy={370} rx={45} ry={28} fill={isSatellite ? '#1a4a6e' : '#5a9fc4'} opacity={isSatellite ? 0.7 : 0.5} />
        <Ellipse cx={290} cy={180} rx={80} ry={55} fill={isSatellite ? '#1d4a28' : '#7aac62'} opacity={0.6} />
        <Ellipse cx={130} cy={520} rx={90} ry={60} fill={isSatellite ? '#1f5530' : '#88b86e'} opacity={0.5} />
        <Path d="M 200 0 Q 190 150 195 300 Q 200 450 215 600 L 210 850" stroke={isSatellite ? 'rgba(220,210,185,0.7)' : 'rgba(180,170,150,0.8)'} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M 0 380 Q 80 370 160 385 Q 250 400 350 390 L 400 388" stroke={isSatellite ? 'rgba(220,210,185,0.55)' : 'rgba(180,170,150,0.7)'} strokeWidth={4} fill="none" strokeLinecap="round" />
        <Path d="M 0 480 Q 100 465 200 475 Q 290 485 370 470 L 400 465" stroke={isSatellite ? 'rgba(220,210,185,0.4)' : 'rgba(180,170,150,0.5)'} strokeWidth={2.5} fill="none" strokeLinecap="round" />
        <Path d="M 155 0 Q 160 120 155 250 Q 150 350 165 420" stroke={isSatellite ? 'rgba(220,210,185,0.45)' : 'rgba(180,170,150,0.55)'} strokeWidth={2} fill="none" strokeLinecap="round" />
        <Circle cx={198} cy={390} r={6} fill={isSatellite ? 'rgba(240,230,200,0.35)' : 'rgba(160,140,110,0.35)'} />
        <Circle cx={205} cy={395} r={4} fill={isSatellite ? 'rgba(240,230,200,0.3)' : 'rgba(160,140,110,0.3)'} />
      </Svg>
      <View style={{ position: 'absolute', bottom: 130, left: 12, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 10, fontFamily: 'Inter_500Medium' }}>
          DEMO MAP · No API key connected
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
    activeVehicle, userProfile, isPassengerMode,
    isDriving, currentDrive, startDrive, endDrive, updateDriveCoordinate,
    unreadNotificationCount, resolvedUnitSystem,
  } = useApp();

  // ── Map state ──
  const [mapType, setMapType] = useState<MapType>('satellite');
  const [showLayerPicker, setShowLayerPicker] = useState(false);
  const [showFriends, setShowFriends] = useState(false);

  // ── Location state ──
  const [locationMode, setLocationMode] = useState<'live' | 'simulated'>('simulated');
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [accuracyWarning, setAccuracyWarning] = useState(false);

  // ── Navigation camera state ──
  const [followMode, setFollowMode] = useState<FollowMode>('following');
  const [headingMode, setHeadingMode] = useState<HeadingMode>('heading-up');
  const [displayHeading, setDisplayHeading] = useState(0); // smoothed heading for UI

  // ── Drive state ──
  const [driveSeconds, setDriveSeconds] = useState(0);
  const [isPaused,     setIsPaused]     = useState(false);
  const [gpsAccuracy,  setGpsAccuracy]  = useState<number | null>(null);
  const isPausedRef = useRef(false);

  // ── Refs (avoid stale closures in callbacks) ──
  const mapRef = useRef<MapView>(null);
  const driveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webWatchIdRef = useRef<number | null>(null);
  const expoWatchRef = useRef<Location.LocationSubscription | null>(null);
  const smoothedHeadingRef = useRef(0);
  const lastPositionRef = useRef<{ lat: number; lon: number; time: number } | null>(null);
  const followModeRef = useRef<FollowMode>('following');
  const headingModeRef = useRef<HeadingMode>('heading-up');
  const userLocationRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const isDrivingRef = useRef(isDriving);
  const isPassengerModeRef = useRef(isPassengerMode);
  // Tracks whether the next onRegionChangeComplete is ours (programmatic)
  const programmaticChangeRef = useRef(false);
  const resumeButtonAnim = useRef(new Animated.Value(0)).current;

  // Keep refs in sync
  useEffect(() => { isDrivingRef.current = isDriving; }, [isDriving]);
  useEffect(() => { isPassengerModeRef.current = isPassengerMode; }, [isPassengerMode]);
  useEffect(() => { followModeRef.current = followMode; }, [followMode]);
  useEffect(() => { headingModeRef.current = headingMode; }, [headingMode]);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
  // Reset pause state when a drive ends
  useEffect(() => { if (!isDriving) { setIsPaused(false); } }, [isDriving]);

  // Layout constants
  // Floating pill tab bar: height 66, bottom = max(insets.bottom, 16)
  const tabPillBottom = Math.max(insets.bottom, Platform.OS === 'web' ? 16 : insets.bottom);
  const tabBarOffset = Platform.OS === 'web' ? 82 : 66 + tabPillBottom;
  const headerTop = Platform.OS === 'web' ? 67 + insets.top : insets.top;
  const HEADER_H = 44;
  const SEARCH_TOP = headerTop + HEADER_H + 10;
  const QUICK_TOP = SEARCH_TOP + 62 + 10;
  const MAP_CONTROLS_TOP = QUICK_TOP + 44 + 16;
  // Bottom card sits above the floating tab bar with an 8 px gap
  const BOTTOM_CARD_BOTTOM = tabBarOffset + 8;

  // ── Animate the resume-follow button in/out ──────────────────────────────
  useEffect(() => {
    Animated.spring(resumeButtonAnim, {
      toValue: followMode === 'free' ? 1 : 0,
      useNativeDriver: Platform.OS !== 'web',
      tension: 60,
      friction: 10,
    }).start();
  }, [followMode]);

  // ── Camera animation ─────────────────────────────────────────────────────
  const animateCameraToFollow = useCallback(
    (loc: { latitude: number; longitude: number }, heading: number, offsetM = CAMERA_LOOK_AHEAD_M) => {
      if (!mapRef.current || Platform.OS === 'web') return;
      programmaticChangeRef.current = true;

      const isHeadingUp = headingModeRef.current === 'heading-up';
      const mapHeading = isHeadingUp ? heading : 0;
      const center = isHeadingUp
        ? getOffsetCenter(loc.latitude, loc.longitude, heading, offsetM)
        : loc;

      const camera: Partial<Camera> = {
        center,
        heading: mapHeading,
        zoom: NAV_ZOOM,
        pitch: 0,
        altitude: 800,
      };
      mapRef.current.animateCamera(camera, { duration: 350 });
    },
    [],
  );

  // ── Process a new GPS position ────────────────────────────────────────────
  const processPosition = useCallback(
    (
      lat: number, lon: number,
      speedMs: number | null,
      gpsHeading: number | null,
      accuracy: number | null,
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

      // ── Record to active drive ──
      if (isDrivingRef.current && !isPassengerModeRef.current && !isPausedRef.current) {
        const speedKmh = speedMs != null ? speedMs * 3.6 : 0;
        // Plausibility-checked speed before updating stats
        updateDriveCoordinate({ latitude: lat, longitude: lon, speed: speedMs ?? 0 });
      }

      // ── Smooth heading ──
      const speedKmh = speedMs != null ? speedMs * 3.6 : 0;
      let targetHeading = smoothedHeadingRef.current;

      if (gpsHeading != null && gpsHeading >= 0 && speedKmh >= MIN_SPEED_FOR_GPS_HEADING) {
        // Trust GPS course when moving fast enough
        targetHeading = gpsHeading;
      }
      // Smooth toward target heading
      const newHeading = smoothHeading(smoothedHeadingRef.current, targetHeading, HEADING_SMOOTH);
      smoothedHeadingRef.current = newHeading;
      setDisplayHeading(Math.round(newHeading));

      // ── Drive camera follow ──
      if (followModeRef.current === 'following') {
        const offset = isDrivingRef.current ? DRIVE_LOOK_AHEAD_M : CAMERA_LOOK_AHEAD_M;
        animateCameraToFollow(coord, newHeading, offset);
      }
    },
    [animateCameraToFollow, updateDriveCoordinate],
  );

  // ── Location watcher lifecycle ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function startWatcher() {
      if (Platform.OS === 'web') {
        if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
          setUserLocation(CONFIG.DEMO_REGION);
          setLocationMode('simulated');
          return;
        }
        const watchId = navigator.geolocation.watchPosition(
          (pos) => {
            if (cancelled) return;
            setLocationMode('live');
            processPosition(
              pos.coords.latitude,
              pos.coords.longitude,
              pos.coords.speed,
              pos.coords.heading,
              pos.coords.accuracy,
            );
          },
          () => {
            if (cancelled) return;
            setUserLocation(CONFIG.DEMO_REGION);
            setLocationMode('simulated');
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        );
        webWatchIdRef.current = watchId;
      } else {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== 'granted') {
          setUserLocation(CONFIG.DEMO_REGION);
          setLocationMode('simulated');
          return;
        }
        setLocationMode('live');
        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 3,
          },
          (loc) => {
            if (cancelled) return;
            processPosition(
              loc.coords.latitude,
              loc.coords.longitude,
              loc.coords.speed,
              loc.coords.heading,
              loc.coords.accuracy,
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

  // When a drive starts, immediately enter follow mode and animate to location
  useEffect(() => {
    if (isDriving) {
      setFollowMode('following');
      if (userLocationRef.current) {
        animateCameraToFollow(userLocationRef.current, smoothedHeadingRef.current);
      }
    }
  }, [isDriving, animateCameraToFollow]);

  // ── Drive timer ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isDriving && !isPaused) {
      driveTimerRef.current = setInterval(() => setDriveSeconds((s) => s + 1), 1000);
    } else {
      if (driveTimerRef.current) clearInterval(driveTimerRef.current);
      if (!isDriving) setDriveSeconds(0);
    }
    return () => { if (driveTimerRef.current) clearInterval(driveTimerRef.current); };
  }, [isDriving, isPaused]);

  // ── Follow mode resume ────────────────────────────────────────────────────
  const handleResumeFollowing = useCallback(() => {
    setFollowMode('following');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (userLocationRef.current) {
      animateCameraToFollow(userLocationRef.current, smoothedHeadingRef.current);
    }
  }, [animateCameraToFollow]);

  // ── Heading mode toggle ───────────────────────────────────────────────────
  const handleToggleHeadingMode = useCallback(() => {
    const next: HeadingMode = headingMode === 'heading-up' ? 'north-up' : 'heading-up';
    setHeadingMode(next);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (followMode === 'following' && userLocationRef.current) {
      const mapHeading = next === 'heading-up' ? smoothedHeadingRef.current : 0;
      const center = next === 'heading-up'
        ? getOffsetCenter(userLocationRef.current.latitude, userLocationRef.current.longitude, smoothedHeadingRef.current, CAMERA_LOOK_AHEAD_M)
        : userLocationRef.current;
      if (mapRef.current && Platform.OS !== 'web') {
        programmaticChangeRef.current = true;
        mapRef.current.animateCamera({ center, heading: mapHeading, zoom: NAV_ZOOM, pitch: 0, altitude: 800 }, { duration: 600 });
      }
    }
  }, [headingMode, followMode]);

  // ── Map user-interaction detection ────────────────────────────────────────
  const handleMapPanDrag = useCallback(() => {
    if (followModeRef.current === 'following') {
      setFollowMode('free');
      Haptics.selectionAsync();
    }
  }, []);

  const handleRegionChangeComplete = useCallback(() => {
    if (programmaticChangeRef.current) {
      programmaticChangeRef.current = false;
      return;
    }
    // User triggered this change
    if (followModeRef.current === 'following') {
      setFollowMode('free');
    }
  }, []);

  // ── Drive controls ────────────────────────────────────────────────────────
  function handleStartDrive() {
    startDrive();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleEndDrive() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push('/drive-summary');
  }

  function handlePause() { setIsPaused(true); }
  function handleResume() { setIsPaused(false); }

  function handleSavePoint() {
    // Store current location as a named marker — no-op if no location yet
    // Haptic feedback is handled inside the overlay
  }

  const handleZoomIn = useCallback(() => {
    if (!mapRef.current || Platform.OS === 'web') return;
    mapRef.current.getCamera().then((cam) => {
      mapRef.current?.animateCamera({ zoom: (cam.zoom ?? 15) + 1 }, { duration: 200 });
    }).catch(() => {});
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!mapRef.current || Platform.OS === 'web') return;
    mapRef.current.getCamera().then((cam) => {
      mapRef.current?.animateCamera({ zoom: (cam.zoom ?? 15) - 1 }, { duration: 200 });
    }).catch(() => {});
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
    setFollowMode('following');

    if (Platform.OS === 'web' || !mapRef.current) return;

    // Read the live camera so we can preserve the user's zoom level
    let targetZoom    = STREET_ZOOM;
    let targetAlt     = STREET_ALTITUDE;
    let preserveZoom  = false;

    try {
      const cam = await mapRef.current.getCamera();
      // Android exposes `zoom`; iOS exposes `altitude` (and often both)
      if (cam.zoom != null && cam.zoom >= MIN_ZOOM_TO_PRESERVE) {
        targetZoom   = cam.zoom;
        preserveZoom = true;
      }
      if (cam.altitude != null && cam.altitude < MAX_ALTITUDE_TO_PRESERVE) {
        targetAlt    = cam.altitude;
        preserveZoom = true;
      }
    } catch {
      // getCamera() unavailable — fall through to street defaults
    }

    const heading    = smoothedHeadingRef.current;
    const isHeadingUp = headingModeRef.current === 'heading-up';

    // In heading-up mode re-use the nav offset (vehicle appears lower-centre,
    // looks ahead).  In north-up mode apply a fixed southward shift so the
    // vehicle sits slightly above the screen midpoint.
    const center = isHeadingUp
      ? getOffsetCenter(loc.latitude, loc.longitude, heading, CAMERA_LOOK_AHEAD_M)
      : {
          latitude:  loc.latitude  - LOCATE_VERTICAL_OFFSET_M / 111_320,
          longitude: loc.longitude,
        };

    programmaticChangeRef.current = true;
    mapRef.current.animateCamera(
      {
        center,
        heading: isHeadingUp ? heading : 0,
        zoom:     targetZoom,
        pitch:    0,
        altitude: targetAlt,
      },
      { duration: 600 },
    );
  }, []);

  // ── Formatters ────────────────────────────────────────────────────────────
  function formatDriveTime(sec: number) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  // Compass rose display (N / NE / E …)
  function headingLabel(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  // ─── Styles ────────────────────────────────────────────────────────────────
  const CARD_SHADOW = {
    shadowColor: '#2E2414',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 20,
    elevation: 8,
  };

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#1a3d2a' },
    mapFull: { ...StyleSheet.absoluteFillObject },

    // ── Passenger / accuracy banners ──
    passengerBanner: {
      position: 'absolute', left: 0, right: 0, zIndex: 30,
      backgroundColor: colors.primary, paddingVertical: 7, paddingHorizontal: 16,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    },
    passengerBannerText: { fontSize: 13, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    accuracyWarning: {
      position: 'absolute', left: 12, zIndex: 20,
      backgroundColor: 'rgba(234,179,8,0.9)', borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 5,
    },
    accuracyWarningText: { fontSize: 11, color: '#1C1C1E', fontFamily: 'Inter_600SemiBold' },

    // ── Header ──
    header: {
      position: 'absolute', left: 12, right: 12, zIndex: 20,
      flexDirection: 'row', alignItems: 'center', gap: 10,
    },
    menuBtn: {
      width: 44, height: 44, borderRadius: 16,
      backgroundColor: 'rgba(255,255,255,0.97)',
      alignItems: 'center', justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(28,28,30,0.08)',
      ...CARD_SHADOW,
    },
    wordmarkWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    // Wordmark uses Archivo; falls back to Inter if not yet loaded
    wordmark: {
      fontSize: 17, fontWeight: '700', color: '#1C1C1E',
      fontFamily: 'Archivo_700Bold',
      letterSpacing: 2.4,
      textTransform: 'uppercase',
    },
    wordmarkAccent: { color: colors.primary },
    headerRight: { flexDirection: 'row', gap: 8 },
    notifBtn: {
      width: 44, height: 44, borderRadius: 22,
      backgroundColor: 'rgba(255,255,255,0.97)',
      alignItems: 'center', justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(28,28,30,0.08)',
      ...CARD_SHADOW,
    },
    avatarBtn: {
      width: 44, height: 44, borderRadius: 22,
      backgroundColor: '#1C1C1E',
      alignItems: 'center', justifyContent: 'center',
      ...CARD_SHADOW,
    },
    notifBadge: {
      position: 'absolute', top: 6, right: 6, width: 16, height: 16, borderRadius: 8,
      backgroundColor: colors.destructive, alignItems: 'center', justifyContent: 'center',
    },
    notifBadgeText: { fontSize: 9, color: '#fff', fontWeight: '700' },
    avatarText: { fontSize: 15, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold' },

    // ── Search bar ──
    searchBarWrap: { position: 'absolute', left: 12, right: 12, zIndex: 15 },
    searchBar: {
      backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 20, height: 58,
      paddingRight: 16, flexDirection: 'row', alignItems: 'center', gap: 0,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(28,28,30,0.06)',
      ...CARD_SHADOW,
      overflow: 'hidden',
    },
    searchIconBox: {
      width: 58, height: 58, alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.primary, borderTopLeftRadius: 20, borderBottomLeftRadius: 20,
    },
    searchPlaceholder: { flex: 1, fontSize: 15, color: '#8A8375', fontFamily: 'Inter_400Regular', marginLeft: 12 },

    // ── Quick-destination pills ──
    quickButtonsWrap: { position: 'absolute', left: 0, right: 0, zIndex: 14 },
    quickButtonsScroll: { paddingHorizontal: 12, gap: 8 },
    quickBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 999,
      paddingHorizontal: 14, paddingVertical: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(28,28,30,0.08)',
      ...CARD_SHADOW,
    },
    quickBtnScenic: {
      backgroundColor: '#1F4D3A',
      borderColor: 'transparent',
    },
    quickBtnActive: { backgroundColor: colors.primary, borderColor: 'transparent' },
    quickBtnText: { fontSize: 13, fontWeight: '600', color: '#1C1C1E', fontFamily: 'Inter_600SemiBold' },
    quickBtnTextScenic: { color: '#fff' },
    quickBtnTextActive: { color: '#fff' },

    // ── Right-side map control pill card ──
    mapControls: { position: 'absolute', right: 12, zIndex: 15, alignItems: 'center', gap: 10 },
    mapControlPill: {
      backgroundColor: 'rgba(255,255,255,0.97)',
      borderRadius: 24,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(28,28,30,0.08)',
      alignItems: 'center',
      overflow: 'hidden',
      ...CARD_SHADOW,
    },
    mapControlPillBtn: {
      width: 46, height: 46, alignItems: 'center', justifyContent: 'center',
    },
    mapControlDivider: {
      height: StyleSheet.hairlineWidth,
      width: 26,
      backgroundColor: 'rgba(28,28,30,0.12)',
    },
    mapControlNavigate: {
      width: 46, height: 46, borderRadius: 23,
      backgroundColor: colors.primary,
      alignItems: 'center', justifyContent: 'center',
      ...CARD_SHADOW,
    },
    // Legacy (still used by layer picker positioning)
    mapControlBtn: {
      width: 46, height: 46, borderRadius: 23,
      backgroundColor: 'rgba(255,255,255,0.97)', alignItems: 'center', justifyContent: 'center',
      ...CARD_SHADOW,
    },
    mapControlBtnActive: { backgroundColor: colors.primary },
    compassNorthLabel: { fontSize: 8, fontWeight: '700', color: colors.destructive, fontFamily: 'Inter_700Bold', lineHeight: 10 },
    compassDirLabel: { fontSize: 10, fontWeight: '600', color: '#1C1C1E', fontFamily: 'Inter_600SemiBold', lineHeight: 12 },

    // ── Resume following button ──
    resumeBtn: {
      position: 'absolute', zIndex: 25,
      backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 24,
      paddingHorizontal: 18, paddingVertical: 12,
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(28,28,30,0.08)',
      ...CARD_SHADOW,
    },
    resumeBtnText: { fontSize: 14, fontWeight: '700', color: '#1C1C1E', fontFamily: 'Inter_700Bold' },

    // ── Layer picker ──
    layerPicker: {
      position: 'absolute', right: 66, zIndex: 20,
      backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 14, overflow: 'hidden', ...CARD_SHADOW,
    },
    layerOption: {
      paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E8E4DE',
    },
    layerOptionLast: { borderBottomWidth: 0 },
    layerOptionText: { fontSize: 14, color: '#1C1C1E', fontFamily: 'Inter_400Regular' },
    layerOptionTextActive: { fontFamily: 'Inter_600SemiBold', color: colors.primary },

    // ── Unified bottom card ──
    bottomCard: {
      position: 'absolute', left: 16, right: 16, zIndex: 15,
      backgroundColor: 'rgba(255,255,255,0.97)',
      borderRadius: 26,
      padding: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(28,28,30,0.06)',
      ...CARD_SHADOW,
    },
    weatherRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
    weatherTemp: { fontSize: 20, fontWeight: '700', color: '#1C1C1E', fontFamily: 'Inter_700Bold' },
    weatherCondition: { fontSize: 12, color: '#1C1C1E', fontFamily: 'Inter_500Medium' },
    weatherGreeting: { fontSize: 11, color: '#8A8375', fontFamily: 'Inter_400Regular' },
    cardDivider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(28,28,30,0.08)', marginBottom: 12 },
    vehicleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    vehicleThumb: { width: 48, height: 48 },
    vehicleName: { fontSize: 13, fontWeight: '700', color: '#1C1C1E', fontFamily: 'Inter_700Bold' },
    vehicleMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    vehicleMetaText: { fontSize: 11, color: '#8A8375', fontFamily: 'Inter_400Regular' },
    demoTag: {
      backgroundColor: 'rgba(244,99,26,0.12)', borderRadius: 6,
      paddingHorizontal: 6, paddingVertical: 2, marginTop: 4, alignSelf: 'flex-start',
    },
    demoTagText: { fontSize: 9, color: colors.primary, fontFamily: 'Inter_500Medium' },
    startDriveBtn: {
      backgroundColor: colors.primary, borderRadius: 999,
      paddingHorizontal: 18, paddingVertical: 11,
      flexDirection: 'row', alignItems: 'center', gap: 7,
      marginLeft: 'auto' as any,
    },
    startDriveBtnText: { fontSize: 13, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold', letterSpacing: 0.4 },

    // ── Retained for drive HUD layout (legacy, unused visually but keeps TS happy) ──
    driveHUD: { position: 'absolute', left: 12, right: 12, zIndex: 20 },
    driveHUDTitle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
    driveIndicator: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e' },
    driveHUDTitleText: { fontSize: 14, fontWeight: '600', color: '#1C1C1E', fontFamily: 'Inter_600SemiBold', flex: 1 },
    driveTimer: { fontSize: 22, fontWeight: '700', color: '#1C1C1E', fontFamily: 'Inter_700Bold' },
    driveStats: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
    driveStatItem: { alignItems: 'center' },
    driveStatValue: { fontSize: 16, fontWeight: '600', color: '#1C1C1E', fontFamily: 'Inter_600SemiBold' },
    driveStatLabel: { fontSize: 10, color: '#8A8680', fontFamily: 'Inter_400Regular', marginTop: 1 },
    endDriveBtn: { marginTop: 12, borderRadius: 12, overflow: 'hidden' },
    endDriveBtnInner: { paddingVertical: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1C1C1E' },
    endDriveBtnText: { fontSize: 14, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    passengerNote: { fontSize: 10, color: colors.primary, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 6 },
    locationTag: {
      position: 'absolute', zIndex: 20, right: 66,
      backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    locationTagText: { fontSize: 10, color: 'rgba(255,255,255,0.8)', fontFamily: 'Inter_500Medium' },
  });

  const passengerOffset = isPassengerMode ? 34 : 0;

  const quickButtons = [
    { id: 'home', label: 'Home', icon: 'home-outline' as const, isActive: false },
    { id: 'work', label: 'Work', icon: 'briefcase-outline' as const, isActive: false },
    { id: 'favs', label: 'Favourites', icon: 'star-outline' as const, isActive: false },
    { id: 'recent', label: 'Recent', icon: 'time-outline' as const, isActive: false },
    { id: 'scenic', label: 'Scenic', icon: 'triangle-outline' as const, isActive: false },
  ];

  const mapLayers: Array<{ type: MapType; label: string; icon: string }> = [
    { type: 'standard', label: 'Standard', icon: 'map-outline' },
    { type: 'terrain', label: 'Terrain', icon: 'earth-outline' },
    { type: 'satellite', label: 'Satellite', icon: 'planet-outline' },
  ];

  // The marker rotation always equals the vehicle's actual heading.
  // In north-up mode: map bearing=0, marker points its heading direction.
  // In heading-up mode: map bearing=heading, marker counter-rotates back to
  //   "face screen-up" which also equals heading degrees.
  const markerRotation = displayHeading;

  return (
    <View style={styles.container}>
      {/* ── Map ── */}
      {Platform.OS !== 'web' ? (
        <MapView
          ref={mapRef}
          style={styles.mapFull}
          mapType={mapType}
          showsCompass={false}
          showsScale={false}
          showsUserLocation={false}
          showsTraffic={false}
          rotateEnabled
          scrollEnabled
          zoomEnabled
          pitchEnabled={false}
          onPanDrag={handleMapPanDrag}
          onRegionChangeComplete={handleRegionChangeComplete}
          initialRegion={
            userLocation
              ? { ...userLocation, latitudeDelta: 0.012, longitudeDelta: 0.012 }
              : { ...CONFIG.DEMO_REGION, latitudeDelta: 0.012, longitudeDelta: 0.012 }
          }
        >
          {userLocation && (
            <Marker
              coordinate={userLocation}
              anchor={{ x: 0.5, y: 0.5 }}
              rotation={markerRotation}
              tracksViewChanges={false}
            >
              <CarMarker accuracyWarning={accuracyWarning} />
            </Marker>
          )}
          {/* Orange trail for free-drive tracking mode */}
          {isDriving && currentDrive && currentDrive.coordinates.length > 1 && (
            <Polyline
              coordinates={currentDrive.coordinates}
              strokeColor="#F4631A"
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
          <Text style={styles.passengerBannerText}>Passenger Mode — Journey not recording</Text>
          <TouchableOpacity onPress={() => router.push('/settings')} style={{ marginLeft: 8 }}>
            <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontFamily: 'Inter_400Regular', textDecorationLine: 'underline' }}>Settings</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── GPS accuracy warning ── */}
      {accuracyWarning && (
        <View style={[styles.accuracyWarning, { top: headerTop + HEADER_H + 60 + passengerOffset }]}>
          <Ionicons name="warning-outline" size={12} color="#1C1C1E" />
          <Text style={styles.accuracyWarningText}>Poor GPS signal</Text>
        </View>
      )}

      {/* ── Floating header ── (hidden during active drive) */}
      <View style={[styles.header, { top: headerTop + passengerOffset, display: isDriving ? 'none' : 'flex' }]}>
        <TouchableOpacity style={styles.menuBtn} onPress={() => router.push('/settings')}>
          <Ionicons name="menu" size={22} color="#1C1C1E" />
        </TouchableOpacity>
        <View style={styles.wordmarkWrap}>
          <Text style={styles.wordmark}>Drive <Text style={styles.wordmarkAccent}>OS</Text></Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.notifBtn} onPress={() => router.push('/messages')}>
            <Ionicons name="notifications-outline" size={20} color="#1C1C1E" />
            {(unreadNotificationCount ?? 0) > 0 && (
              <View style={styles.notifBadge}>
                <Text style={styles.notifBadgeText}>{unreadNotificationCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.avatarBtn} onPress={() => router.push('/(tabs)/profile')}>
            <Text style={styles.avatarText}>{userProfile.name.charAt(0)}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Search bar ── */}
      {!isDriving && (
        <View style={[styles.searchBarWrap, { top: SEARCH_TOP + passengerOffset }]}>
          <TouchableOpacity style={styles.searchBar} onPress={() => router.push('/search')} activeOpacity={0.85}>
            <View style={styles.searchIconBox}>
              <Ionicons name="search" size={20} color="#fff" />
            </View>
            <Text style={styles.searchPlaceholder}>Where are we going?</Text>
            <Ionicons name="mic-outline" size={20} color="#8A8375" />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Quick destination buttons ── */}
      {!isDriving && (
        <View style={[styles.quickButtonsWrap, { top: QUICK_TOP + passengerOffset }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickButtonsScroll}>
            {quickButtons.map((btn) => {
              const isScenic = btn.id === 'scenic';
              return (
                <TouchableOpacity
                  key={btn.id}
                  style={[styles.quickBtn, isScenic && styles.quickBtnScenic, btn.isActive && styles.quickBtnActive]}
                  onPress={() => router.push('/search')}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={btn.icon}
                    size={15}
                    color={isScenic || btn.isActive ? '#fff' : '#1C1C1E'}
                  />
                  <Text style={[
                    styles.quickBtnText,
                    isScenic && styles.quickBtnTextScenic,
                    btn.isActive && styles.quickBtnTextActive,
                  ]}>{btn.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* ── Map controls (right side, hidden during drive — overlay has its own) ── */}
      {!isDriving && (
        <View style={[styles.mapControls, { top: MAP_CONTROLS_TOP + passengerOffset }]}>
          {/* Grouped pill: compass + layers + friends */}
          <View style={styles.mapControlPill}>
            {/* Compass / north-up toggle */}
            <TouchableOpacity
              style={[styles.mapControlPillBtn, headingMode === 'north-up' && { backgroundColor: 'rgba(244,99,26,0.1)' }]}
              onPress={handleToggleHeadingMode}
            >
              <View style={{ transform: [{ rotate: headingMode === 'heading-up' ? `${-displayHeading}deg` : '0deg' }], alignItems: 'center' }}>
                <Text style={styles.compassNorthLabel}>N</Text>
              </View>
              <Text style={[styles.compassDirLabel, { color: headingMode === 'north-up' ? colors.primary : '#1C1C1E' }]}>
                {headingMode === 'north-up' ? 'N↑' : headingLabel(displayHeading)}
              </Text>
            </TouchableOpacity>

            <View style={styles.mapControlDivider} />

            {/* Layer picker toggle */}
            <TouchableOpacity
              style={[styles.mapControlPillBtn, showLayerPicker && { backgroundColor: 'rgba(244,99,26,0.1)' }]}
              onPress={() => { setShowLayerPicker(!showLayerPicker); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            >
              <Ionicons name="layers-outline" size={20} color={showLayerPicker ? colors.primary : '#1C1C1E'} />
            </TouchableOpacity>

            <View style={styles.mapControlDivider} />

            {/* Friends toggle */}
            <TouchableOpacity
              style={[styles.mapControlPillBtn, showFriends && { backgroundColor: 'rgba(244,99,26,0.1)' }]}
              onPress={() => { setShowFriends(!showFriends); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            >
              <Ionicons name="people-outline" size={20} color={showFriends ? colors.primary : '#1C1C1E'} />
            </TouchableOpacity>
          </View>

          {/* Separate orange navigate / locate circle */}
          <TouchableOpacity style={styles.mapControlNavigate} onPress={handleLocateButton}>
            <Ionicons
              name={followMode === 'following' ? 'navigate' : 'navigate-outline'}
              size={20}
              color="#fff"
            />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Layer picker (hidden during drive) ── */}
      {!isDriving && showLayerPicker && (
        <View style={[styles.layerPicker, { top: MAP_CONTROLS_TOP + passengerOffset + 130 }]}>
          {mapLayers.map((layer, i) => (
            <TouchableOpacity
              key={layer.type}
              style={[styles.layerOption, i === mapLayers.length - 1 && styles.layerOptionLast]}
              onPress={() => { setMapType(layer.type); setShowLayerPicker(false); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            >
              <Ionicons name={layer.icon as any} size={16} color={mapType === layer.type ? colors.primary : '#8A8680'} />
              <Text style={[styles.layerOptionText, mapType === layer.type && styles.layerOptionTextActive]}>{layer.label}</Text>
              {mapType === layer.type && <Ionicons name="checkmark" size={14} color={colors.primary} style={{ marginLeft: 'auto' as any }} />}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Resume Following button (non-drive mode only; overlay handles it during drives) ── */}
      {!isDriving && (
        <Animated.View
          style={[
            styles.resumeBtn,
            {
              bottom: BOTTOM_CARD_BOTTOM + 90,
              alignSelf: 'center',
              left: undefined, right: undefined,
              opacity: resumeButtonAnim,
              transform: [{ translateY: resumeButtonAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
              pointerEvents: followMode === 'free' ? 'auto' : 'none',
            },
          ]}
        >
          <TouchableOpacity onPress={handleResumeFollowing} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="navigate" size={18} color={colors.primary} />
            <Text style={styles.resumeBtnText}>Resume following</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* ── Active Drive Overlay ── */}
      {isDriving && (
        <ActiveDriveOverlay
          currentDrive={currentDrive}
          driveSeconds={driveSeconds}
          isPaused={isPaused}
          driveMode={'tracking' as ActiveDriveMode}
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

      {/* ── Unified bottom card: weather + vehicle + START DRIVE ── */}
      {!isDriving && (
        <View style={[styles.bottomCard, { bottom: BOTTOM_CARD_BOTTOM }]}>
          {/* Weather row */}
          <View style={styles.weatherRow}>
            <Ionicons name={CONFIG.DEMO_WEATHER.icon} size={22} color="#f59e0b" />
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                <Text style={styles.weatherTemp}>{CONFIG.DEMO_WEATHER.temperature}°</Text>
                <Text style={styles.weatherCondition}>{CONFIG.DEMO_WEATHER.condition}</Text>
              </View>
              <Text style={styles.weatherGreeting}>{getGreeting()}, {userProfile.name}</Text>
            </View>
          </View>

          <View style={styles.cardDivider} />

          {/* Vehicle row + START DRIVE inline */}
          <TouchableOpacity
            style={styles.vehicleRow}
            onPress={() => router.push('/(tabs)/garage')}
            activeOpacity={0.75}
          >
            {activeVehicle ? (
              <>
                {activeVehicle.id === 'mock-vehicle-1'
                  ? <Image source={MINI_IMAGE} style={styles.vehicleThumb} resizeMode="contain" />
                  : <Ionicons name="car" size={36} color={colors.primary} />
                }
                <View style={{ flex: 1 }}>
                  <Text style={styles.vehicleName}>{activeVehicle.make} {activeVehicle.model}</Text>
                  <View style={styles.vehicleMeta}>
                    <Ionicons name="speedometer-outline" size={11} color="#8A8375" />
                    <Text style={styles.vehicleMetaText}>{activeVehicle.mileage.toLocaleString()} mi</Text>
                    <Text style={styles.vehicleMetaText}>·</Text>
                    <Text style={styles.vehicleMetaText}>{activeVehicle.fuelType}</Text>
                  </View>
                  {locationMode === 'simulated' && (
                    <View style={styles.demoTag}>
                      <Text style={styles.demoTagText}>SIMULATED</Text>
                    </View>
                  )}
                </View>
              </>
            ) : (
              <Text style={{ flex: 1, fontSize: 13, color: '#8A8375', fontFamily: 'Inter_400Regular' }}>
                No vehicle — tap to add
              </Text>
            )}

            {/* START DRIVE pill — right side of vehicle row */}
            <TouchableOpacity
              style={styles.startDriveBtn}
              onPress={handleStartDrive}
              activeOpacity={0.85}
            >
              <Ionicons name="navigate" size={15} color="#fff" />
              <Text style={styles.startDriveBtnText}>START DRIVE</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

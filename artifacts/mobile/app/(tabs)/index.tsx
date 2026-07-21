import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, ScrollView, Image,
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
import MapView, { Marker, MapType } from 'react-native-maps';
import * as Location from 'expo-location';

const MINI_IMAGE = require('@/assets/images/mini-cooper.png');

// ─── Top-down car marker ──────────────────────────────────────────────────────
function CarMarker() {
  return (
    <View style={{ width: 36, height: 50, alignItems: 'center', justifyContent: 'center' }}>
      {/* Location halo */}
      <View style={{
        position: 'absolute', width: 52, height: 52, borderRadius: 26,
        backgroundColor: 'rgba(244, 99, 26, 0.18)',
        borderWidth: 1.5, borderColor: 'rgba(244, 99, 26, 0.35)',
      }} />
      <Svg width={28} height={44} viewBox="0 0 28 44">
        {/* Body */}
        <Rect x="6" y="6" width="16" height="32" rx="4" fill="white" stroke="#1C1C1E" strokeWidth="1.5" />
        {/* Windscreen */}
        <Rect x="8" y="8" width="12" height="10" rx="2" fill="#A8D4F0" opacity="0.9" />
        {/* Rear window */}
        <Rect x="9" y="26" width="10" height="7" rx="1.5" fill="#A8D4F0" opacity="0.7" />
        {/* Front wheels */}
        <Rect x="2" y="10" width="4" height="8" rx="2" fill="#444" />
        <Rect x="22" y="10" width="4" height="8" rx="2" fill="#444" />
        {/* Rear wheels */}
        <Rect x="2" y="26" width="4" height="8" rx="2" fill="#444" />
        <Rect x="22" y="26" width="4" height="8" rx="2" fill="#444" />
        {/* Headlights */}
        <Ellipse cx="9" cy="6" rx="2.5" ry="1.5" fill="#FFEFC0" />
        <Ellipse cx="19" cy="6" rx="2.5" ry="1.5" fill="#FFEFC0" />
        {/* Tail lights */}
        <Ellipse cx="9" cy="38" rx="2.5" ry="1.5" fill="#FFB0B0" />
        <Ellipse cx="19" cy="38" rx="2.5" ry="1.5" fill="#FFB0B0" />
        {/* Roof detail */}
        <Rect x="9" y="20" width="10" height="6" rx="1" fill="#E0E0E0" opacity="0.6" />
      </Svg>
    </View>
  );
}

// ─── Demo map for web ────────────────────────────────────────────────────────
function DemoMapBackground({ mapType }: { mapType: MapType }) {
  const isSatellite = mapType === 'satellite' || mapType === 'hybrid';
  const bgColors: [string, string, string, string] = isSatellite
    ? ['#1a3d2a', '#2d5a3c', '#254e34', '#1e4530']
    : ['#c8d8b0', '#b2cb96', '#9aba7a', '#aec98e'];

  return (
    <View style={StyleSheet.absoluteFill}>
      <LinearGradient colors={bgColors} style={StyleSheet.absoluteFill} />
      <Svg style={StyleSheet.absoluteFill as any} viewBox="0 0 400 850" preserveAspectRatio="xMidYMid slice">
        {/* Water bodies */}
        <Ellipse cx={75} cy={240} rx={72} ry={44}
          fill={isSatellite ? '#1a4a6e' : '#5a9fc4'} opacity={isSatellite ? 0.85 : 0.65} />
        <Ellipse cx={50} cy={275} rx={35} ry={20}
          fill={isSatellite ? '#1a4a6e' : '#5a9fc4'} opacity={isSatellite ? 0.75 : 0.55} />
        <Ellipse cx={320} cy={370} rx={45} ry={28}
          fill={isSatellite ? '#1a4a6e' : '#5a9fc4'} opacity={isSatellite ? 0.7 : 0.5} />
        {/* Terrain patches */}
        <Ellipse cx={290} cy={180} rx={80} ry={55}
          fill={isSatellite ? '#1d4a28' : '#7aac62'} opacity={0.6} />
        <Ellipse cx={130} cy={520} rx={90} ry={60}
          fill={isSatellite ? '#1f5530' : '#88b86e'} opacity={0.5} />
        {/* Roads */}
        <Path d="M 200 0 Q 190 150 195 300 Q 200 450 215 600 L 210 850"
          stroke={isSatellite ? 'rgba(220,210,185,0.7)' : 'rgba(180,170,150,0.8)'}
          strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M 0 380 Q 80 370 160 385 Q 250 400 350 390 L 400 388"
          stroke={isSatellite ? 'rgba(220,210,185,0.55)' : 'rgba(180,170,150,0.7)'}
          strokeWidth={4} fill="none" strokeLinecap="round" />
        <Path d="M 0 480 Q 100 465 200 475 Q 290 485 370 470 L 400 465"
          stroke={isSatellite ? 'rgba(220,210,185,0.4)' : 'rgba(180,170,150,0.5)'}
          strokeWidth={2.5} fill="none" strokeLinecap="round" />
        <Path d="M 155 0 Q 160 120 155 250 Q 150 350 165 420"
          stroke={isSatellite ? 'rgba(220,210,185,0.45)' : 'rgba(180,170,150,0.55)'}
          strokeWidth={2} fill="none" strokeLinecap="round" />
        {/* Small settlement dots */}
        <Circle cx={198} cy={390} r={6} fill={isSatellite ? 'rgba(240,230,200,0.35)' : 'rgba(160,140,110,0.35)'} />
        <Circle cx={205} cy={395} r={4} fill={isSatellite ? 'rgba(240,230,200,0.3)' : 'rgba(160,140,110,0.3)'} />
      </Svg>
      {/* Demo label */}
      <View style={{
        position: 'absolute', bottom: 130, left: 12,
        backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8,
        paddingHorizontal: 8, paddingVertical: 4,
      }}>
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
  const { activeVehicle, userProfile, isPassengerMode, isDriving, currentDrive, startDrive, endDrive, updateDriveCoordinate } = useApp();

  const [mapType, setMapType] = useState<MapType>('satellite');
  const [showLayerPicker, setShowLayerPicker] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [locationMode, setLocationMode] = useState<'live' | 'simulated'>('simulated');
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [driveSeconds, setDriveSeconds] = useState(0);
  const mapRef = useRef<MapView>(null);
  const driveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tab bar offset
  const tabBarOffset = Platform.OS === 'web' ? 84 : 50 + insets.bottom;
  const headerTop = Platform.OS === 'web' ? 67 + insets.top : insets.top;

  // Location tracking
  useEffect(() => {
    let cleanup: (() => void) | null = null;

    const startTracking = async () => {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
          const watchId = navigator.geolocation.watchPosition(
            (pos) => {
              setUserLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
              setLocationMode('live');
            },
            () => {
              setUserLocation(CONFIG.DEMO_REGION);
              setLocationMode('simulated');
            },
            { enableHighAccuracy: true, timeout: 8000 }
          );
          cleanup = () => navigator.geolocation.clearWatch(watchId);
        } else {
          setUserLocation(CONFIG.DEMO_REGION);
        }
      } else {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          setLocationMode('live');
          const subscription = await Location.watchPositionAsync(
            { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 8 },
            (loc) => {
              const coord = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
              setUserLocation(coord);
              if (isDriving && !isPassengerMode) {
                updateDriveCoordinate({ ...coord, speed: loc.coords.speed ?? 0 });
              }
            }
          );
          cleanup = () => subscription.remove();
        } else {
          setUserLocation(CONFIG.DEMO_REGION);
          setLocationMode('simulated');
        }
      }
    };

    startTracking();
    return () => cleanup?.();
  }, [isDriving, isPassengerMode]);

  // Drive timer
  useEffect(() => {
    if (isDriving) {
      driveTimerRef.current = setInterval(() => setDriveSeconds((s) => s + 1), 1000);
    } else {
      if (driveTimerRef.current) clearInterval(driveTimerRef.current);
      setDriveSeconds(0);
    }
    return () => { if (driveTimerRef.current) clearInterval(driveTimerRef.current); };
  }, [isDriving]);

  function handleRecenter() {
    if (userLocation && mapRef.current) {
      mapRef.current.animateToRegion({ ...userLocation, latitudeDelta: 0.012, longitudeDelta: 0.012 }, 600);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }

  function handleStartDrive() {
    startDrive();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleEndDrive() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push('/drive-summary');
  }

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

  const CARD_SHADOW = {
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12, shadowRadius: 12, elevation: 8,
  };

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#1a3d2a' },
    mapFull: { ...StyleSheet.absoluteFillObject },
    // Passenger banner
    passengerBanner: {
      position: 'absolute', left: 0, right: 0, zIndex: 30,
      backgroundColor: colors.primary, paddingVertical: 7, paddingHorizontal: 16,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    },
    passengerBannerText: { fontSize: 13, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    // Location mode tag
    locationTag: {
      position: 'absolute', zIndex: 20, right: 60,
      backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    locationTagText: { fontSize: 10, color: 'rgba(255,255,255,0.8)', fontFamily: 'Inter_500Medium' },
    // Floating header
    header: {
      position: 'absolute', left: 12, right: 12, zIndex: 20,
      flexDirection: 'row', alignItems: 'center', gap: 10,
    },
    menuBtn: {
      width: 44, height: 44, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.95)',
      alignItems: 'center', justifyContent: 'center', ...CARD_SHADOW,
    },
    wordmarkWrap: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
    },
    wordmark: {
      fontSize: 22, fontWeight: '700', color: '#1C1C1E', fontFamily: 'Inter_700Bold',
      letterSpacing: -0.5,
    },
    wordmarkAccent: { color: colors.primary },
    headerRight: { flexDirection: 'row', gap: 8 },
    headerIconBtn: {
      width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.95)',
      alignItems: 'center', justifyContent: 'center', ...CARD_SHADOW,
    },
    notifBadge: {
      position: 'absolute', top: 6, right: 6, width: 16, height: 16, borderRadius: 8,
      backgroundColor: colors.destructive, alignItems: 'center', justifyContent: 'center',
    },
    notifBadgeText: { fontSize: 9, color: '#fff', fontWeight: '700' },
    avatarText: { fontSize: 15, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold' },
    // Search bar
    searchBarWrap: {
      position: 'absolute', left: 12, right: 12, zIndex: 15,
    },
    searchBar: {
      backgroundColor: 'rgba(255,255,255,0.97)',
      borderRadius: 18, height: 52, paddingHorizontal: 16,
      flexDirection: 'row', alignItems: 'center', gap: 10,
      ...CARD_SHADOW,
    },
    searchPlaceholder: {
      flex: 1, fontSize: 16, color: '#8A8680', fontFamily: 'Inter_400Regular',
    },
    // Quick buttons
    quickButtonsWrap: {
      position: 'absolute', left: 0, right: 0, zIndex: 14,
    },
    quickButtonsScroll: { paddingHorizontal: 12, gap: 8 },
    quickBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 22,
      paddingHorizontal: 14, paddingVertical: 9,
      ...CARD_SHADOW,
    },
    quickBtnActive: { backgroundColor: colors.primary },
    quickBtnText: { fontSize: 13, fontWeight: '600', color: '#1C1C1E', fontFamily: 'Inter_600SemiBold' },
    quickBtnTextActive: { color: '#fff' },
    // Map controls
    mapControls: {
      position: 'absolute', right: 12, zIndex: 15, gap: 10,
    },
    mapControlBtn: {
      width: 46, height: 46, borderRadius: 23,
      backgroundColor: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center',
      ...CARD_SHADOW,
    },
    mapControlBtnActive: { backgroundColor: colors.primary },
    // Layer picker
    layerPicker: {
      position: 'absolute', right: 66, zIndex: 20,
      backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 14, overflow: 'hidden',
      ...CARD_SHADOW,
    },
    layerOption: {
      paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E8E4DE',
    },
    layerOptionLast: { borderBottomWidth: 0 },
    layerOptionText: { fontSize: 14, color: '#1C1C1E', fontFamily: 'Inter_400Regular' },
    layerOptionTextActive: { fontFamily: 'Inter_600SemiBold', color: colors.primary },
    // Vehicle/weather card
    vwCard: {
      position: 'absolute', left: 12, zIndex: 15,
      backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 18,
      padding: 12, maxWidth: 200,
      ...CARD_SHADOW,
    },
    weatherRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
    weatherTemp: { fontSize: 20, fontWeight: '700', color: '#1C1C1E', fontFamily: 'Inter_700Bold' },
    weatherInfo: {},
    weatherCondition: { fontSize: 12, color: '#1C1C1E', fontFamily: 'Inter_500Medium' },
    weatherGreeting: { fontSize: 11, color: '#8A8680', fontFamily: 'Inter_400Regular' },
    cardDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E8E4DE', marginBottom: 8 },
    vehicleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    vehicleThumb: { width: 44, height: 44 },
    vehicleName: { fontSize: 13, fontWeight: '700', color: '#1C1C1E', fontFamily: 'Inter_700Bold' },
    vehicleMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    vehicleMetaText: { fontSize: 11, color: '#8A8680', fontFamily: 'Inter_400Regular' },
    cardArrow: { marginLeft: 'auto' as any },
    demoTag: {
      backgroundColor: 'rgba(244,99,26,0.15)', borderRadius: 6,
      paddingHorizontal: 6, paddingVertical: 2, marginTop: 4, alignSelf: 'flex-start',
    },
    demoTagText: { fontSize: 9, color: colors.primary, fontFamily: 'Inter_500Medium' },
    // Create Route button
    createRouteBtn: {
      position: 'absolute', right: 12, zIndex: 15, borderRadius: 28, overflow: 'hidden',
      ...CARD_SHADOW,
    },
    createRouteBtnGrad: {
      paddingHorizontal: 22, paddingVertical: 14,
      flexDirection: 'row', alignItems: 'center', gap: 8,
    },
    createRouteBtnText: {
      fontSize: 15, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold', letterSpacing: 0.5,
    },
    // Drive HUD
    driveHUD: {
      position: 'absolute', left: 12, right: 12, zIndex: 20,
      backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 20, padding: 14,
      ...CARD_SHADOW,
    },
    driveHUDTitle: {
      flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12,
    },
    driveIndicator: {
      width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e',
    },
    driveHUDTitleText: { fontSize: 14, fontWeight: '600', color: '#1C1C1E', fontFamily: 'Inter_600SemiBold', flex: 1 },
    driveTimer: { fontSize: 22, fontWeight: '700', color: '#1C1C1E', fontFamily: 'Inter_700Bold' },
    driveStats: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
    driveStatItem: { alignItems: 'center' },
    driveStatValue: { fontSize: 16, fontWeight: '600', color: '#1C1C1E', fontFamily: 'Inter_600SemiBold' },
    driveStatLabel: { fontSize: 10, color: '#8A8680', fontFamily: 'Inter_400Regular', marginTop: 1 },
    endDriveBtn: {
      marginTop: 12, borderRadius: 12, overflow: 'hidden',
    },
    endDriveBtnInner: {
      paddingVertical: 11, alignItems: 'center', justifyContent: 'center',
      backgroundColor: '#1C1C1E',
    },
    endDriveBtnText: { fontSize: 14, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    passengerNote: { fontSize: 10, color: colors.primary, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 6 },
  });

  // Positions
  const HEADER_H = 44;
  const SEARCH_TOP = headerTop + HEADER_H + 10;
  const QUICK_TOP = SEARCH_TOP + 52 + 10;
  const MAP_CONTROLS_TOP = QUICK_TOP + 44 + 16;
  const BOTTOM_ELEMENTS_BOTTOM = tabBarOffset + 16;

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
          initialRegion={userLocation
            ? { ...userLocation, latitudeDelta: 0.012, longitudeDelta: 0.012 }
            : { ...CONFIG.DEMO_REGION }
          }
        >
          {userLocation && (
            <Marker coordinate={userLocation} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
              <CarMarker />
            </Marker>
          )}
        </MapView>
      ) : (
        <DemoMapBackground mapType={mapType} />
      )}

      {/* ── Passenger mode banner ── */}
      {isPassengerMode && (
        <View style={[styles.passengerBanner, { top: headerTop }]}>
          <Ionicons name="walk-outline" size={14} color="#fff" />
          <Text style={styles.passengerBannerText}>Passenger Mode — Journey not recording</Text>
          <TouchableOpacity onPress={() => router.push('/settings')} style={{ marginLeft: 8 }}>
            <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontFamily: 'Inter_400Regular', textDecorationLine: 'underline' }}>Settings</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Floating header ── */}
      <View style={[styles.header, { top: headerTop + (isPassengerMode ? 34 : 0) }]}>
        <TouchableOpacity style={styles.menuBtn} onPress={() => router.push('/settings')}>
          <Ionicons name="menu" size={22} color="#1C1C1E" />
        </TouchableOpacity>

        <View style={styles.wordmarkWrap}>
          <Text style={styles.wordmark}>
            Drive<Text style={styles.wordmarkAccent}>OS</Text>
          </Text>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.headerIconBtn}>
            <Ionicons name="notifications-outline" size={20} color="#1C1C1E" />
            <View style={styles.notifBadge}>
              <Text style={styles.notifBadgeText}>2</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.headerIconBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/(tabs)/profile')}
          >
            <Text style={styles.avatarText}>{userProfile.name.charAt(0)}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Search bar ── */}
      {!isDriving && (
        <View style={[styles.searchBarWrap, { top: SEARCH_TOP + (isPassengerMode ? 34 : 0) }]}>
          <TouchableOpacity style={styles.searchBar} onPress={() => router.push('/search')} activeOpacity={0.85}>
            <Ionicons name="search" size={20} color="#8A8680" />
            <Text style={styles.searchPlaceholder}>Where are we going?</Text>
            <Ionicons name="mic-outline" size={20} color="#8A8680" />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Quick destination buttons ── */}
      {!isDriving && (
        <View style={[styles.quickButtonsWrap, { top: QUICK_TOP + (isPassengerMode ? 34 : 0) }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickButtonsScroll}>
            {quickButtons.map((btn) => (
              <TouchableOpacity
                key={btn.id}
                style={[styles.quickBtn, btn.isActive && styles.quickBtnActive]}
                onPress={() => router.push('/search')}
                activeOpacity={0.8}
              >
                <Ionicons name={btn.icon} size={15} color={btn.isActive ? '#fff' : '#1C1C1E'} />
                <Text style={[styles.quickBtnText, btn.isActive && styles.quickBtnTextActive]}>{btn.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── Map controls (right side) ── */}
      <View style={[styles.mapControls, { top: MAP_CONTROLS_TOP + (isPassengerMode ? 34 : 0) }]}>
        <TouchableOpacity style={styles.mapControlBtn} onPress={handleRecenter}>
          <Ionicons name="compass-outline" size={22} color="#1C1C1E" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.mapControlBtn, showFriends && styles.mapControlBtnActive]}
          onPress={() => { setShowFriends(!showFriends); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
        >
          <Ionicons name="people-outline" size={20} color={showFriends ? '#fff' : '#1C1C1E'} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.mapControlBtn, showLayerPicker && styles.mapControlBtnActive]}
          onPress={() => { setShowLayerPicker(!showLayerPicker); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
        >
          <Ionicons name="layers-outline" size={20} color={showLayerPicker ? '#fff' : '#1C1C1E'} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.mapControlBtn} onPress={handleRecenter}>
          <Ionicons name="locate-outline" size={20} color="#1C1C1E" />
        </TouchableOpacity>
      </View>

      {/* ── Layer picker ── */}
      {showLayerPicker && (
        <View style={[styles.layerPicker, { top: MAP_CONTROLS_TOP + (isPassengerMode ? 34 : 0) + 100 }]}>
          {mapLayers.map((layer, i) => (
            <TouchableOpacity
              key={layer.type}
              style={[styles.layerOption, i === mapLayers.length - 1 && styles.layerOptionLast]}
              onPress={() => { setMapType(layer.type); setShowLayerPicker(false); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            >
              <Ionicons name={layer.icon as any} size={16} color={mapType === layer.type ? colors.primary : '#8A8680'} />
              <Text style={[styles.layerOptionText, mapType === layer.type && styles.layerOptionTextActive]}>
                {layer.label}
              </Text>
              {mapType === layer.type && <Ionicons name="checkmark" size={14} color={colors.primary} style={{ marginLeft: 'auto' as any }} />}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Active drive HUD ── */}
      {isDriving && (
        <View style={[styles.driveHUD, { bottom: BOTTOM_ELEMENTS_BOTTOM + 80 }]}>
          <View style={styles.driveHUDTitle}>
            <View style={styles.driveIndicator} />
            <Text style={styles.driveHUDTitleText}>Drive in progress</Text>
            <Text style={styles.driveTimer}>{formatDriveTime(driveSeconds)}</Text>
          </View>
          <View style={styles.driveStats}>
            <View style={styles.driveStatItem}>
              <Text style={styles.driveStatValue}>
                {currentDrive ? currentDrive.estimatedDistance.toFixed(1) : '0.0'} km
              </Text>
              <Text style={styles.driveStatLabel}>Distance</Text>
            </View>
            <View style={styles.driveStatItem}>
              <Text style={styles.driveStatValue}>
                {currentDrive ? Math.round(currentDrive.currentSpeed) : 0} km/h
              </Text>
              <Text style={styles.driveStatLabel}>Speed</Text>
            </View>
            <View style={styles.driveStatItem}>
              <Text style={[styles.driveStatValue, { color: colors.primary }]}>
                {currentDrive ? Math.round(currentDrive.topSpeed) : 0} km/h
              </Text>
              <Text style={styles.driveStatLabel}>Top Speed</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.endDriveBtn} onPress={handleEndDrive}>
            <View style={styles.endDriveBtnInner}>
              <Text style={styles.endDriveBtnText}>End Drive</Text>
            </View>
          </TouchableOpacity>
          {isPassengerMode && <Text style={styles.passengerNote}>Passenger Mode — not recording journey data</Text>}
        </View>
      )}

      {/* ── Vehicle & weather card (bottom left) ── */}
      {!isDriving && (
        <TouchableOpacity
          style={[styles.vwCard, { bottom: BOTTOM_ELEMENTS_BOTTOM }]}
          onPress={() => router.push('/(tabs)/garage')}
          activeOpacity={0.85}
        >
          {/* Weather */}
          <View style={styles.weatherRow}>
            <Ionicons name={CONFIG.DEMO_WEATHER.icon} size={22} color="#f59e0b" />
            <View style={styles.weatherInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                <Text style={styles.weatherTemp}>{CONFIG.DEMO_WEATHER.temperature}°</Text>
                <Text style={styles.weatherCondition}>{CONFIG.DEMO_WEATHER.condition}</Text>
              </View>
              <Text style={styles.weatherGreeting}>{getGreeting()}, {userProfile.name}</Text>
            </View>
          </View>
          <View style={styles.cardDivider} />
          {/* Vehicle */}
          {activeVehicle ? (
            <View style={styles.vehicleRow}>
              {activeVehicle.id === 'mock-vehicle-1'
                ? <Image source={MINI_IMAGE} style={styles.vehicleThumb} resizeMode="contain" />
                : <Ionicons name="car" size={32} color={colors.primary} />
              }
              <View style={{ flex: 1 }}>
                <Text style={styles.vehicleName}>{activeVehicle.make} {activeVehicle.model}</Text>
                <View style={styles.vehicleMeta}>
                  <Ionicons name="water-outline" size={11} color="#8A8680" />
                  <Text style={styles.vehicleMetaText}>{activeVehicle.fuelPercentage}%</Text>
                  <Text style={styles.vehicleMetaText}>·</Text>
                  <Text style={styles.vehicleMetaText}>{activeVehicle.mileage.toLocaleString()} mi</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={16} color="#8A8680" />
            </View>
          ) : (
            <Text style={{ fontSize: 13, color: '#8A8680', fontFamily: 'Inter_400Regular' }}>No vehicle — tap to add</Text>
          )}
          {locationMode === 'simulated' && (
            <View style={styles.demoTag}>
              <Text style={styles.demoTagText}>SIMULATED LOCATION</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* ── Create Route / Start Drive button ── */}
      {!isDriving ? (
        <TouchableOpacity
          style={[styles.createRouteBtn, { bottom: BOTTOM_ELEMENTS_BOTTOM }]}
          onPress={handleStartDrive}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={['#F4631A', '#FF4E3A']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.createRouteBtnGrad}
          >
            <Ionicons name="navigate" size={18} color="#fff" />
            <Text style={styles.createRouteBtnText}>START DRIVE</Text>
          </LinearGradient>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

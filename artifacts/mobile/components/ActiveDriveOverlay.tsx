/**
 * ActiveDriveOverlay
 *
 * Full-screen overlay rendered on top of the map during an active drive.
 * The top area is fully transparent so the map/polyline shows through and
 * touch events (pan/zoom) pass through to MapView.
 * The bottom telemetry panel has a solid white background.
 */
import React, { memo, useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Alert, Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path, Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { ActiveDrive } from '@/context/AppContext';
import {
  ResolvedUnitSystem, formatDistance, speedUnit,
} from '@/lib/units';

export type ActiveDriveMode = 'navigation' | 'tracking';

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
  locationMode: 'live' | 'simulated';
  gpsAccuracy: number | null;
  accuracyWarning: boolean;
  followMode: 'following' | 'free';
  resolvedUnitSystem: ResolvedUnitSystem;
  isPassengerMode: boolean;
  navInstruction?: NavInstruction | null;
  insets: { top: number; bottom: number };

  onPause: () => void;
  onResume: () => void;
  onEndDrive: () => void;
  onSavePoint: () => void;
  onLocateButton: () => void;
  onResumeFollowing: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ORANGE = '#F4631A';
const TEXT_PRIMARY = '#1C1C1E';
const TEXT_SECONDARY = '#8A8680';
const TRACK_COLOR = '#E5E2DE';
const CARD_SHADOW = {
  shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
  shadowOpacity: 0.14, shadowRadius: 10, elevation: 6,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDriveTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function avgSpeedKmh(drive: ActiveDrive | null): number {
  if (!drive || drive.speedSamples.length === 0) return 0;
  return drive.speedSamples.reduce((a, b) => a + b, 0) / drive.speedSamples.length;
}

function convertSpeed(kmh: number, system: ResolvedUnitSystem): number {
  return system === 'imperial' ? kmh * 0.621371 : kmh;
}

// ─── Speedometer SVG ──────────────────────────────────────────────────────────
// Memoised: only re-renders when speed changes, not on every other state update.
const Speedometer = memo(function Speedometer({
  speedKmh,
  resolvedUnitSystem,
}: {
  speedKmh: number;
  resolvedUnitSystem: ResolvedUnitSystem;
}) {
  const maxSpd = resolvedUnitSystem === 'imperial' ? 100 : 160; // display max
  const displaySpd = convertSpeed(Math.max(0, speedKmh), resolvedUnitSystem);
  const unit = speedUnit(resolvedUnitSystem);

  // Arc geometry: 135° → 405° (= 45°) clockwise in SVG space, radius 72
  const CX = 100, CY = 100, R = 72, SW = 10;
  const START = 135;
  const SWEEP = 270;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const pt = (deg: number) => ({
    x: CX + R * Math.cos(toRad(deg)),
    y: CY + R * Math.sin(toRad(deg)),
  });

  const s = pt(START);
  const e = pt(START + SWEEP);
  const bgPath = `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 1 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;

  const pct = Math.min(Math.max(displaySpd / maxSpd, 0), 1);
  const sweepDeg = pct * SWEEP;
  let fgPath = '';
  if (pct > 0.005) {
    const pe = pt(START + sweepDeg);
    const largeArc = sweepDeg > 180 ? 1 : 0;
    fgPath = `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${pe.x.toFixed(2)} ${pe.y.toFixed(2)}`;
  }

  // Tick dots at 0 %, 25 %, 50 %, 75 %, 100 % of arc
  const tickFracs = [0, 0.25, 0.5, 0.75, 1];
  const DOT_R = 82; // slightly outside track

  return (
    <View style={styles.speedoWrapper}>
      <Svg width={152} height={152} viewBox="0 0 200 200">
        {/* Background track */}
        <Path d={bgPath} fill="none" stroke={TRACK_COLOR} strokeWidth={SW} strokeLinecap="round" />
        {/* Progress */}
        {fgPath ? (
          <Path d={fgPath} fill="none" stroke={ORANGE} strokeWidth={SW} strokeLinecap="round" />
        ) : null}
        {/* Tick dots */}
        {tickFracs.map((frac) => {
          const deg = START + frac * SWEEP;
          const dp = { x: CX + DOT_R * Math.cos(toRad(deg)), y: CY + DOT_R * Math.sin(toRad(deg)) };
          const active = frac <= pct;
          return (
            <Circle key={frac} cx={dp.x} cy={dp.y} r={2.8}
              fill={active ? ORANGE : '#C8C4BE'} />
          );
        })}
      </Svg>
      {/* Text overlaid on SVG */}
      <View style={[styles.speedoText, { pointerEvents: 'none' as any }]}>
        <Text style={styles.speedoLabel}>SPEED</Text>
        <Text style={styles.speedoValue}>{Math.round(displaySpd)}</Text>
        <Text style={styles.speedoUnit}>{unit}</Text>
      </View>
    </View>
  );
});

// ─── GPS signal bars ──────────────────────────────────────────────────────────
function GpsSignal({ accuracy, locationMode }: { accuracy: number | null; locationMode: string }) {
  let bars = 0;
  let label = 'Searching';
  if (locationMode === 'simulated') { bars = 3; label = 'Simulated'; }
  else if (accuracy !== null) {
    if (accuracy < 10) { bars = 4; label = 'Strong'; }
    else if (accuracy < 25) { bars = 3; label = 'Strong'; }
    else if (accuracy < 50) { bars = 2; label = 'Moderate'; }
    else { bars = 1; label = 'Weak'; }
  }
  const barColor = (i: number) => i <= bars ? '#22c55e' : '#D1CEC9';

  return (
    <View style={styles.gpsCard}>
      <Ionicons name="hardware-chip-outline" size={16} color={TEXT_PRIMARY} />
      <View>
        <Text style={styles.gpsLabel}>GPS</Text>
        <View style={styles.gpsRow}>
          <Text style={styles.gpsStatus}>{label}</Text>
          <View style={styles.gpsBars}>
            {[1, 2, 3, 4].map((i) => (
              <View key={i}
                style={[styles.gpsBar, { height: 4 + i * 3, backgroundColor: barColor(i) }]}
              />
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── Navigation instruction card ─────────────────────────────────────────────
function NavCard({ instruction }: { instruction: NavInstruction }) {
  return (
    <View style={styles.navCard}>
      <Ionicons name={instruction.manoeuvreIcon as any} size={36} color={ORANGE} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Text style={styles.navDistance}>{Math.round(instruction.distanceMetres)} m</Text>
        </View>
        <Text style={styles.navInstruction} numberOfLines={1}>{instruction.instruction}</Text>
        <Text style={styles.navRoad} numberOfLines={1}>{instruction.roadName}</Text>
      </View>
      {/* Orange progress bar */}
      <View style={styles.navProgress}>
        <View style={[styles.navProgressFill, { width: '40%' }]} />
      </View>
    </View>
  );
}

// ─── Main Overlay ─────────────────────────────────────────────────────────────
export default function ActiveDriveOverlay({
  currentDrive,
  driveSeconds,
  isPaused,
  driveMode,
  locationMode,
  gpsAccuracy,
  accuracyWarning,
  followMode,
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
  onZoomIn,
  onZoomOut,
}: Props) {
  const [saveConfirm, setSaveConfirm] = useState(false);

  const handleSavePoint = useCallback(() => {
    onSavePoint();
    setSaveConfirm(true);
    setTimeout(() => setSaveConfirm(false), 1800);
  }, [onSavePoint]);

  const handleEndDrive = useCallback(() => {
    Alert.alert(
      'End Drive?',
      'This will finalise and save your journey.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End Drive',
          style: 'destructive',
          onPress: () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onEndDrive();
          },
        },
      ],
    );
  }, [onEndDrive]);

  const currentSpeedKmh = Math.max(0, currentDrive?.currentSpeed ?? 0);
  const topSpeedKmh     = Math.max(0, currentDrive?.topSpeed ?? 0);
  const avgKmh          = Math.max(0, avgSpeedKmh(currentDrive));
  const distanceKm      = currentDrive?.estimatedDistance ?? 0;
  const unit            = resolvedUnitSystem;

  // Display values (converted to user's unit)
  const displayTopSpeed = Math.round(convertSpeed(topSpeedKmh, unit));
  const displayAvgSpeed = Math.round(convertSpeed(avgKmh, unit));
  const spdUnit         = speedUnit(unit);

  return (
    <View style={[StyleSheet.absoluteFillObject, { pointerEvents: 'box-none' as any }]}>
      {/* ── Transparent map area ── */}
      <View style={[styles.mapArea, { pointerEvents: 'box-none' as any }]}>

        {/* Top status row */}
        <View style={[styles.statusRow, { top: insets.top + (Platform.OS === 'web' ? 67 : 8), pointerEvents: 'box-none' as any }]}>
          {/* Left: Drive in progress */}
          <View style={[styles.statusCard, styles.driveStatusCard]}>
            <View style={styles.driveStatusDot} />
            <View>
              <Text style={styles.driveStatusTitle}>
                {isPaused ? 'Drive paused' : 'Drive in progress'}
              </Text>
              <Text style={styles.driveStatusTimer}>{formatDriveTime(driveSeconds)}</Text>
            </View>
          </View>

          {/* Right: GPS */}
          <GpsSignal accuracy={gpsAccuracy} locationMode={locationMode} />
        </View>

        {/* Navigation card (navigation mode only) */}
        {driveMode === 'navigation' && navInstruction && (
          <View style={[styles.navCardWrap, { top: insets.top + (Platform.OS === 'web' ? 67 : 8) + 60, pointerEvents: 'box-none' as any }]}>
            <NavCard instruction={navInstruction} />
          </View>
        )}

        {/* Accuracy warning */}
        {accuracyWarning && (
          <View style={[styles.accuracyWarn, { top: insets.top + (Platform.OS === 'web' ? 67 : 8) + 68 }]}>
            <Ionicons name="warning-outline" size={12} color="#1C1C1E" />
            <Text style={styles.accuracyWarnText}>Poor GPS signal</Text>
          </View>
        )}

        {/* Left map controls: locate + zoom */}
        <View style={styles.mapControls}>
          <TouchableOpacity style={styles.mapBtn} onPress={onLocateButton} activeOpacity={0.8}>
            <Ionicons name={followMode === 'following' ? 'navigate' : 'navigate-outline'}
              size={20} color={followMode === 'following' ? ORANGE : TEXT_PRIMARY} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.mapBtn} onPress={onZoomIn} activeOpacity={0.8}>
            <Ionicons name="add" size={22} color={TEXT_PRIMARY} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.mapBtn} onPress={onZoomOut} activeOpacity={0.8}>
            <Ionicons name="remove" size={22} color={TEXT_PRIMARY} />
          </TouchableOpacity>
        </View>

        {/* Resume following pill */}
        {followMode === 'free' && (
          <View style={styles.resumePill}>
            <TouchableOpacity
              style={styles.resumePillInner}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onResumeFollowing(); }}
            >
              <Ionicons name="navigate" size={16} color={ORANGE} />
              <Text style={styles.resumePillText}>Resume following</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Passenger mode note */}
        {isPassengerMode && (
          <View style={styles.passengerNote}>
            <Ionicons name="walk-outline" size={12} color="#fff" />
            <Text style={styles.passengerNoteText}>Passenger Mode — not recording</Text>
          </View>
        )}
      </View>

      {/* ── Solid telemetry panel ── */}
      <View style={[styles.panel, { paddingBottom: Math.max(insets.bottom, 8) + 8 }]}>
        {/* Separator */}
        <View style={styles.panelHandle} />

        {/* Stats row: [left stats] [speedometer] [right stats] */}
        <View style={styles.statsRow}>
          {/* Left: distance + avg speed */}
          <View style={styles.statCol}>
            <View style={styles.statItem}>
              <Ionicons name="git-merge-outline" size={14} color={ORANGE} style={{ marginBottom: 2 }} />
              <Text style={styles.statLabel}>DISTANCE</Text>
              <Text style={styles.statValue}>{formatDistance(distanceKm, unit)}</Text>
            </View>
            <View style={[styles.statItem, { marginTop: 12 }]}>
              <Ionicons name="speedometer-outline" size={14} color={TEXT_SECONDARY} style={{ marginBottom: 2 }} />
              <Text style={styles.statLabel}>AVG SPEED</Text>
              <Text style={styles.statValue}>{displayAvgSpeed}</Text>
              <Text style={styles.statUnit}>{spdUnit}</Text>
            </View>
          </View>

          {/* Centre: speedometer */}
          <Speedometer speedKmh={currentSpeedKmh} resolvedUnitSystem={unit} />

          {/* Right: top speed + duration */}
          <View style={styles.statCol}>
            <View style={styles.statItem}>
              <Ionicons name="flash-outline" size={14} color={ORANGE} style={{ marginBottom: 2 }} />
              <Text style={styles.statLabel}>TOP SPEED</Text>
              <Text style={styles.statValue}>{displayTopSpeed}</Text>
              <Text style={styles.statUnit}>{spdUnit}</Text>
            </View>
            <View style={[styles.statItem, { marginTop: 12 }]}>
              <Ionicons name="time-outline" size={14} color={TEXT_SECONDARY} style={{ marginBottom: 2 }} />
              <Text style={styles.statLabel}>DURATION</Text>
              <Text style={[styles.statValue, { fontSize: 16 }]}>{formatDriveTime(driveSeconds)}</Text>
            </View>
          </View>
        </View>

        {/* Controls row */}
        <View style={styles.controlsRow}>
          {/* Pause / Resume */}
          <TouchableOpacity
            style={styles.controlBtn}
            onPress={() => {
              if (isPaused) { onResume(); } else { onPause(); }
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            }}
            activeOpacity={0.7}
          >
            <Ionicons name={isPaused ? 'play' : 'pause'} size={22} color={TEXT_PRIMARY} />
            <Text style={styles.controlBtnText}>{isPaused ? 'RESUME' : 'PAUSE'}</Text>
          </TouchableOpacity>

          {/* End Drive (primary) */}
          <TouchableOpacity
            style={styles.endDriveBtn}
            onPress={handleEndDrive}
            activeOpacity={0.85}
          >
            <View style={styles.endDriveBtnInner}>
              <Ionicons name="stop" size={20} color="#fff" />
              <Text style={styles.endDriveBtnText}>END DRIVE</Text>
            </View>
          </TouchableOpacity>

          {/* Save Point */}
          <TouchableOpacity
            style={styles.controlBtn}
            onPress={handleSavePoint}
            activeOpacity={0.7}
          >
            <Ionicons name={saveConfirm ? 'checkmark' : 'bookmark-outline'} size={22}
              color={saveConfirm ? '#22c55e' : TEXT_PRIMARY} />
            <Text style={[styles.controlBtnText, saveConfirm && { color: '#22c55e' }]}>
              {saveConfirm ? 'SAVED!' : 'SAVE POINT'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  mapArea: {
    flex: 1,
  },
  statusRow: {
    position: 'absolute', left: 12, right: 12,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
  },
  statusCard: {
    backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 8, ...CARD_SHADOW,
  },
  driveStatusCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  driveStatusDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e',
  },
  driveStatusTitle: {
    fontSize: 12, fontWeight: '600', color: TEXT_PRIMARY, fontFamily: 'Inter_600SemiBold',
  },
  driveStatusTimer: {
    fontSize: 13, fontWeight: '700', color: TEXT_PRIMARY, fontFamily: 'Inter_700Bold',
  },
  gpsCard: {
    backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 14,
    paddingHorizontal: 10, paddingVertical: 8,
    flexDirection: 'row', alignItems: 'center', gap: 6, ...CARD_SHADOW,
  },
  gpsLabel: { fontSize: 11, fontWeight: '700', color: TEXT_PRIMARY, fontFamily: 'Inter_700Bold' },
  gpsRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  gpsStatus: { fontSize: 10, color: TEXT_SECONDARY, fontFamily: 'Inter_400Regular' },
  gpsBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  gpsBar: { width: 3, borderRadius: 1.5 },
  navCardWrap: {
    position: 'absolute', left: 12, right: 12, alignItems: 'center',
  },
  navCard: {
    backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 16,
    padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12,
    maxWidth: 340, ...CARD_SHADOW,
  },
  navDistance: {
    fontSize: 28, fontWeight: '700', color: TEXT_PRIMARY, fontFamily: 'Inter_700Bold',
  },
  navInstruction: {
    fontSize: 14, color: TEXT_PRIMARY, fontFamily: 'Inter_400Regular', marginTop: 2,
  },
  navRoad: {
    fontSize: 13, fontWeight: '600', color: ORANGE, fontFamily: 'Inter_600SemiBold',
  },
  navProgress: {
    position: 'absolute', bottom: 0, left: 14, right: 14, height: 3,
    backgroundColor: TRACK_COLOR, borderRadius: 2,
  },
  navProgressFill: {
    height: 3, backgroundColor: ORANGE, borderRadius: 2,
  },
  accuracyWarn: {
    position: 'absolute', left: 12, zIndex: 10,
    backgroundColor: 'rgba(234,179,8,0.9)', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 5,
  },
  accuracyWarnText: { fontSize: 11, color: '#1C1C1E', fontFamily: 'Inter_600SemiBold' },
  mapControls: {
    position: 'absolute', left: 12, bottom: 24, gap: 10,
  },
  mapBtn: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.97)',
    alignItems: 'center', justifyContent: 'center', ...CARD_SHADOW,
  },
  resumePill: {
    position: 'absolute', alignSelf: 'center', left: 0, right: 0,
    alignItems: 'center', bottom: 32,
  },
  resumePillInner: {
    backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 24,
    paddingHorizontal: 18, paddingVertical: 10,
    flexDirection: 'row', alignItems: 'center', gap: 8, ...CARD_SHADOW,
  },
  resumePillText: {
    fontSize: 14, fontWeight: '700', color: TEXT_PRIMARY, fontFamily: 'Inter_700Bold',
  },
  passengerNote: {
    position: 'absolute', alignSelf: 'center', left: 0, right: 0,
    alignItems: 'center', bottom: 80,
    flexDirection: 'row', justifyContent: 'center', gap: 4,
  },
  passengerNoteText: {
    fontSize: 12, color: '#fff', fontFamily: 'Inter_500Medium', textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },

  // ── Panel ──
  panel: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 6, paddingHorizontal: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.10, shadowRadius: 12, elevation: 10,
  },
  panelHandle: {
    width: 36, height: 4, backgroundColor: '#D1CEC9', borderRadius: 2,
    alignSelf: 'center', marginBottom: 12,
  },
  statsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12,
  },
  statCol: {
    flex: 1, gap: 4,
  },
  statItem: {
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 9, fontWeight: '600', color: TEXT_SECONDARY,
    fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, textAlign: 'center',
  },
  statValue: {
    fontSize: 20, fontWeight: '700', color: TEXT_PRIMARY,
    fontFamily: 'Inter_700Bold', textAlign: 'center',
  },
  statUnit: {
    fontSize: 11, color: TEXT_SECONDARY, fontFamily: 'Inter_400Regular', textAlign: 'center',
  },

  // ── Speedometer ──
  speedoWrapper: {
    width: 152, height: 152,
    alignItems: 'center', justifyContent: 'center',
  },
  speedoText: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  speedoLabel: {
    fontSize: 9, color: TEXT_SECONDARY, fontFamily: 'Inter_500Medium',
    letterSpacing: 1.2, marginBottom: 2,
  },
  speedoValue: {
    fontSize: 38, fontWeight: '700', color: TEXT_PRIMARY, fontFamily: 'Inter_700Bold',
    lineHeight: 42,
  },
  speedoUnit: {
    fontSize: 11, color: TEXT_SECONDARY, fontFamily: 'Inter_400Regular', marginTop: 1,
  },

  // ── Controls ──
  controlsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 8,
  },
  controlBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, gap: 4,
  },
  controlBtnText: {
    fontSize: 10, fontWeight: '700', color: TEXT_PRIMARY,
    fontFamily: 'Inter_700Bold', letterSpacing: 0.8,
  },
  endDriveBtn: {
    flex: 2, borderRadius: 28, overflow: 'hidden',
    backgroundColor: ORANGE,
    shadowColor: ORANGE, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35, shadowRadius: 8, elevation: 6,
  },
  endDriveBtnInner: {
    paddingVertical: 14, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8,
  },
  endDriveBtnText: {
    fontSize: 15, fontWeight: '700', color: '#fff',
    fontFamily: 'Inter_700Bold', letterSpacing: 0.5,
  },
});

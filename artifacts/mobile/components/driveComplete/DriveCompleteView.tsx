// The Drive Complete screen's layout (app/drive-summary.tsx holds the logic):
// scenic hero, the route, four stats, who can see the drive, and the actions.

import React from 'react';
import {
  ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Coordinate } from '@/context/AppContext';
import type { Visibility } from '@/lib/backend/endpoints';
import { formatDistance, formatSpeed, type ResolvedUnitSystem } from '@/lib/units';
import { GlassButton, GlassSurface } from '@/components/Glass';
import { Glyph } from '@/components/Glyph';
import RouteMapCard from './RouteMapCard';
import VisibilityPicker from './VisibilityPicker';

// The Derwent sunset artwork, framed on the valley and lake below its logo
const HERO = require('@/assets/images/loading-screen.png');

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function DriveCompleteView({
  firstName, isSaving, busy, hasJourney, distanceKm, durationS, avgSpeedKmh, topSpeedKmh, route, unitSystem,
  visibility, onVisibility, visibilityLocked, onSave, onDiscard, onClose, syncBanner,
}: {
  firstName: string | undefined;
  isSaving: boolean;
  /** Saving, or leaving after a choice: the actions are disabled. */
  busy: boolean;
  hasJourney: boolean;
  distanceKm: number;
  durationS: number;
  avgSpeedKmh: number;
  topSpeedKmh: number;
  route: Coordinate[];
  unitSystem: ResolvedUnitSystem;
  visibility: Visibility;
  onVisibility: (v: Visibility) => void;
  visibilityLocked: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
  syncBanner?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const heroHeight = insets.top + Math.min(250, Math.round(height * 0.27));
  const footerHeight = 56 + Math.max(insets.bottom, 16) + 20;

  const stats = [
    { label: 'Distance', value: formatDistance(distanceKm, unitSystem), sf: 'point.topleft.down.to.point.bottomright.curvepath', ion: 'git-commit-outline' },
    { label: 'Duration', value: formatDuration(durationS), sf: 'clock', ion: 'time-outline' },
    { label: 'Avg. Speed', value: formatSpeed(avgSpeedKmh, unitSystem), sf: 'gauge.with.dots.needle.33percent', ion: 'speedometer-outline' },
    { label: 'Max Speed', value: formatSpeed(topSpeedKmh, unitSystem), sf: 'gauge.with.dots.needle.100percent', ion: 'flash-outline' },
  ] as const;

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: footerHeight + 16 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={{ height: heroHeight }}>
          <Image
            source={HERO}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            contentPosition={{ top: '66%', left: '50%' }}
            accessible={false}
          />
          <LinearGradient
            colors={['rgba(7,9,12,0.15)', 'rgba(7,9,12,0.35)', '#07090C']}
            locations={[0, 0.55, 1]}
            style={StyleSheet.absoluteFill}
          />
          <View style={[styles.heroContent, { paddingTop: insets.top + 24 }]}>
            <GlassSurface style={styles.flag}>
              <Glyph sf="flag.checkered" ion="flag-outline" size={30} color="#FFFFFF" />
            </GlassSurface>
            <Text style={styles.title} accessibilityRole="header">Drive Complete</Text>
            <Text style={styles.subtitle}>
              {isSaving ? 'Saving your drive…' : firstName ? `Great drive, ${firstName}.` : 'Great drive.'}
            </Text>
          </View>
        </View>

        <View style={styles.body}>
          <RouteMapCard coordinates={route} />

          {/* The four stats */}
          <GlassSurface style={styles.stats}>
            {stats.map((s, i) => (
              <View
                key={s.label}
                accessible
                accessibilityLabel={`${s.label}: ${s.value}`}
                style={[styles.stat, i > 0 && styles.statDivider]}
              >
                <Glyph sf={s.sf} ion={s.ion} size={22} color="#FFFFFF" />
                <Text style={styles.statLabel} numberOfLines={1}>{s.label}</Text>
                <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                  {s.value}
                </Text>
              </View>
            ))}
          </GlassSurface>

          {hasJourney || isSaving ? (
            <VisibilityPicker value={visibility} onChange={onVisibility} disabled={visibilityLocked} />
          ) : (
            <GlassSurface style={styles.notice}>
              <Text style={styles.noticeText}>
                This drive is still being saved. It will appear in your Drives when it finishes.
              </Text>
            </GlassSurface>
          )}
        </View>
      </ScrollView>

      {/* Close */}
      <GlassButton
        accessibilityLabel="Close"
        accessibilityHint="Keeps the drive saved as it is"
        onPress={onClose}
        style={[styles.close, { top: insets.top + 8 }]}
      >
        <Glyph sf="xmark" ion="close" size={20} color="#FFFFFF" />
      </GlassButton>

      {/* Actions, always within reach */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]} pointerEvents="box-none">
        <LinearGradient
          colors={['rgba(7,9,12,0)', 'rgba(7,9,12,0.92)', '#07090C']}
          locations={[0, 0.35, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <GlassButton
          accessibilityLabel="Discard"
          accessibilityHint="Asks you to confirm, then deletes this drive"
          accessibilityState={{ disabled: busy || !hasJourney }}
          disabled={busy || !hasJourney}
          onPress={onDiscard}
          style={[styles.button, styles.discard, (busy || !hasJourney) && styles.dimmed]}
        >
          <Text style={styles.discardText}>Discard</Text>
        </GlassButton>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Save Drive"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          activeOpacity={0.85}
          onPress={onSave}
          style={[styles.button, styles.save, busy && styles.dimmed]}
        >
          <LinearGradient
            colors={['#6FE6FF', '#2CC9F2', '#12B2E8']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {busy ? <ActivityIndicator color="#04121B" /> : <Text style={styles.saveText}>Save Drive</Text>}
        </TouchableOpacity>
      </View>

      {syncBanner}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#07090C' },
  heroContent: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 18, paddingHorizontal: 24 },
  flag: { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: {
    color: '#FFFFFF', fontSize: 34, fontWeight: '700', letterSpacing: -0.5,
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 12,
  },
  subtitle: {
    color: 'rgba(236,240,244,0.85)', fontSize: 17, marginTop: 6,
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 8,
  },
  body: { paddingHorizontal: 16, gap: 14, marginTop: 6 },
  stats: { flexDirection: 'row', borderRadius: 24, paddingVertical: 18 },
  stat: { flex: 1, alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  statDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: 'rgba(220,232,244,0.18)' },
  statLabel: { color: 'rgba(214,224,234,0.72)', fontSize: 13, marginTop: 4 },
  statValue: { color: '#FFFFFF', fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  notice: { borderRadius: 22, padding: 18 },
  noticeText: { color: 'rgba(214,224,234,0.8)', fontSize: 15, lineHeight: 21 },
  close: {
    position: 'absolute', left: 16, width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center',
  },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 12,
    paddingHorizontal: 16, paddingTop: 20,
  },
  button: { flex: 1, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  discard: {},
  discardText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  save: {},
  saveText: { color: '#04121B', fontSize: 17, fontWeight: '700' },
  dimmed: { opacity: 0.5 },
});

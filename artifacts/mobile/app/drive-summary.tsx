import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Platform,
  ScrollView, KeyboardAvoidingView, Keyboard,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { SyncBanner } from '@/components/SyncBanner';
import * as Haptics from 'expo-haptics';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Returns the keyboard height on the web by measuring the gap between
 * window.innerHeight and window.visualViewport.height.
 */
function useWebKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof window === 'undefined') return;

    const vv = (window as Window & { visualViewport?: VisualViewport }).visualViewport;
    if (!vv) return;

    function measure() {
      const kh = Math.max(0, window.innerHeight - vv!.height - vv!.offsetTop);
      setHeight(kh);
    }

    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    measure();

    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
    };
  }, []);

  return height;
}

export default function DriveSummaryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currentDrive, endDrive, updateJourney, syncStatus, retryJourneySync } = useApp();
  const [journeyName, setJourneyName] = useState('');
  const [savedJourneyId, setSavedJourneyId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const endedRef = useRef(false);

  // Snapshot the drive stats immediately on mount (before endDrive clears them)
  const driveSnapshot = useRef({
    distance:   currentDrive?.estimatedDistance ?? 0,
    topSpeed:   currentDrive?.topSpeed          ?? 0,
    avgSpeed:   currentDrive?.speedSamples && currentDrive.speedSamples.length > 0
      ? Math.round(currentDrive.speedSamples.reduce((a, b) => a + b, 0) / currentDrive.speedSamples.length)
      : 0,
    startTime:  currentDrive?.startTime ?? Date.now(),
  }).current;

  const scrollRef      = useRef<ScrollView>(null);
  const inputRef       = useRef<TextInput>(null);
  const nameSectionRef = useRef<View>(null);
  const webKeyboardHeight = useWebKeyboardHeight();
  const webKeyboardOpen   = webKeyboardHeight > 50;

  // End the drive once on mount; show sync banner if it fails
  useEffect(() => {
    if (!endedRef.current && currentDrive) {
      endedRef.current = true;
      setIsSaving(true);
      (async () => {
        try {
          const j = await endDrive();
          if (j) {
            setSavedJourneyId(j.id);
            setJourneyName(j.name);
          }
        } finally {
          setIsSaving(false);
        }
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll input into view on web when keyboard opens
  useEffect(() => {
    if (Platform.OS !== 'web' || !webKeyboardOpen) return;
    const timer = setTimeout(() => {
      const el = inputRef.current as unknown as HTMLElement | null;
      if (el?.scrollIntoView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [webKeyboardOpen]);

  // Scroll to input on native when keyboard appears
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      nameSectionRef.current?.measureLayout(
        scrollRef.current?.getScrollableNode() as Parameters<View['measureLayout']>[0],
        (_x: number, y: number) => {
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 24), animated: true });
        },
        () => {
          scrollRef.current?.scrollToEnd({ animated: true });
        },
      );
    });
    return () => sub.remove();
  }, []);

  const driveDuration = Math.round((Date.now() - driveSnapshot.startTime) / 1000);

  const scrollBottomPadding =
    Platform.OS === 'web'
      ? Math.max(insets.bottom + 24, webKeyboardHeight + 24)
      : insets.bottom + 24;

  const heroTopPadding = Platform.OS === 'web' ? 67 + insets.top : insets.top + 20;

  const styles = StyleSheet.create({
    kaView:        { flex: 1, backgroundColor: colors.background },
    heroGradient:  { paddingTop: heroTopPadding, paddingHorizontal: 24, paddingBottom: 32, alignItems: 'center' },
    completedIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
    heroTitle:     { fontSize: 28, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold' },
    heroSub:       { fontSize: 15, color: 'rgba(255,255,255,0.75)', fontFamily: 'Inter_400Regular', marginTop: 6 },
    statsGrid:     { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 },
    statCard:      { flex: 1, minWidth: '45%', backgroundColor: colors.card, borderRadius: 16, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center' },
    statValue:     { fontSize: 24, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginTop: 8 },
    statLabel:     { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 4 },
    statHighlight: { color: colors.primary },
    nameSection:   { marginBottom: 24 },
    nameLabel:     { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', marginBottom: 10 },
    nameInput:     { backgroundColor: colors.card, borderRadius: 14, padding: 14, fontSize: 16, color: colors.foreground, fontFamily: 'Inter_400Regular', borderWidth: 2, borderColor: colors.primary },
    actionRow:     { gap: 10 },
    viewJourneyBtn: { backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 15, alignItems: 'center', opacity: isSaving ? 0.6 : 1 },
    viewJourneyBtnText: { fontSize: 16, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    backToMapBtn:  { borderRadius: 14, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
    backToMapBtnText: { fontSize: 16, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
  });

  function handleSaveAndView() {
    if (savedJourneyId && journeyName.trim()) {
      updateJourney(savedJourneyId, { name: journeyName.trim() });
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace('/(tabs)/journeys');
  }

  function handleBackToMap() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.replace('/(tabs)');
  }

  return (
    <KeyboardAvoidingView
      style={styles.kaView}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <LinearGradient colors={['#F4631A', '#FF4E3A']} style={styles.heroGradient}>
        <View style={styles.completedIcon}>
          <Ionicons name="checkmark" size={36} color="#fff" />
        </View>
        <Text style={styles.heroTitle}>Drive Complete</Text>
        <Text style={styles.heroSub}>
          {isSaving ? 'Saving…' : 'Great drive! Here\'s your summary.'}
        </Text>
      </LinearGradient>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: 24, paddingBottom: scrollBottomPadding }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Ionicons name="navigate-outline" size={24} color={colors.primary} />
            <Text style={styles.statValue}>{driveSnapshot.distance.toFixed(1)} km</Text>
            <Text style={styles.statLabel}>Distance</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="time-outline" size={24} color={colors.primary} />
            <Text style={styles.statValue}>{formatDuration(driveDuration)}</Text>
            <Text style={styles.statLabel}>Duration</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="speedometer-outline" size={24} color={colors.primary} />
            <Text style={[styles.statValue, styles.statHighlight]}>
              {Math.round(driveSnapshot.topSpeed)} km/h
            </Text>
            <Text style={styles.statLabel}>Top Speed</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="car-outline" size={24} color={colors.primary} />
            <Text style={styles.statValue}>{driveSnapshot.avgSpeed} km/h</Text>
            <Text style={styles.statLabel}>Avg Speed</Text>
          </View>
        </View>

        <View ref={nameSectionRef} style={styles.nameSection}>
          <Text style={styles.nameLabel}>Name this journey</Text>
          <TextInput
            ref={inputRef}
            style={styles.nameInput}
            value={journeyName}
            onChangeText={setJourneyName}
            placeholder="e.g. Lake District Loop"
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
            blurOnSubmit
          />
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.viewJourneyBtn}
            onPress={handleSaveAndView}
            disabled={isSaving}
            activeOpacity={0.8}
          >
            <Text style={styles.viewJourneyBtnText}>
              {isSaving ? 'Saving…' : 'Save & View Journey'}
            </Text>
          </TouchableOpacity>
          <View style={{ height: 10 }} />
          <TouchableOpacity style={styles.backToMapBtn} onPress={handleBackToMap}>
            <Text style={styles.backToMapBtnText}>Back to Map</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Sync banner — visible when the server save failed */}
      <SyncBanner
        visible={syncStatus !== 'idle'}
        status={syncStatus === 'syncing' ? 'syncing' : syncStatus === 'error' ? 'error' : 'waiting'}
        onRetry={retryJourneySync}
      />
    </KeyboardAvoidingView>
  );
}

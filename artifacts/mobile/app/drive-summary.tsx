import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Platform, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function DriveSummaryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currentDrive, endDrive, updateJourney } = useApp();
  const [journeyName, setJourneyName] = useState('');
  const [savedJourneyId, setSavedJourneyId] = useState<string | null>(null);
  const endedRef = useRef(false);

  // End the drive and capture the journey
  useEffect(() => {
    if (!endedRef.current && currentDrive) {
      endedRef.current = true;
      const j = endDrive();
      if (j) {
        setSavedJourneyId(j.id);
        setJourneyName(j.name);
      }
    }
  }, []);

  const driveDuration = currentDrive?.startTime
    ? Math.round((Date.now() - currentDrive.startTime) / 1000)
    : 0;

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    heroGradient: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top + 20,
      paddingHorizontal: 24, paddingBottom: 32, alignItems: 'center',
    },
    completedIcon: {
      width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(255,255,255,0.2)',
      alignItems: 'center', justifyContent: 'center', marginBottom: 16,
    },
    heroTitle: { fontSize: 28, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold' },
    heroSub: { fontSize: 15, color: 'rgba(255,255,255,0.75)', fontFamily: 'Inter_400Regular', marginTop: 6 },
    content: { padding: 24 },
    statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 },
    statCard: {
      flex: 1, minWidth: '45%', backgroundColor: colors.card, borderRadius: 16, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center',
    },
    statValue: { fontSize: 24, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginTop: 8 },
    statLabel: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 4 },
    statHighlight: { color: colors.primary },
    nameSection: { marginBottom: 24 },
    nameLabel: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', marginBottom: 10 },
    nameInput: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14,
      fontSize: 16, color: colors.foreground, fontFamily: 'Inter_400Regular',
      borderWidth: 2, borderColor: colors.primary,
    },
    actionRow: { gap: 10 },
    viewJourneyBtn: {
      backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 15, alignItems: 'center',
    },
    viewJourneyBtnText: { fontSize: 16, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    backToMapBtn: {
      borderRadius: 14, paddingVertical: 15, alignItems: 'center',
      borderWidth: 1, borderColor: colors.border,
    },
    backToMapBtnText: { fontSize: 16, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    demoNote: {
      backgroundColor: colors.muted, borderRadius: 10, padding: 10, marginTop: 16,
    },
    demoNoteText: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', textAlign: 'center' },
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
    <View style={styles.container}>
      <LinearGradient colors={['#F4631A', '#FF4E3A']} style={styles.heroGradient}>
        <View style={styles.completedIcon}>
          <Ionicons name="checkmark" size={36} color="#fff" />
        </View>
        <Text style={styles.heroTitle}>Drive Complete</Text>
        <Text style={styles.heroSub}>Great drive! Here's your summary.</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Ionicons name="navigate-outline" size={24} color={colors.primary} />
            <Text style={styles.statValue}>
              {currentDrive ? currentDrive.estimatedDistance.toFixed(1) : '0.0'} km
            </Text>
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
              {currentDrive ? Math.round(currentDrive.topSpeed) : 0} km/h
            </Text>
            <Text style={styles.statLabel}>Top Speed</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="car-outline" size={24} color={colors.primary} />
            <Text style={styles.statValue}>
              {currentDrive && currentDrive.speedSamples.length > 0
                ? Math.round(currentDrive.speedSamples.reduce((a, b) => a + b, 0) / currentDrive.speedSamples.length)
                : 0} km/h
            </Text>
            <Text style={styles.statLabel}>Avg Speed</Text>
          </View>
        </View>

        <View style={styles.nameSection}>
          <Text style={styles.nameLabel}>Name this journey</Text>
          <TextInput
            style={styles.nameInput}
            value={journeyName}
            onChangeText={setJourneyName}
            placeholder="e.g. Lake District Loop"
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="done"
          />
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.viewJourneyBtn} onPress={handleSaveAndView}>
            <Text style={styles.viewJourneyBtnText}>Save & View Journey</Text>
          </TouchableOpacity>
          <View style={{ height: 10 }} />
          <TouchableOpacity style={styles.backToMapBtn} onPress={handleBackToMap}>
            <Text style={styles.backToMapBtnText}>Back to Map</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.demoNote}>
          <Text style={styles.demoNoteText}>
            Demo mode: distance &amp; speed tracked where browser location was granted.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform, Alert,
  TextInput,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

export default function JourneyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { journeys, vehicles, deleteJourney, updateJourney } = useApp();

  const journey = journeys.find((j) => j.id === id);
  const vehicle = journey ? vehicles.find((v) => v.id === journey.vehicleId) : null;
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(journey?.name ?? '');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(journey?.notes ?? '');

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top,
      paddingHorizontal: 16, paddingBottom: 12,
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    backBtn: { padding: 4 },
    headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    deleteBtn: { padding: 4 },
    scroll: { flex: 1 },
    content: { padding: 20, paddingBottom: 40 },
    mapPlaceholder: {
      height: 180, backgroundColor: colors.muted, borderRadius: 16,
      alignItems: 'center', justifyContent: 'center', marginBottom: 20,
      overflow: 'hidden',
    },
    mapPlaceholderText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 8 },
    sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', marginBottom: 12 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
    journeyName: { fontSize: 22, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', flex: 1 },
    nameInput: {
      flex: 1, fontSize: 22, fontWeight: '700', color: colors.foreground,
      fontFamily: 'Inter_700Bold', borderBottomWidth: 2, borderBottomColor: colors.primary,
    },
    editBtn: { padding: 4 },
    dateText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginBottom: 16 },
    statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
    statCard: {
      flex: 1, minWidth: '45%', backgroundColor: colors.card, borderRadius: 14, padding: 14,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    statValue: { fontSize: 20, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    statLabel: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    statHighlight: { color: colors.primary },
    vehicleCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14, flexDirection: 'row',
      alignItems: 'center', gap: 12, marginBottom: 20,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    vehicleName: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    vehicleSub: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    notesCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginBottom: 20,
    },
    notesHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    notesText: { fontSize: 14, color: colors.foreground, fontFamily: 'Inter_400Regular', lineHeight: 21 },
    notesInput: {
      fontSize: 14, color: colors.foreground, fontFamily: 'Inter_400Regular', lineHeight: 21,
      borderBottomWidth: 1, borderBottomColor: colors.primary, paddingBottom: 4,
    },
    notesPlaceholder: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    photosPlaceholder: {
      backgroundColor: colors.muted, borderRadius: 14, height: 100,
      alignItems: 'center', justifyContent: 'center', gap: 6,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderStyle: 'dashed',
    },
    photosText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
  });

  if (!journey) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: colors.foreground }}>Journey not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.primary }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function handleDelete() {
    Alert.alert('Delete Journey', `Delete "${journey!.name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: () => {
          deleteJourney(journey!.id);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.back();
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Journey Detail</Text>
        <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
          <Ionicons name="trash-outline" size={20} color={colors.destructive} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Map preview placeholder */}
        <View style={styles.mapPlaceholder}>
          <Ionicons name="map-outline" size={40} color={colors.mutedForeground} />
          <Text style={styles.mapPlaceholderText}>Route map — connect map API to display</Text>
        </View>

        {/* Journey name */}
        <View style={styles.nameRow}>
          {editingName ? (
            <TextInput
              style={styles.nameInput}
              value={nameValue}
              onChangeText={setNameValue}
              autoFocus
              onBlur={() => {
                updateJourney(journey.id, { name: nameValue || 'Unnamed Journey' });
                setEditingName(false);
              }}
              returnKeyType="done"
              onSubmitEditing={() => {
                updateJourney(journey.id, { name: nameValue || 'Unnamed Journey' });
                setEditingName(false);
              }}
            />
          ) : (
            <Text style={styles.journeyName}>{journey.name}</Text>
          )}
          <TouchableOpacity style={styles.editBtn} onPress={() => { setEditingName(true); setNameValue(journey.name); }}>
            <Ionicons name="pencil-outline" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
        <Text style={styles.dateText}>{formatDate(journey.date)} · {journey.startTime}–{journey.endTime}</Text>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{journey.distance} km</Text>
            <Text style={styles.statLabel}>Distance</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatDuration(journey.duration)}</Text>
            <Text style={styles.statLabel}>Duration</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{journey.averageSpeed} km/h</Text>
            <Text style={styles.statLabel}>Avg Speed</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, styles.statHighlight]}>{journey.topSpeed} km/h</Text>
            <Text style={styles.statLabel}>Top Speed</Text>
          </View>
        </View>

        {/* Vehicle */}
        {vehicle && (
          <View style={styles.vehicleCard}>
            <Ionicons name="car" size={28} color={colors.primary} />
            <View>
              <Text style={styles.vehicleName}>{vehicle.nickname}</Text>
              <Text style={styles.vehicleSub}>{vehicle.year} {vehicle.make} {vehicle.model}</Text>
            </View>
          </View>
        )}

        {/* Notes */}
        <View style={styles.notesCard}>
          <View style={styles.notesHeader}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <TouchableOpacity onPress={() => { setEditingNotes(true); setNotesValue(journey.notes); }}>
              <Ionicons name="pencil-outline" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          {editingNotes ? (
            <TextInput
              style={styles.notesInput}
              value={notesValue}
              onChangeText={setNotesValue}
              multiline
              autoFocus
              onBlur={() => {
                updateJourney(journey.id, { notes: notesValue });
                setEditingNotes(false);
              }}
            />
          ) : journey.notes ? (
            <Text style={styles.notesText}>{journey.notes}</Text>
          ) : (
            <TouchableOpacity onPress={() => setEditingNotes(true)}>
              <Text style={styles.notesPlaceholder}>Tap to add notes...</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Photos placeholder */}
        <Text style={[styles.sectionTitle, { marginBottom: 10 }]}>Photos</Text>
        <TouchableOpacity style={styles.photosPlaceholder}>
          <Ionicons name="camera-outline" size={28} color={colors.mutedForeground} />
          <Text style={styles.photosText}>Photos — coming soon</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

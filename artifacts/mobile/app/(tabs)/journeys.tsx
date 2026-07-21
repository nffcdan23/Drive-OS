import React, { useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function JourneysScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { journeys, vehicles } = useApp();
  const [sortBy, setSortBy] = useState<'date' | 'distance'>('date');

  const sorted = [...journeys].sort((a, b) => {
    if (sortBy === 'date') return new Date(b.date).getTime() - new Date(a.date).getTime();
    return b.distance - a.distance;
  });

  const totalKm = journeys.reduce((s, j) => s + j.distance, 0);
  const topSpeed = journeys.reduce((m, j) => Math.max(m, j.topSpeed), 0);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top + 16,
      paddingHorizontal: 20,
      paddingBottom: 16,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerTitle: { fontSize: 28, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    statsRow: { flexDirection: 'row', gap: 12, marginTop: 16, marginHorizontal: 20 },
    statCard: {
      flex: 1, backgroundColor: colors.card, borderRadius: 14, padding: 14,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    statValue: { fontSize: 22, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    statLabel: { fontSize: 12, color: colors.mutedForeground, marginTop: 2, fontFamily: 'Inter_400Regular' },
    sortRow: {
      flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingVertical: 12,
      alignItems: 'center',
    },
    sortLabel: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginRight: 4 },
    sortBtn: {
      paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
      borderWidth: 1, borderColor: colors.border,
    },
    sortBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary + '15' },
    sortBtnText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    sortBtnTextActive: { color: colors.primary },
    journeyCard: {
      marginHorizontal: 20, marginBottom: 10, backgroundColor: colors.card,
      borderRadius: 16, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    journeyName: { fontSize: 16, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', flex: 1 },
    journeyDate: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    chevron: { marginLeft: 8 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 12 },
    statsGrid: { flexDirection: 'row', justifyContent: 'space-between' },
    statItem: { alignItems: 'center' },
    statItemValue: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    statItemLabel: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 1 },
    vehicleTag: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      marginTop: 8, backgroundColor: colors.muted, borderRadius: 6,
      paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start',
    },
    vehicleTagText: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 100 },
    emptyIcon: { marginBottom: 12 },
    emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    emptyText: { fontSize: 14, color: colors.mutedForeground, marginTop: 6, textAlign: 'center', fontFamily: 'Inter_400Regular' },
    listContent: { paddingBottom: (Platform.OS === 'web' ? 84 : insets.bottom + 50) + 16 },
  });

  function JourneyCard({ item }: { item: (typeof journeys)[0] }) {
    const vehicle = vehicles.find((v) => v.id === item.vehicleId);
    return (
      <TouchableOpacity style={styles.journeyCard} onPress={() => router.push(`/journey/${item.id}`)}>
        <View style={styles.cardTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.journeyName}>{item.name}</Text>
            <Text style={styles.journeyDate}>{formatDate(item.date)} · {item.startTime}–{item.endTime}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.mutedForeground} style={styles.chevron} />
        </View>
        <View style={styles.divider} />
        <View style={styles.statsGrid}>
          <View style={styles.statItem}>
            <Text style={styles.statItemValue}>{item.distance} km</Text>
            <Text style={styles.statItemLabel}>Distance</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statItemValue}>{formatDuration(item.duration)}</Text>
            <Text style={styles.statItemLabel}>Duration</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statItemValue}>{item.averageSpeed} km/h</Text>
            <Text style={styles.statItemLabel}>Avg Speed</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statItemValue, { color: colors.primary }]}>{item.topSpeed} km/h</Text>
            <Text style={styles.statItemLabel}>Top Speed</Text>
          </View>
        </View>
        {vehicle && (
          <View style={styles.vehicleTag}>
            <Ionicons name="car-outline" size={11} color={colors.mutedForeground} />
            <Text style={styles.vehicleTagText}>{vehicle.nickname}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Journeys</Text>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{journeys.length}</Text>
          <Text style={styles.statLabel}>Total Drives</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{totalKm.toFixed(0)} km</Text>
          <Text style={styles.statLabel}>Total Distance</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: colors.primary }]}>{topSpeed}</Text>
          <Text style={styles.statLabel}>Top Speed km/h</Text>
        </View>
      </View>

      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>Sort:</Text>
        <TouchableOpacity
          style={[styles.sortBtn, sortBy === 'date' && styles.sortBtnActive]}
          onPress={() => setSortBy('date')}
        >
          <Text style={[styles.sortBtnText, sortBy === 'date' && styles.sortBtnTextActive]}>Recent</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.sortBtn, sortBy === 'distance' && styles.sortBtnActive]}
          onPress={() => setSortBy('distance')}
        >
          <Text style={[styles.sortBtnText, sortBy === 'distance' && styles.sortBtnTextActive]}>Distance</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => <JourneyCard item={item} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="navigate-outline" size={48} color={colors.mutedForeground} style={styles.emptyIcon} />
            <Text style={styles.emptyTitle}>No journeys yet</Text>
            <Text style={styles.emptyText}>Head to the map and start a drive{'\n'}to record your first journey.</Text>
          </View>
        }
      />
    </View>
  );
}

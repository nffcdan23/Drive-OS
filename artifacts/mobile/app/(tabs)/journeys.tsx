import React, { useState, useMemo } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Platform, ScrollView, Modal, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp, Journey, JourneyCategory } from '@/context/AppContext';
import { formatDistance, formatSpeed } from '@/lib/units';
import * as Haptics from 'expo-haptics';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

type TimePeriod = 'all' | 'year' | 'month' | 'week';
type SortKey = 'date_desc' | 'date_asc' | 'distance' | 'duration' | 'top_speed' | 'xp';
type FilterType = 'all' | 'personal' | 'convoy';

const PERIOD_LABELS: Record<TimePeriod, string> = {
  all: 'All Time', year: 'This Year', month: 'This Month', week: 'This Week',
};

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'date_desc', label: 'Recent' },
  { key: 'date_asc', label: 'Oldest' },
  { key: 'distance', label: 'Distance' },
  { key: 'duration', label: 'Duration' },
  { key: 'top_speed', label: 'Top Speed' },
  { key: 'xp', label: 'XP Earned' },
];

const CATEGORY_ICONS: Record<string, string> = {
  'cat-1': 'briefcase-outline', 'cat-2': 'leaf-outline',
  'cat-3': 'map-outline', 'cat-4': 'people-outline',
  'cat-5': 'camera-outline', 'cat-6': 'flag-outline', 'cat-7': 'sunny-outline',
};

function filterByPeriod(journeys: Journey[], period: TimePeriod): Journey[] {
  if (period === 'all') return journeys;
  const now = new Date();
  return journeys.filter((j) => {
    const d = new Date(j.date);
    if (period === 'week') {
      const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
      return d >= weekAgo;
    }
    if (period === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (period === 'year') return d.getFullYear() === now.getFullYear();
    return true;
  });
}

export default function JourneysScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { journeys, vehicles, categories, addCategory, updateCategory, deleteCategory, resolvedUnitSystem } = useApp();

  const [period, setPeriod] = useState<TimePeriod>('all');
  const [sortBy, setSortBy] = useState<SortKey>('date_desc');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [filterCategoryId, setFilterCategoryId] = useState<string | null>(null);
  const [showSort, setShowSort] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [newCatName, setNewCatName] = useState('');

  // ── Filtered + sorted journeys ──
  const filtered = useMemo(() => {
    let list = filterByPeriod(journeys, period);
    if (filterType === 'personal') list = list.filter((j) => j.journeyType !== 'convoy');
    if (filterType === 'convoy') list = list.filter((j) => j.journeyType === 'convoy');
    if (filterCategoryId) list = list.filter((j) => j.categoryId === filterCategoryId);
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case 'date_asc': return new Date(a.date).getTime() - new Date(b.date).getTime();
        case 'distance': return b.distance - a.distance;
        case 'duration': return b.duration - a.duration;
        case 'top_speed': return b.topSpeed - a.topSpeed;
        case 'xp': return (b.xpEarned ?? 0) - (a.xpEarned ?? 0);
        default: return new Date(b.date).getTime() - new Date(a.date).getTime();
      }
    });
  }, [journeys, period, sortBy, filterType, filterCategoryId]);

  // ── Statistics ──
  const stats = useMemo(() => {
    const list = filterByPeriod(journeys, period);
    const total = list.length;
    const totalKm = list.reduce((s, j) => s + j.distance, 0);
    const totalSec = list.reduce((s, j) => s + j.duration, 0);
    const topSpeed = list.reduce((m, j) => Math.max(m, j.topSpeed), 0);
    const avgSpeed = list.length > 0
      ? Math.round(list.reduce((s, j) => s + j.averageSpeed, 0) / list.length) : 0;
    const longest = list.reduce((m, j) => j.distance > m ? j.distance : m, 0);
    const personalCount = list.filter((j) => j.journeyType !== 'convoy').length;
    const convoyCount = list.filter((j) => j.journeyType === 'convoy').length;
    const totalXP = list.reduce((s, j) => s + (j.xpEarned ?? 0), 0);

    // Most-driven vehicle
    const vehicleCounts: Record<string, number> = {};
    list.forEach((j) => { vehicleCounts[j.vehicleId] = (vehicleCounts[j.vehicleId] ?? 0) + 1; });
    const topVehicleId = Object.entries(vehicleCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const topVehicle = topVehicleId ? vehicles.find((v) => v.id === topVehicleId) : null;

    return { total, totalKm, totalSec, topSpeed, avgSpeed, longest, personalCount, convoyCount, totalXP, topVehicle };
  }, [journeys, period, vehicles]);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top + 16,
      paddingHorizontal: 20, paddingBottom: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
      flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    },
    headerTitle: { fontSize: 28, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    headerActions: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingBottom: 2 },
    iconBtn: {
      width: 34, height: 34, borderRadius: 17, backgroundColor: colors.muted,
      alignItems: 'center', justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    // Period tabs
    periodRow: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 12, gap: 8 },
    periodBtn: {
      paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
      borderWidth: 1, borderColor: colors.border,
    },
    periodBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    periodBtnText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    periodBtnTextActive: { color: '#fff' },
    // Stats section
    statsSectionTitle: {
      fontSize: 12, fontWeight: '600', color: colors.mutedForeground, textTransform: 'uppercase',
      letterSpacing: 0.6, fontFamily: 'Inter_600SemiBold', paddingHorizontal: 20, marginBottom: 10,
    },
    statsGrid: { paddingHorizontal: 20, gap: 10, marginBottom: 16 },
    primaryStats: { flexDirection: 'row', gap: 10 },
    primaryCard: {
      flex: 1, backgroundColor: colors.card, borderRadius: 16, padding: 14,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    primaryValue: { fontSize: 22, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    primaryLabel: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    secondaryStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    secondaryCard: {
      backgroundColor: colors.card, borderRadius: 12, padding: 12,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
      minWidth: '30%', flex: 1,
    },
    secondaryValue: { fontSize: 16, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    secondaryLabel: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    xpCard: {
      flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.primary + '15',
      borderRadius: 14, padding: 14, marginHorizontal: 20, marginBottom: 12,
      borderWidth: 1, borderColor: colors.primary + '30',
    },
    xpValue: { fontSize: 18, fontWeight: '700', color: colors.primary, fontFamily: 'Inter_700Bold' },
    xpLabel: { fontSize: 12, color: colors.primary, fontFamily: 'Inter_400Regular' },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 20, marginVertical: 8 },
    // Filter row
    filterRow: { flexDirection: 'row', paddingHorizontal: 20, paddingBottom: 10, gap: 8, flexWrap: 'wrap' },
    filterBtn: {
      paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
      borderWidth: 1, borderColor: colors.border,
    },
    filterBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary + '15' },
    filterBtnText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    filterBtnTextActive: { color: colors.primary },
    // Sort row
    sortRow: {
      flexDirection: 'row', paddingHorizontal: 20, paddingBottom: 12,
      alignItems: 'center', justifyContent: 'space-between',
    },
    sortLabel: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    sortBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10,
      borderWidth: 1, borderColor: colors.border,
    },
    sortBtnText: { fontSize: 13, color: colors.foreground, fontFamily: 'Inter_500Medium' },
    // Journey card
    journeyCard: {
      marginHorizontal: 20, marginBottom: 10, backgroundColor: colors.card,
      borderRadius: 16, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    journeyName: { fontSize: 16, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', flex: 1 },
    journeyDate: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    cardMeta: { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
    tag: {
      flexDirection: 'row', alignItems: 'center', gap: 3,
      paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.muted,
    },
    tagText: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    convoyTag: { backgroundColor: colors.primary + '15' },
    convoyTagText: { color: colors.primary },
    cardDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 10 },
    statsGrid2: { flexDirection: 'row', justifyContent: 'space-between' },
    statItem: { alignItems: 'center' },
    statItemValue: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    statItemLabel: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 1 },
    cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
    vehicleTag: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    vehicleTagText: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    xpBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 3,
      backgroundColor: colors.primary + '15', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8,
    },
    xpBadgeText: { fontSize: 11, fontWeight: '600', color: colors.primary, fontFamily: 'Inter_600SemiBold' },
    emptyContainer: { alignItems: 'center', paddingTop: 60, paddingBottom: 40 },
    emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', marginTop: 12 },
    emptyText: { fontSize: 14, color: colors.mutedForeground, marginTop: 6, textAlign: 'center', fontFamily: 'Inter_400Regular', paddingHorizontal: 40 },
    listContent: { paddingBottom: (Platform.OS === 'web' ? 84 : insets.bottom + 50) + 16 },
    // Modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalContent: {
      backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
      padding: 24, paddingBottom: Math.max(insets.bottom, 16) + 16, maxHeight: '70%',
    },
    modalHandle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    modalTitle: { fontSize: 18, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginBottom: 16 },
    modalRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    modalRowText: { fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular' },
    modalRowActive: { color: colors.primary, fontFamily: 'Inter_600SemiBold' },
  });

  function JourneyCard({ item }: { item: Journey }) {
    const vehicle = vehicles.find((v) => v.id === item.vehicleId);
    const cat = item.categoryId ? categories.find((c) => c.id === item.categoryId) : null;
    const isConvoy = item.journeyType === 'convoy';
    return (
      <TouchableOpacity style={styles.journeyCard} onPress={() => router.push(`/journey/${item.id}`)}>
        <View style={styles.cardTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.journeyName}>{item.name}</Text>
            <Text style={styles.journeyDate}>{formatDate(item.date)} · {item.startTime}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.mutedForeground} />
        </View>
        <View style={styles.cardMeta}>
          {isConvoy && (
            <View style={[styles.tag, styles.convoyTag]}>
              <Ionicons name="people-outline" size={10} color={colors.primary} />
              <Text style={[styles.tagText, styles.convoyTagText]}>Convoy</Text>
            </View>
          )}
          {cat && (
            <View style={[styles.tag, { borderLeftWidth: 2, borderLeftColor: cat.colour }]}>
              <Ionicons name={cat.icon as any} size={10} color={cat.colour} />
              <Text style={[styles.tagText, { color: cat.colour }]}>{cat.name}</Text>
            </View>
          )}
        </View>
        <View style={styles.cardDivider} />
        <View style={styles.statsGrid2}>
          <View style={styles.statItem}>
            <Text style={styles.statItemValue}>{formatDistance(item.distance, resolvedUnitSystem)}</Text>
            <Text style={styles.statItemLabel}>Distance</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statItemValue}>{formatDuration(item.duration)}</Text>
            <Text style={styles.statItemLabel}>Duration</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statItemValue}>{formatSpeed(item.averageSpeed, resolvedUnitSystem)}</Text>
            <Text style={styles.statItemLabel}>Avg</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statItemValue, { color: colors.primary }]}>{formatSpeed(item.topSpeed, resolvedUnitSystem)}</Text>
            <Text style={styles.statItemLabel}>Top</Text>
          </View>
        </View>
        <View style={styles.cardFooter}>
          {vehicle ? (
            <View style={styles.vehicleTag}>
              <Ionicons name="car-outline" size={11} color={colors.mutedForeground} />
              <Text style={styles.vehicleTagText}>{vehicle.nickname}</Text>
            </View>
          ) : <View />}
          {(item.xpEarned ?? 0) > 0 && (
            <View style={styles.xpBadge}>
              <Ionicons name="star" size={10} color={colors.primary} />
              <Text style={styles.xpBadgeText}>+{item.xpEarned} XP</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  const currentSortLabel = SORT_OPTIONS.find((s) => s.key === sortBy)?.label ?? 'Recent';
  const activeCatFilter = filterCategoryId ? categories.find((c) => c.id === filterCategoryId) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Journeys</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowCategories(true)}>
            <Ionicons name="pricetags-outline" size={16} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowSort(true)}>
            <Ionicons name="funnel-outline" size={16} color={colors.foreground} />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            {/* Time period selector */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.periodRow}>
              {(Object.keys(PERIOD_LABELS) as TimePeriod[]).map((p) => (
                <TouchableOpacity key={p}
                  style={[styles.periodBtn, period === p && styles.periodBtnActive]}
                  onPress={() => setPeriod(p)}>
                  <Text style={[styles.periodBtnText, period === p && styles.periodBtnTextActive]}>
                    {PERIOD_LABELS[p]}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* XP summary */}
            {stats.totalXP > 0 && (
              <View style={styles.xpCard}>
                <Ionicons name="star" size={22} color={colors.primary} />
                <View>
                  <Text style={styles.xpValue}>{stats.totalXP.toLocaleString()} XP</Text>
                  <Text style={styles.xpLabel}>earned {PERIOD_LABELS[period].toLowerCase()}</Text>
                </View>
              </View>
            )}

            {/* Primary stats */}
            <Text style={styles.statsSectionTitle}>Overview</Text>
            <View style={styles.statsGrid}>
              <View style={styles.primaryStats}>
                <View style={styles.primaryCard}>
                  <Text style={styles.primaryValue}>{stats.total}</Text>
                  <Text style={styles.primaryLabel}>Total Drives</Text>
                </View>
                <View style={styles.primaryCard}>
                  <Text style={[styles.primaryValue, { color: colors.primary }]}>{formatDistance(stats.totalKm, resolvedUnitSystem)}</Text>
                  <Text style={styles.primaryLabel}>Total Distance</Text>
                </View>
              </View>
              <View style={styles.secondaryStats}>
                <View style={styles.secondaryCard}>
                  <Text style={styles.secondaryValue}>{formatDuration(stats.totalSec)}</Text>
                  <Text style={styles.secondaryLabel}>Drive Time</Text>
                </View>
                <View style={styles.secondaryCard}>
                  <Text style={styles.secondaryValue}>{formatDistance(stats.total > 0 ? stats.totalKm / stats.total : 0, resolvedUnitSystem)}</Text>
                  <Text style={styles.secondaryLabel}>Avg Distance</Text>
                </View>
                <View style={styles.secondaryCard}>
                  <Text style={styles.secondaryValue}>{formatSpeed(stats.avgSpeed, resolvedUnitSystem)}</Text>
                  <Text style={styles.secondaryLabel}>Avg Speed</Text>
                </View>
                <View style={styles.secondaryCard}>
                  <Text style={[styles.secondaryValue, { color: colors.primary }]}>{formatSpeed(stats.topSpeed, resolvedUnitSystem)}</Text>
                  <Text style={styles.secondaryLabel}>Top Speed</Text>
                </View>
                <View style={styles.secondaryCard}>
                  <Text style={styles.secondaryValue}>{formatDistance(stats.longest, resolvedUnitSystem)}</Text>
                  <Text style={styles.secondaryLabel}>Longest</Text>
                </View>
                <View style={styles.secondaryCard}>
                  <Text style={styles.secondaryValue}>{stats.personalCount}/{stats.convoyCount}</Text>
                  <Text style={styles.secondaryLabel}>Solo/Convoy</Text>
                </View>
              </View>
              {stats.topVehicle && (
                <View style={[styles.primaryCard, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                  <Ionicons name="car-outline" size={20} color={colors.primary} />
                  <View>
                    <Text style={[styles.primaryValue, { fontSize: 16 }]}>{stats.topVehicle.nickname}</Text>
                    <Text style={styles.primaryLabel}>Most driven vehicle</Text>
                  </View>
                </View>
              )}
            </View>

            <View style={styles.divider} />

            {/* Filter row */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              {(['all', 'personal', 'convoy'] as FilterType[]).map((f) => (
                <TouchableOpacity key={f}
                  style={[styles.filterBtn, filterType === f && styles.filterBtnActive]}
                  onPress={() => setFilterType(f)}>
                  <Text style={[styles.filterBtnText, filterType === f && styles.filterBtnTextActive]}>
                    {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
              {categories.map((cat) => (
                <TouchableOpacity key={cat.id}
                  style={[styles.filterBtn, filterCategoryId === cat.id && styles.filterBtnActive]}
                  onPress={() => setFilterCategoryId((p) => p === cat.id ? null : cat.id)}>
                  <Text style={[styles.filterBtnText, filterCategoryId === cat.id && styles.filterBtnTextActive]}>
                    {cat.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Sort row */}
            <View style={styles.sortRow}>
              <Text style={styles.sortLabel}>
                {filtered.length} journey{filtered.length !== 1 ? 's' : ''}
                {activeCatFilter ? ` · ${activeCatFilter.name}` : ''}
              </Text>
              <TouchableOpacity style={styles.sortBtn} onPress={() => setShowSort(true)}>
                <Ionicons name="swap-vertical-outline" size={13} color={colors.foreground} />
                <Text style={styles.sortBtnText}>{currentSortLabel}</Text>
              </TouchableOpacity>
            </View>
          </>
        }
        renderItem={({ item }) => <JourneyCard item={item} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="navigate-outline" size={48} color={colors.mutedForeground} />
            <Text style={styles.emptyTitle}>No journeys here</Text>
            <Text style={styles.emptyText}>
              {period !== 'all' ? `No drives recorded for ${PERIOD_LABELS[period].toLowerCase()}.` : 'Head to the map and start a drive.'}
            </Text>
          </View>
        }
      />

      {/* Sort modal */}
      <Modal visible={showSort} transparent animationType="slide" onRequestClose={() => setShowSort(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Sort journeys</Text>
            {SORT_OPTIONS.map((opt) => (
              <TouchableOpacity key={opt.key} style={styles.modalRow}
                onPress={() => { setSortBy(opt.key); setShowSort(false); }}>
                <Text style={[styles.modalRowText, sortBy === opt.key && styles.modalRowActive]}>{opt.label}</Text>
                {sortBy === opt.key && <Ionicons name="checkmark" size={18} color={colors.primary} />}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>

      {/* Categories modal */}
      <Modal visible={showCategories} transparent animationType="slide" onRequestClose={() => setShowCategories(false)}>
        <View style={styles.modalOverlay}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ justifyContent: 'flex-end', flex: 1 }}>
            <View style={styles.modalContent}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Journey Categories</Text>
              {categories.map((cat) => (
                <View key={cat.id} style={styles.modalRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: cat.colour }} />
                    <Ionicons name={cat.icon as any} size={16} color={cat.colour} />
                    <Text style={styles.modalRowText}>{cat.name}</Text>
                  </View>
                  <TouchableOpacity onPress={() => Alert.alert('Delete Category', `Delete "${cat.name}"? Journeys in this category will become uncategorised.`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => { deleteCategory(cat.id); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } },
                  ])}>
                    <Ionicons name="trash-outline" size={16} color={colors.destructive} />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity
                style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }}
                onPress={() => {
                  Alert.prompt
                    ? Alert.prompt('New Category', 'Enter a name for the new category:', (name) => {
                        if (name?.trim()) { addCategory({ name: name.trim(), icon: 'bookmark-outline', colour: '#F4631A' }); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }
                      })
                    : Alert.alert('New Category', 'Use the iOS app to create custom categories with icons and colours.');
                }}>
                <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                <Text style={{ fontSize: 15, color: colors.primary, fontFamily: 'Inter_500Medium' }}>Add Category</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

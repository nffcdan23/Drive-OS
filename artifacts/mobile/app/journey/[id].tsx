import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform, Alert,
  TextInput, Modal,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { useApp, Coordinate } from '@/context/AppContext';
import { formatDistance, formatSpeed } from '@/lib/units';
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

// Renders a simple SVG polyline of the route coordinates
function RouteMapView({ coordinates }: { coordinates: Coordinate[] }) {
  const colors = useColors();
  const W = 360;
  const H = 200;
  const PAD = 24;

  if (coordinates.length === 0) {
    return (
      <View style={{ height: H, backgroundColor: colors.muted, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
        <Ionicons name="map-outline" size={32} color={colors.mutedForeground} />
        <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 8 }}>
          Route data was not recorded for this journey.
        </Text>
      </View>
    );
  }

  const lats = coordinates.map((c) => c.latitude);
  const lons = coordinates.map((c) => c.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const latRange = maxLat - minLat || 0.001;
  const lonRange = maxLon - minLon || 0.001;
  const scale = Math.min((W - PAD * 2) / lonRange, (H - PAD * 2) / latRange);

  const toX = (lon: number) => PAD + (lon - minLon) * scale;
  const toY = (lat: number) => H - PAD - (lat - minLat) * scale;

  const pathD = coordinates.map((c, i) =>
    `${i === 0 ? 'M' : 'L'}${toX(c.longitude).toFixed(1)},${toY(c.latitude).toFixed(1)}`
  ).join(' ');

  const startX = toX(coordinates[0].longitude);
  const startY = toY(coordinates[0].latitude);
  const endX = toX(coordinates[coordinates.length - 1].longitude);
  const endY = toY(coordinates[coordinates.length - 1].latitude);

  return (
    <View style={{ height: H + 8, backgroundColor: '#1A2A1A', borderRadius: 16, marginBottom: 20, overflow: 'hidden' }}>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <Defs>
          <SvgLinearGradient id="routeGrad" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#F4631A" stopOpacity="0.6" />
            <Stop offset="1" stopColor="#F4631A" stopOpacity="1" />
          </SvgLinearGradient>
        </Defs>
        {/* Route line */}
        <Path d={pathD} stroke="url(#routeGrad)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        {/* Start marker */}
        <Circle cx={startX} cy={startY} r="6" fill="#22c55e" />
        <Circle cx={startX} cy={startY} r="10" fill="none" stroke="#22c55e" strokeWidth="2" strokeOpacity="0.5" />
        {/* End marker */}
        <Circle cx={endX} cy={endY} r="6" fill="#F4631A" />
        <Circle cx={endX} cy={endY} r="10" fill="none" stroke="#F4631A" strokeWidth="2" strokeOpacity="0.5" />
      </Svg>
      <View style={{ flexDirection: 'row', gap: 16, paddingHorizontal: 12, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e' }} />
          <Text style={{ fontSize: 11, color: '#22c55e', fontFamily: 'Inter_400Regular' }}>Start</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#F4631A' }} />
          <Text style={{ fontSize: 11, color: '#F4631A', fontFamily: 'Inter_400Regular' }}>Finish</Text>
        </View>
        <Text style={{ fontSize: 11, color: '#6B7280', fontFamily: 'Inter_400Regular' }}>
          {coordinates.length} coordinates recorded
        </Text>
      </View>
    </View>
  );
}

const PRIVACY_OPTIONS: { value: string; label: string; icon: string }[] = [
  { value: 'private', label: 'Private', icon: 'lock-closed-outline' },
  { value: 'friends', label: 'Friends', icon: 'people-outline' },
  { value: 'public', label: 'Public', icon: 'earth-outline' },
];

// Mock convoy participants for the convoy journey type
const MOCK_PARTICIPANTS = [
  { id: 'p1', name: 'Sarah T.', initials: 'ST', vehicle: 'Cooper S JCW', distance: 63.8, xp: 128 },
  { id: 'p2', name: 'Mike R.', initials: 'MR', vehicle: 'BMW M340i', distance: 63.8, xp: 128 },
  { id: 'p3', name: 'James H.', initials: 'JH', vehicle: 'Abarth 595', distance: 51.2, xp: 102, joinedLate: true },
];

export default function JourneyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { journeys, vehicles, deleteJourney, updateJourney, categories, resolvedUnitSystem } = useApp();

  const journey = journeys.find((j) => j.id === id);
  const vehicle = journey
    ? (vehicles.find((v) => v.id === journey.vehicleId) ?? null)
    : null;
  const vehicleDisplay = journey?.vehicleSnapshot ?? (vehicle ? {
    nickname: vehicle.nickname, make: vehicle.make, model: vehicle.model,
    year: vehicle.year, power: vehicle.power, engine: vehicle.engine, imageUri: vehicle.imageUri,
  } : null);

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(journey?.name ?? '');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(journey?.notes ?? '');
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [showPrivacyPicker, setShowPrivacyPicker] = useState(false);

  const category = journey?.categoryId ? categories.find((c) => c.id === journey.categoryId) : null;
  const privacyOpt = PRIVACY_OPTIONS.find((p) => p.value === (journey?.privacy ?? 'private'));

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
    sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', marginBottom: 10, marginTop: 20 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
    journeyName: { fontSize: 22, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', flex: 1 },
    nameInput: {
      flex: 1, fontSize: 22, fontWeight: '700', color: colors.foreground,
      fontFamily: 'Inter_700Bold', borderBottomWidth: 2, borderBottomColor: colors.primary,
    },
    editBtn: { padding: 4 },
    dateText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginBottom: 12 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
    metaTag: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10,
      backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border,
    },
    metaTagText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
    statCard: {
      flex: 1, minWidth: '45%', backgroundColor: colors.card, borderRadius: 14, padding: 14,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    statValue: { fontSize: 20, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    statLabel: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    statHighlight: { color: colors.primary },
    xpCard: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: colors.primary + '15', borderRadius: 14, padding: 14, marginBottom: 20,
      borderWidth: 1, borderColor: colors.primary + '30',
    },
    xpValue: { fontSize: 18, fontWeight: '700', color: colors.primary, fontFamily: 'Inter_700Bold' },
    xpLabel: { fontSize: 12, color: colors.primary, fontFamily: 'Inter_400Regular' },
    vehicleCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14, flexDirection: 'row',
      alignItems: 'center', gap: 12, marginBottom: 20,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    vehicleIconBox: {
      width: 44, height: 44, borderRadius: 10, backgroundColor: colors.muted,
      alignItems: 'center', justifyContent: 'center',
    },
    vehicleName: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    vehicleSub: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    vehicleSnapshotNote: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2, fontStyle: 'italic' },
    notesCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginBottom: 20,
    },
    notesHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    notesText: { fontSize: 14, color: colors.foreground, fontFamily: 'Inter_400Regular', lineHeight: 21 },
    notesInput: {
      fontSize: 14, color: colors.foreground, fontFamily: 'Inter_400Regular', lineHeight: 21,
      borderBottomWidth: 1, borderBottomColor: colors.primary, paddingBottom: 4, minHeight: 60,
    },
    notesPlaceholder: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    photosPlaceholder: {
      backgroundColor: colors.muted, borderRadius: 14, height: 100,
      alignItems: 'center', justifyContent: 'center', gap: 6,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderStyle: 'dashed',
    },
    photosText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    // Convoy participants
    participantCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14, flexDirection: 'row',
      alignItems: 'center', gap: 12, marginBottom: 8,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    participantAvatar: {
      width: 40, height: 40, borderRadius: 20, backgroundColor: colors.muted,
      alignItems: 'center', justifyContent: 'center',
    },
    participantInitials: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    participantName: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    participantVehicle: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 1 },
    participantStats: { alignItems: 'flex-end', marginLeft: 'auto' },
    lateTag: {
      backgroundColor: colors.muted, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2,
    },
    lateTagText: { fontSize: 10, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    // Modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalContent: {
      backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
      padding: 24, paddingBottom: Math.max(insets.bottom, 16) + 16,
    },
    modalHandle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    modalTitle: { fontSize: 18, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginBottom: 16 },
    modalRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    modalRowText: { fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular' },
    modalRowActive: { color: colors.primary, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  });

  if (!journey) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Ionicons name="map-outline" size={48} color={colors.mutedForeground} />
        <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: '600', marginTop: 12, fontFamily: 'Inter_600SemiBold' }}>Journey not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontFamily: 'Inter_500Medium' }}>Go back</Text>
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

  const isConvoy = journey.journeyType === 'convoy';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isConvoy ? 'Convoy Journey' : 'Journey'}</Text>
        <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
          <Ionicons name="trash-outline" size={20} color={colors.destructive} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Route map */}
        <RouteMapView coordinates={journey.routeCoordinates} />

        {/* Journey name */}
        <View style={styles.nameRow}>
          {editingName ? (
            <TextInput
              style={styles.nameInput}
              value={nameValue}
              onChangeText={setNameValue}
              autoFocus
              onBlur={() => { updateJourney(journey.id, { name: nameValue || 'Unnamed Journey' }); setEditingName(false); }}
              returnKeyType="done"
              onSubmitEditing={() => { updateJourney(journey.id, { name: nameValue || 'Unnamed Journey' }); setEditingName(false); }}
            />
          ) : (
            <Text style={styles.journeyName}>{journey.name}</Text>
          )}
          <TouchableOpacity style={styles.editBtn} onPress={() => { setEditingName(true); setNameValue(journey.name); }}>
            <Ionicons name="pencil-outline" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
        <Text style={styles.dateText}>{formatDate(journey.date)} · {journey.startTime}–{journey.endTime}</Text>

        {/* Meta tags: category, privacy, type */}
        <View style={styles.metaRow}>
          <TouchableOpacity style={styles.metaTag} onPress={() => setShowCategoryPicker(true)}>
            {category
              ? <><Ionicons name={category.icon as any} size={13} color={category.colour} /><Text style={[styles.metaTagText, { color: category.colour }]}>{category.name}</Text></>
              : <><Ionicons name="pricetag-outline" size={13} color={colors.mutedForeground} /><Text style={styles.metaTagText}>Category</Text></>
            }
          </TouchableOpacity>
          <TouchableOpacity style={styles.metaTag} onPress={() => setShowPrivacyPicker(true)}>
            <Ionicons name={privacyOpt?.icon as any ?? 'lock-closed-outline'} size={13} color={colors.mutedForeground} />
            <Text style={styles.metaTagText}>{privacyOpt?.label ?? 'Private'}</Text>
          </TouchableOpacity>
          <View style={[styles.metaTag, isConvoy && { borderColor: colors.primary + '40' }]}>
            <Ionicons name={isConvoy ? 'people-outline' : 'person-outline'} size={13} color={isConvoy ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.metaTagText, isConvoy && { color: colors.primary }]}>{isConvoy ? 'Convoy' : 'Personal'}</Text>
          </View>
        </View>

        {/* XP */}
        {(journey.xpEarned ?? 0) > 0 && (
          <View style={styles.xpCard}>
            <Ionicons name="star" size={22} color={colors.primary} />
            <View>
              <Text style={styles.xpValue}>+{journey.xpEarned} XP earned</Text>
              <Text style={styles.xpLabel}>from this journey</Text>
            </View>
          </View>
        )}

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatDistance(journey.distance, resolvedUnitSystem)}</Text>
            <Text style={styles.statLabel}>Distance</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatDuration(journey.duration)}</Text>
            <Text style={styles.statLabel}>Duration</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatSpeed(journey.averageSpeed, resolvedUnitSystem)}</Text>
            <Text style={styles.statLabel}>Avg Speed</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, styles.statHighlight]}>{formatSpeed(journey.topSpeed, resolvedUnitSystem)}</Text>
            <Text style={styles.statLabel}>Top Speed</Text>
          </View>
        </View>

        {/* Vehicle */}
        {vehicleDisplay && (
          <View style={styles.vehicleCard}>
            <View style={styles.vehicleIconBox}>
              <Ionicons name="car" size={24} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.vehicleName}>{vehicleDisplay.nickname}</Text>
              <Text style={styles.vehicleSub}>{vehicleDisplay.year} {vehicleDisplay.make} {vehicleDisplay.model}</Text>
              {journey.vehicleSnapshot && !vehicle && (
                <Text style={styles.vehicleSnapshotNote}>Vehicle snapshot (no longer in garage)</Text>
              )}
            </View>
          </View>
        )}

        {/* Convoy participants */}
        {isConvoy && (
          <>
            <Text style={styles.sectionTitle}>Convoy Participants · {MOCK_PARTICIPANTS.length}</Text>
            {MOCK_PARTICIPANTS.map((p) => (
              <View key={p.id} style={styles.participantCard}>
                <View style={styles.participantAvatar}>
                  <Text style={styles.participantInitials}>{p.initials}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.participantName}>{p.name}</Text>
                  <Text style={styles.participantVehicle}>{p.vehicle}</Text>
                  {p.joinedLate && (
                    <View style={styles.lateTag}><Text style={styles.lateTagText}>Joined late</Text></View>
                  )}
                </View>
                <View style={styles.participantStats}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' }}>{formatDistance(p.distance, resolvedUnitSystem)}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 }}>
                    <Ionicons name="star" size={10} color={colors.primary} />
                    <Text style={{ fontSize: 11, color: colors.primary, fontFamily: 'Inter_500Medium' }}>+{p.xp} XP</Text>
                  </View>
                </View>
              </View>
            ))}
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginBottom: 16, textAlign: 'center' }}>
              Performance stats are private to convoy participants.
            </Text>
          </>
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
              onBlur={() => { updateJourney(journey.id, { notes: notesValue }); setEditingNotes(false); }}
            />
          ) : journey.notes ? (
            <Text style={styles.notesText}>{journey.notes}</Text>
          ) : (
            <TouchableOpacity onPress={() => setEditingNotes(true)}>
              <Text style={styles.notesPlaceholder}>Tap to add notes...</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Photos */}
        <Text style={[styles.sectionTitle, { marginBottom: 10, marginTop: 0 }]}>Photos</Text>
        <TouchableOpacity style={styles.photosPlaceholder}>
          <Ionicons name="camera-outline" size={28} color={colors.mutedForeground} />
          <Text style={styles.photosText}>Photo upload — coming in next update</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Category picker modal */}
      <Modal visible={showCategoryPicker} transparent animationType="slide" onRequestClose={() => setShowCategoryPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Choose Category</Text>
            <TouchableOpacity style={styles.modalRow} onPress={() => { updateJourney(journey.id, { categoryId: undefined }); setShowCategoryPicker(false); }}>
              <Text style={styles.modalRowText}>Uncategorised</Text>
              {!journey.categoryId && <Ionicons name="checkmark" size={18} color={colors.primary} />}
            </TouchableOpacity>
            {(useApp as any)._categories ?? []}
            <CategoryPickerList
              currentId={journey.categoryId}
              onSelect={(id) => { updateJourney(journey.id, { categoryId: id }); setShowCategoryPicker(false); }}
            />
          </View>
        </View>
      </Modal>

      {/* Privacy picker modal */}
      <Modal visible={showPrivacyPicker} transparent animationType="slide" onRequestClose={() => setShowPrivacyPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Journey Privacy</Text>
            {PRIVACY_OPTIONS.map((opt) => (
              <TouchableOpacity key={opt.value} style={styles.modalRow}
                onPress={() => { updateJourney(journey.id, { privacy: opt.value as any }); setShowPrivacyPicker(false); }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Ionicons name={opt.icon as any} size={18} color={journey.privacy === opt.value ? colors.primary : colors.mutedForeground} />
                  <Text style={[styles.modalRowText, journey.privacy === opt.value && styles.modalRowActive]}>{opt.label}</Text>
                </View>
                {journey.privacy === opt.value && <Ionicons name="checkmark" size={18} color={colors.primary} />}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Inner component to access context inside the modal
function CategoryPickerList({ currentId, onSelect }: { currentId?: string; onSelect: (id: string) => void }) {
  const { categories } = useApp();
  const colors = useColors();
  return (
    <>
      {categories.map((cat) => (
        <TouchableOpacity
          key={cat.id}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}
          onPress={() => onSelect(cat.id)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: cat.colour }} />
            <Ionicons name={cat.icon as any} size={16} color={cat.colour} />
            <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular' }}>{cat.name}</Text>
          </View>
          {currentId === cat.id && <Ionicons name="checkmark" size={18} color={colors.primary} />}
        </TouchableOpacity>
      ))}
    </>
  );
}

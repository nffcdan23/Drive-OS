/**
 * Places: the user's saved locations (Home, Work, favourite roads, meeting
 * points) and Beauty Spots — their own and ones shared nearby. Everything is
 * stored in the user's account; places saved offline upload later.
 */
import { GlassSurface } from '@/components/Glass';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text,
  TextInput, TouchableOpacity, View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useApp, type NearbySpot, type SavedPlace } from '@/context/AppContext';
import type { LocationKind, SpotCategory, Visibility } from '@/lib/backend/endpoints';
import { describeError } from '@/lib/backend/http';

type Section = 'saved' | 'spots';

const KIND_LABEL: Record<LocationKind, string> = {
  home: 'Home', work: 'Work', favourite_road: 'Favourite road', meeting_point: 'Meeting point',
  car_park: 'Car park', poi: 'Place', beauty_spot: 'Beauty Spot',
};
const KIND_ICON: Record<LocationKind, keyof typeof Ionicons.glyphMap> = {
  home: 'home-outline', work: 'briefcase-outline', favourite_road: 'star-outline', meeting_point: 'people-outline',
  car_park: 'car-outline', poi: 'location-outline', beauty_spot: 'triangle-outline',
};
const SAVE_KINDS: LocationKind[] = ['home', 'work', 'favourite_road', 'meeting_point', 'beauty_spot'];
const SPOT_CATEGORIES: Array<{ id: SpotCategory; label: string }> = [
  { id: 'viewpoint', label: 'Viewpoint' }, { id: 'scenic_road', label: 'Scenic road' }, { id: 'mountain_pass', label: 'Mountain pass' },
  { id: 'coastal', label: 'Coastal' }, { id: 'lake', label: 'Lake' }, { id: 'forest', label: 'Forest' },
  { id: 'landmark', label: 'Landmark' }, { id: 'photo_spot', label: 'Photo spot' }, { id: 'other', label: 'Other' },
];
const VISIBILITY_LABEL: Record<Visibility, string> = { private: 'Only me', friends: 'Friends', public: 'Everyone' };

async function currentPosition(): Promise<{ latitude: number; longitude: number }> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Allow location access to save or find places.');
  const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
  const pos = last ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
}

export default function PlacesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { places, addPlace, deletePlace, findNearbySpots } = useApp();
  const [query, setQuery] = useState('');
  const params = useLocalSearchParams<{ section?: string }>();
  const [section, setSection] = useState<Section>(params.section === 'spots' ? 'spots' : 'saved');
  const [showSave, setShowSave] = useState(false);
  const [nearby, setNearby] = useState<NearbySpot[] | null>(null);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);

  const saved = useMemo(() => places.filter((p) => p.kind !== 'beauty_spot'), [places]);
  const mySpots = useMemo(() => places.filter((p) => p.kind === 'beauty_spot'), [places]);
  const matches = (name: string) => !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());

  const loadNearby = useCallback(async () => {
    setNearbyLoading(true);
    setNearbyError(null);
    try {
      const pos = await currentPosition();
      setNearby(await findNearbySpots(pos.latitude, pos.longitude, 50_000));
    } catch (err) {
      setNearbyError(describeError(err));
    } finally {
      setNearbyLoading(false);
    }
  }, [findNearbySpots]);

  useEffect(() => { if (section === 'spots' && nearby === null && !nearbyLoading) void loadNearby(); }, [section, nearby, nearbyLoading, loadNearby]);

  const confirmDelete = (p: SavedPlace) => Alert.alert(`Delete "${p.name}"?`, 'It will be removed from your account on all devices.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => deletePlace(p.id) },
  ]);

  const s = styles(colors, insets.top, insets.bottom);

  const PlaceRow = ({ p }: { p: SavedPlace }) => (
    <TouchableOpacity style={s.row} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.back(); }}
      onLongPress={() => confirmDelete(p)} accessibilityHint="Long-press to delete">
      <View style={s.iconWrap}><Ionicons name={KIND_ICON[p.kind]} size={18} color={colors.primary} /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.name}>{p.name}</Text>
        <Text style={s.meta}>
          {KIND_LABEL[p.kind]}{p.kind === 'beauty_spot' ? ` · ${VISIBILITY_LABEL[p.visibility]}` : ''}
          {p.syncState === 'pending' ? ' · Waiting to upload' : ''}
        </Text>
      </View>
      <TouchableOpacity onPress={() => confirmDelete(p)} hitSlop={10} accessibilityLabel={`Delete ${p.name}`}>
        <Ionicons name="trash-outline" size={18} color={colors.mutedForeground} />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  function content() {
    if (section === 'saved') {
      const list = saved.filter((p) => matches(p.name));
      return (
        <>
          <Text style={s.header}>Saved places</Text>
          {list.length ? list.map((p) => <PlaceRow key={p.id} p={p} />) : <Text style={s.empty}>No saved places yet. Save where you are with the button below.</Text>}
        </>
      );
    }
    const others = (nearby ?? []).filter((n) => !n.isOwn && matches(n.name));
    return (
      <>
        <Text style={s.header}>My Beauty Spots</Text>
        {mySpots.filter((p) => matches(p.name)).map((p) => <PlaceRow key={p.id} p={p} />)}
        {!mySpots.length ? <Text style={s.empty}>You haven't saved any Beauty Spots yet.</Text> : null}
        <View style={s.nearbyHeader}>
          <Text style={s.header}>Shared nearby</Text>
          <TouchableOpacity onPress={loadNearby} hitSlop={10}><Ionicons name="refresh" size={18} color={colors.primary} /></TouchableOpacity>
        </View>
        {nearbyLoading ? <ActivityIndicator color={colors.primary} style={{ marginTop: 16 }} /> : null}
        {nearbyError ? <Text style={[s.empty, { color: colors.destructive }]}>{nearbyError}</Text> : null}
        {!nearbyLoading && !nearbyError && nearby && !others.length ? <Text style={s.empty}>No shared Beauty Spots within 50 km.</Text> : null}
        {others.map((n) => (
          <View key={n.id} style={s.row}>
            <View style={s.iconWrap}><Ionicons name="triangle-outline" size={18} color={colors.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{n.name}</Text>
              <Text style={s.meta}>{n.distanceM != null ? `${(n.distanceM / 1000).toFixed(1)} km away` : ''}{n.visibility === 'friends' ? ' · Friend' : ''}</Text>
            </View>
          </View>
        ))}
      </>
    );
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.searchHeader}>
        <GlassSurface style={s.searchInputWrap}>
          <Ionicons name="search" size={18} color={colors.mutedForeground} />
          <TextInput style={s.searchInput} placeholder="Filter your places" placeholderTextColor={colors.mutedForeground}
            value={query} onChangeText={setQuery} returnKeyType="search" />
          {query ? <TouchableOpacity onPress={() => setQuery('')}><Ionicons name="close-circle" size={18} color={colors.mutedForeground} /></TouchableOpacity> : null}
        </GlassSurface>
        <TouchableOpacity style={s.cancelBtn} onPress={() => router.back()}><Text style={s.cancelText}>Close</Text></TouchableOpacity>
      </View>
      <View style={s.tabs}>
        {(['saved', 'spots'] as const).map((t) => (
          <TouchableOpacity key={t} style={[s.tab, section === t && s.tabActive]} onPress={() => setSection(t)}>
            <Text style={[s.tabText, section === t && s.tabTextActive]}>{t === 'saved' ? 'Saved' : 'Beauty Spots'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <FlatList data={[null]} renderItem={() => <View>{content()}</View>} keyExtractor={() => 'c'} contentContainerStyle={s.list} keyboardShouldPersistTaps="handled" />
      <TouchableOpacity style={s.saveBtn} onPress={() => setShowSave(true)} accessibilityRole="button">
        <Ionicons name="add-circle-outline" size={20} color={colors.primaryForeground} />
        <Text style={s.saveText}>Save where I am</Text>
      </TouchableOpacity>
      <SavePlaceSheet visible={showSave} defaultKind={section === 'spots' ? 'beauty_spot' : 'favourite_road'} onClose={() => setShowSave(false)} onSave={addPlace} />
    </KeyboardAvoidingView>
  );
}

function SavePlaceSheet({ visible, defaultKind, onClose, onSave }: {
  visible: boolean; defaultKind: LocationKind; onClose: () => void;
  onSave: ReturnType<typeof useApp>['addPlace'];
}) {
  const colors = useColors();
  const [kind, setKind] = useState<LocationKind>(defaultKind);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<SpotCategory>('viewpoint');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (visible) { setKind(defaultKind); setName(''); setDescription(''); setError(null); setVisibility('private'); } }, [visible, defaultKind]);

  const isSpot = kind === 'beauty_spot';
  const s = styles(colors, 0, 0);

  async function save() {
    const finalName = name.trim() || (kind === 'home' || kind === 'work' ? KIND_LABEL[kind] : '');
    if (!finalName) { setError('Give this place a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const coordinate = await currentPosition();
      await onSave({ kind, name: finalName, coordinate, description: description.trim() || undefined, ...(isSpot ? { category, visibility } : {}) });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const Chip = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
    <TouchableOpacity onPress={onPress} style={[s.chip, active && s.chipActive]}><Text style={[s.chipText, active && s.chipTextActive]}>{label}</Text></TouchableOpacity>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay}>
        <GlassSurface material="dense" style={s.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <Text style={s.sheetTitle}>Save this place</Text>
            <View style={s.chips}>{SAVE_KINDS.map((k) => <Chip key={k} label={KIND_LABEL[k]} active={kind === k} onPress={() => setKind(k)} />)}</View>
            <TextInput style={s.input} placeholder={kind === 'home' || kind === 'work' ? KIND_LABEL[kind] : 'Name'}
              placeholderTextColor={colors.mutedForeground} value={name} onChangeText={setName} maxLength={100} />
            {isSpot ? (
              <>
                <TextInput style={[s.input, { height: 80, textAlignVertical: 'top', paddingTop: 12 }]} placeholder="What makes it special? (optional)"
                  placeholderTextColor={colors.mutedForeground} value={description} onChangeText={setDescription} multiline maxLength={2000} />
                <Text style={s.label}>Type</Text>
                <View style={s.chips}>{SPOT_CATEGORIES.map((c) => <Chip key={c.id} label={c.label} active={category === c.id} onPress={() => setCategory(c.id)} />)}</View>
                <Text style={s.label}>Who can see it</Text>
                <View style={s.chips}>{(['private', 'friends', 'public'] as const).map((v) => <Chip key={v} label={VISIBILITY_LABEL[v]} active={visibility === v} onPress={() => setVisibility(v)} />)}</View>
              </>
            ) : (
              <Text style={s.note}>{kind === 'home' || kind === 'work' ? 'Home and Work are always private.' : 'Saved places are private to you.'}</Text>
            )}
            {error ? <Text style={{ color: colors.destructive, fontFamily: 'Inter_400Regular' }}>{error}</Text> : null}
            <TouchableOpacity style={s.primary} onPress={save} disabled={busy}>
              {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={s.saveText}>Save current location</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={{ alignItems: 'center', padding: 8 }}><Text style={s.cancelText}>Cancel</Text></TouchableOpacity>
          </ScrollView>
        </GlassSurface>
      </View>
    </Modal>
  );
}

const styles = (c: ReturnType<typeof useColors>, top: number, bottom: number) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  searchHeader: {
    paddingTop: top + 16, paddingHorizontal: 16, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  searchInputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 44, borderRadius: 12 },
  searchInput: { flex: 1, color: c.foreground, fontSize: 16, fontFamily: 'Inter_400Regular' },
  cancelBtn: { paddingHorizontal: 4 },
  cancelText: { color: c.primary, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  tab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: c.muted },
  tabActive: { backgroundColor: c.primary },
  tabText: { color: c.mutedForeground, fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  tabTextActive: { color: c.primaryForeground },
  list: { paddingBottom: bottom + 100 },
  header: { color: c.mutedForeground, fontSize: 12, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, textTransform: 'uppercase', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6 },
  nearbyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, backgroundColor: c.muted, alignItems: 'center', justifyContent: 'center' },
  name: { color: c.foreground, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  meta: { color: c.mutedForeground, fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  empty: { color: c.mutedForeground, fontFamily: 'Inter_400Regular', paddingHorizontal: 20, paddingVertical: 8 },
  saveBtn: {
    position: 'absolute', left: 20, right: 20, bottom: bottom + 16, height: 50, borderRadius: 14, backgroundColor: c.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  saveText: { color: c.primaryForeground, fontFamily: 'Inter_600SemiBold', fontSize: 16 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { padding: 20, paddingBottom: 36, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '85%' },
  sheetTitle: { color: c.foreground, fontFamily: 'Inter_700Bold', fontSize: 18 },
  label: { color: c.mutedForeground, fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  note: { color: c.mutedForeground, fontFamily: 'Inter_400Regular', fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, backgroundColor: c.muted },
  chipActive: { backgroundColor: c.primary },
  chipText: { color: c.foreground, fontFamily: 'Inter_500Medium', fontSize: 13 },
  chipTextActive: { color: c.primaryForeground },
  input: { height: 46, borderRadius: 12, borderWidth: 1, borderColor: c.input, backgroundColor: c.card, color: c.foreground, paddingHorizontal: 14, fontSize: 16, fontFamily: 'Inter_400Regular' },
  primary: { height: 50, borderRadius: 14, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
});

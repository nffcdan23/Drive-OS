import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput,
  Platform, KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { DEMO_DESTINATIONS, SCENIC_ROUTES } from '@/constants/mockData';
import type { Destination } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

type SearchSection = 'recent' | 'saved' | 'scenic' | 'results';

const ICON_MAP: Record<Destination['type'], string> = {
  home: 'home-outline',
  work: 'briefcase-outline',
  favourite: 'star-outline',
  recent: 'time-outline',
  scenic: 'triangle-outline',
  search: 'location-outline',
};

export default function SearchScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeSection, setActiveSection] = useState<SearchSection>('recent');

  const recentDests = DEMO_DESTINATIONS.filter((d) => d.type === 'recent' || d.type === 'home' || d.type === 'work').slice(0, 5);
  const savedDests = DEMO_DESTINATIONS.filter((d) => d.type === 'favourite');

  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return DEMO_DESTINATIONS.filter(
      (d) => d.name.toLowerCase().includes(q) || d.address.toLowerCase().includes(q)
    );
  }, [query]);

  const displaySection: SearchSection = query.trim() ? 'results' : activeSection;

  function handleSelectDestination(dest: Destination) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
    // In a real app: set destination and start route planning
  }

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    searchHeader: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top + 8,
      paddingHorizontal: 16, paddingBottom: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
      flexDirection: 'row', alignItems: 'center', gap: 10,
    },
    searchInputWrap: {
      flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 12,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, height: 46,
    },
    searchInput: {
      flex: 1, fontSize: 16, color: colors.foreground, fontFamily: 'Inter_400Regular',
    },
    cancelBtn: { paddingVertical: 8 },
    cancelBtnText: { fontSize: 15, color: colors.primary, fontFamily: 'Inter_500Medium' },
    sectionTabs: {
      flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, gap: 8,
    },
    sectionTab: {
      paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
      borderWidth: 1, borderColor: colors.border,
    },
    sectionTabActive: { borderColor: colors.primary, backgroundColor: colors.primary + '15' },
    sectionTabText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    sectionTabTextActive: { color: colors.primary },
    sectionHeader: {
      paddingHorizontal: 20, paddingVertical: 10,
      fontSize: 13, fontWeight: '600', color: colors.mutedForeground,
      fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 0.5,
    },
    destItem: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingHorizontal: 20, paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    destIconWrap: {
      width: 38, height: 38, borderRadius: 19,
      backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center',
    },
    destName: { fontSize: 15, fontWeight: '500', color: colors.foreground, fontFamily: 'Inter_500Medium' },
    destAddress: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 1 },
    scenicCard: {
      marginHorizontal: 20, marginBottom: 10, backgroundColor: colors.card,
      borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    scenicIconWrap: {
      width: 42, height: 42, borderRadius: 21,
      backgroundColor: colors.primary + '15', alignItems: 'center', justifyContent: 'center',
    },
    scenicName: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    scenicMeta: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    emptyText: { textAlign: 'center', color: colors.mutedForeground, marginTop: 40, fontFamily: 'Inter_400Regular' },
    listContent: { paddingBottom: (Platform.OS === 'web' ? 34 : insets.bottom) + 20 },
    demoNote: {
      marginHorizontal: 20, marginTop: 8, padding: 10, backgroundColor: colors.muted,
      borderRadius: 10,
    },
    demoNoteText: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  });

  function DestRow({ item }: { item: Destination }) {
    return (
      <TouchableOpacity style={styles.destItem} onPress={() => handleSelectDestination(item)}>
        <View style={styles.destIconWrap}>
          <Ionicons name={ICON_MAP[item.type] as any} size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.destName}>{item.name}</Text>
          <Text style={styles.destAddress}>{item.address}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
      </TouchableOpacity>
    );
  }

  function renderContent() {
    if (displaySection === 'results') {
      return (
        <>
          <Text style={styles.sectionHeader}>Results ({searchResults.length})</Text>
          {searchResults.length === 0
            ? <Text style={styles.emptyText}>No results for "{query}"</Text>
            : searchResults.map((d) => <DestRow key={d.id} item={d} />)
          }
          <View style={styles.demoNote}>
            <Text style={styles.demoNoteText}>Demo search — connect a Places API for live results</Text>
          </View>
        </>
      );
    }
    if (displaySection === 'recent') {
      return (
        <>
          <Text style={styles.sectionHeader}>Recent & Saved</Text>
          {recentDests.map((d) => <DestRow key={d.id} item={d} />)}
        </>
      );
    }
    if (displaySection === 'saved') {
      return (
        <>
          <Text style={styles.sectionHeader}>Favourites</Text>
          {savedDests.length === 0
            ? <Text style={styles.emptyText}>No saved places yet</Text>
            : savedDests.map((d) => <DestRow key={d.id} item={d} />)
          }
        </>
      );
    }
    if (displaySection === 'scenic') {
      return (
        <>
          <Text style={styles.sectionHeader}>Scenic Routes</Text>
          {SCENIC_ROUTES.map((route) => (
            <TouchableOpacity key={route.id} style={styles.scenicCard} onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.back();
            }}>
              <View style={styles.scenicIconWrap}>
                <Ionicons name="triangle-outline" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.scenicName}>{route.name}</Text>
                <Text style={styles.scenicMeta}>{route.distance} · {route.description}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          ))}
        </>
      );
    }
    return null;
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.searchHeader}>
        <View style={styles.searchInputWrap}>
          <Ionicons name="search" size={18} color={colors.mutedForeground} />
          <TextInput
            style={styles.searchInput}
            placeholder="Where are we going?"
            placeholderTextColor={colors.mutedForeground}
            value={query}
            onChangeText={setQuery}
            autoFocus
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>

      {!query.trim() && (
        <View style={styles.sectionTabs}>
          {(['recent', 'saved', 'scenic'] as const).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.sectionTab, activeSection === tab && styles.sectionTabActive]}
              onPress={() => setActiveSection(tab)}
            >
              <Text style={[styles.sectionTabText, activeSection === tab && styles.sectionTabTextActive]}>
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <FlatList
        data={[null]}
        renderItem={() => <View contentContainerStyle={styles.listContent}>{renderContent()}</View>}
        keyExtractor={() => 'content'}
        keyboardShouldPersistTaps="handled"
      />
    </KeyboardAvoidingView>
  );
}

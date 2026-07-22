import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

type GroupTab = 'feed' | 'members' | 'events' | 'convoys';

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { groups, leaveGroup, events } = useApp();
  const [activeTab, setActiveTab] = useState<GroupTab>('feed');

  const group = groups.find((g) => g.id === id);
  const groupEvents = events.filter((e) => e.groupId === id);

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
    heroCard: {
      margin: 20, backgroundColor: colors.card, borderRadius: 18, padding: 20,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    groupName: { fontSize: 22, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginBottom: 4 },
    groupMeta: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginBottom: 2 },
    groupDesc: { fontSize: 14, color: colors.foreground, fontFamily: 'Inter_400Regular', lineHeight: 20, marginTop: 10 },
    roleBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      backgroundColor: colors.primary + '15', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5,
      alignSelf: 'flex-start', marginTop: 12,
    },
    roleBadgeText: { fontSize: 12, color: colors.primary, fontFamily: 'Inter_600SemiBold' },
    tabRow: {
      flexDirection: 'row', paddingHorizontal: 20, paddingBottom: 4,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
      gap: 4,
    },
    tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -StyleSheet.hairlineWidth },
    tabActive: { borderBottomColor: colors.primary },
    tabText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    tabTextActive: { color: colors.primary, fontFamily: 'Inter_600SemiBold' },
    content: { flex: 1, paddingBottom: (Platform.OS === 'web' ? 84 : insets.bottom + 50) + 16 },
    postCard: {
      marginHorizontal: 20, marginTop: 14, backgroundColor: colors.card,
      borderRadius: 14, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    postHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
    postAvatar: {
      width: 34, height: 34, borderRadius: 17, backgroundColor: colors.muted,
      alignItems: 'center', justifyContent: 'center',
    },
    postAuthor: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    postTime: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    postBody: { fontSize: 14, color: colors.foreground, fontFamily: 'Inter_400Regular', lineHeight: 20 },
    memberCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingHorizontal: 20, paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    memberAvatar: {
      width: 42, height: 42, borderRadius: 21, backgroundColor: colors.muted,
      alignItems: 'center', justifyContent: 'center',
    },
    memberName: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    memberRole: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    emptyBox: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 40 },
    emptyText: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center', fontFamily: 'Inter_400Regular', marginTop: 10 },
    leaveBtn: {
      marginHorizontal: 20, marginTop: 20, paddingVertical: 13, borderRadius: 14,
      borderWidth: 1, borderColor: colors.destructive, alignItems: 'center',
    },
    leaveBtnText: { fontSize: 15, color: colors.destructive, fontFamily: 'Inter_500Medium' },
    privacyNote: {
      marginHorizontal: 20, marginTop: 12, padding: 12, backgroundColor: colors.muted, borderRadius: 10,
    },
    privacyNoteText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', lineHeight: 18 },
  });

  if (!group) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Ionicons name="shield-outline" size={48} color={colors.mutedForeground} />
        <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: '600', marginTop: 12, fontFamily: 'Inter_600SemiBold' }}>Group not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontFamily: 'Inter_500Medium' }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Mock posts for demo
  const MOCK_POSTS = [
    { id: 'p1', author: 'Sarah T.', initials: 'ST', time: '2h ago', body: 'Great turnout at last Sunday\'s meet — see you all at the Grasmere run next weekend 🚗' },
    { id: 'p2', author: 'Mike R.', initials: 'MR', time: '1d ago', body: 'Reminder: track day spaces are filling up. Get your name in before Thursday.' },
  ];

  // Mock members for demo
  const MOCK_MEMBERS = [
    { id: 'm1', name: 'Sarah T.', initials: 'ST', role: 'Administrator' },
    { id: 'm2', name: 'Mike R.', initials: 'MR', role: 'Verified Member' },
    { id: 'm3', name: 'James H.', initials: 'JH', role: 'Member' },
    { id: 'm4', name: 'Emma K.', initials: 'EK', role: 'Member' },
  ];

  const canEdit = group.myRole === 'owner' || group.myRole === 'admin';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{group.name}</Text>
        {canEdit && (
          <TouchableOpacity>
            <Ionicons name="settings-outline" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>

      {/* Hero info */}
      <View style={styles.heroCard}>
        <Text style={styles.groupName}>{group.name}</Text>
        <Text style={styles.groupMeta}>{group.primaryLocation} · {group.memberCount} members</Text>
        <Text style={styles.groupMeta}>{group.vehicleInterests} · {group.isPublic ? 'Public Group' : 'Private Group'}</Text>
        <Text style={styles.groupDesc}>{group.description}</Text>
        {group.myRole && (
          <View style={styles.roleBadge}>
            <Ionicons name="checkmark-circle" size={13} color={colors.primary} />
            <Text style={styles.roleBadgeText}>{group.myRole.charAt(0).toUpperCase() + group.myRole.replace('_', ' ').slice(1)}</Text>
          </View>
        )}
      </View>

      {/* Tab bar */}
      <View style={styles.tabRow}>
        {(['feed', 'members', 'events', 'convoys'] as GroupTab[]).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, activeTab === t && styles.tabActive]} onPress={() => setActiveTab(t)}>
            <Text style={[styles.tabText, activeTab === t && styles.tabTextActive]}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {activeTab === 'feed' && (
          <>
            {!group.isPublic && (
              <View style={styles.privacyNote}>
                <Text style={styles.privacyNoteText}>
                  This feed is visible to group members only. Posts are not publicly discoverable.
                </Text>
              </View>
            )}
            {MOCK_POSTS.map((post) => (
              <View key={post.id} style={styles.postCard}>
                <View style={styles.postHeader}>
                  <View style={styles.postAvatar}><Text style={{ fontSize: 12, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' }}>{post.initials}</Text></View>
                  <View>
                    <Text style={styles.postAuthor}>{post.author}</Text>
                    <Text style={styles.postTime}>{post.time}</Text>
                  </View>
                </View>
                <Text style={styles.postBody}>{post.body}</Text>
              </View>
            ))}
          </>
        )}

        {activeTab === 'members' && (
          <>
            <View style={styles.privacyNote}>
              <Text style={styles.privacyNoteText}>
                Member directory is opt-in. Only members who have chosen to appear are shown here.
              </Text>
            </View>
            {MOCK_MEMBERS.map((m) => (
              <View key={m.id} style={styles.memberCard}>
                <View style={styles.memberAvatar}><Text style={{ fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' }}>{m.initials}</Text></View>
                <View>
                  <Text style={styles.memberName}>{m.name}</Text>
                  <Text style={styles.memberRole}>{m.role}</Text>
                </View>
              </View>
            ))}
          </>
        )}

        {activeTab === 'events' && (
          groupEvents.length === 0
            ? <View style={styles.emptyBox}><Ionicons name="calendar-outline" size={40} color={colors.mutedForeground} /><Text style={styles.emptyText}>No events from this group yet.</Text></View>
            : groupEvents.map((e) => (
                <TouchableOpacity key={e.id} style={styles.postCard} onPress={() => router.push(`/event/${e.id}`)}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' }}>{e.name}</Text>
                  <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 3 }}>{e.date} · {e.startTime} · {e.location}</Text>
                </TouchableOpacity>
              ))
        )}

        {activeTab === 'convoys' && (
          <View style={styles.emptyBox}>
            <Ionicons name="car-sport-outline" size={40} color={colors.mutedForeground} />
            <Text style={styles.emptyText}>Group convoys will appear here once created by admins.</Text>
          </View>
        )}

        {/* Leave group */}
        {group.isMember && group.myRole !== 'owner' && (
          <TouchableOpacity style={styles.leaveBtn} onPress={() => {
            Alert.alert('Leave Group', `Leave ${group.name}?`, [
              { text: 'Stay', style: 'cancel' },
              { text: 'Leave', style: 'destructive', onPress: () => { leaveGroup(group.id); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); router.back(); } },
            ]);
          }}>
            <Text style={styles.leaveBtnText}>Leave Group</Text>
          </TouchableOpacity>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

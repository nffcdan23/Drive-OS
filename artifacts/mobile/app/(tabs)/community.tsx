import React, { useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Platform, ScrollView,
  TextInput, Modal, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { MOCK_FRIENDS, MOCK_CONVOYS } from '@/constants/mockData';
import type { Friend, Convoy } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

const STATUS_COLOR: Record<Friend['status'], string> = {
  online: '#22c55e',
  driving: '#F4631A',
  offline: '#9ca3af',
};

const STATUS_LABEL: Record<Friend['status'], string> = {
  online: 'Online',
  driving: 'Driving',
  offline: 'Offline',
};

export default function CommunityScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [friends] = useState<Friend[]>(MOCK_FRIENDS);
  const [convoys, setConvoys] = useState<Convoy[]>(MOCK_CONVOYS);
  const [activeTab, setActiveTab] = useState<'friends' | 'convoys'>('convoys');
  const [showCreateConvoy, setShowCreateConvoy] = useState(false);
  const [newConvoy, setNewConvoy] = useState({ name: '', destination: '', isPrivate: false });

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top + 16,
      paddingHorizontal: 20, paddingBottom: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    headerTitle: { fontSize: 28, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    tabRow: { flexDirection: 'row', gap: 0, marginHorizontal: 20, marginTop: 16, marginBottom: 4,
      backgroundColor: colors.muted, borderRadius: 12, padding: 4 },
    tab: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center' },
    tabActive: { backgroundColor: colors.card },
    tabText: { fontSize: 14, fontWeight: '500', color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    tabTextActive: { color: colors.foreground, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
    sectionHeader: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8,
    },
    sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    createBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: colors.primary, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6,
    },
    createBtnText: { fontSize: 13, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    friendCard: {
      marginHorizontal: 20, marginBottom: 8, backgroundColor: colors.card,
      borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    avatar: {
      width: 46, height: 46, borderRadius: 23,
      backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center',
    },
    avatarText: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    friendName: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    statusDot: { width: 7, height: 7, borderRadius: 4 },
    statusText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    locationText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', flex: 1, textAlign: 'right' },
    inviteBtn: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5,
    },
    inviteBtnText: { fontSize: 12, color: colors.foreground, fontFamily: 'Inter_500Medium' },
    convoyCard: {
      marginHorizontal: 20, marginBottom: 12, backgroundColor: colors.card,
      borderRadius: 16, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    convoyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    convoyName: { fontSize: 16, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', flex: 1 },
    privateTag: {
      backgroundColor: colors.muted, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
    },
    privateTagText: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    convoyMeta: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 4 },
    convoyDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 10 },
    convoyStats: { flexDirection: 'row', gap: 16 },
    convoyStatItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    convoyStatText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    joinBtn: {
      marginTop: 12, paddingVertical: 10, borderRadius: 10,
      backgroundColor: colors.primary, alignItems: 'center',
    },
    joinBtnText: { fontSize: 14, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    content: { flex: 1, paddingBottom: (Platform.OS === 'web' ? 84 : insets.bottom + 50) + 16 },
    // Modal styles
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalContent: {
      backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
      padding: 24, paddingBottom: Math.max(insets.bottom, 16) + 16,
    },
    modalHandle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    modalTitle: { fontSize: 20, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginBottom: 20 },
    inputLabel: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginBottom: 6 },
    input: {
      backgroundColor: colors.muted, borderRadius: 12, padding: 14,
      fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular',
      marginBottom: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    toggleLabel: { fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular' },
    toggleBtn: {
      width: 50, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.border,
      padding: 2, justifyContent: 'center',
    },
    toggleBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    toggleThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.mutedForeground },
    toggleThumbActive: { backgroundColor: '#fff', alignSelf: 'flex-end' },
    submitBtn: {
      backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center',
    },
    submitBtnText: { fontSize: 16, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
  });

  function handleCreateConvoy() {
    if (!newConvoy.name.trim() || !newConvoy.destination.trim()) {
      Alert.alert('Missing info', 'Please enter a convoy name and destination.');
      return;
    }
    const convoy: Convoy = {
      id: Date.now().toString(),
      name: newConvoy.name,
      leaderId: 'me',
      leaderName: 'You',
      destination: newConvoy.destination,
      driverCount: 1,
      isPrivate: newConvoy.isPrivate,
      startTime: new Date(Date.now() + 3600000).toISOString(),
      status: 'forming',
      description: '',
    };
    setConvoys((prev) => [convoy, ...prev]);
    setNewConvoy({ name: '', destination: '', isPrivate: false });
    setShowCreateConvoy(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function FriendRow({ item }: { item: Friend }) {
    return (
      <View style={styles.friendCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{item.initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.friendName}>{item.name}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: STATUS_COLOR[item.status] }]} />
            <Text style={styles.statusText}>{STATUS_LABEL[item.status]}</Text>
            {item.location ? <Text style={styles.locationText}>{item.location}</Text> : null}
          </View>
        </View>
        <TouchableOpacity style={styles.inviteBtn}
          onPress={() => Alert.alert('Convoy Invite', `Invite ${item.name} to your convoy?`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Invite', onPress: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light) },
          ])}>
          <Text style={styles.inviteBtnText}>Invite</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function ConvoyCard({ item }: { item: Convoy }) {
    const startDate = new Date(item.startTime);
    return (
      <View style={styles.convoyCard}>
        <View style={styles.convoyHeader}>
          <Text style={styles.convoyName}>{item.name}</Text>
          {item.isPrivate && <View style={styles.privateTag}><Text style={styles.privateTagText}>Private</Text></View>}
        </View>
        <Text style={styles.convoyMeta}>Led by {item.leaderName} · {item.destination}</Text>
        <View style={styles.convoyDivider} />
        <View style={styles.convoyStats}>
          <View style={styles.convoyStatItem}>
            <Ionicons name="people-outline" size={14} color={colors.mutedForeground} />
            <Text style={styles.convoyStatText}>{item.driverCount} drivers</Text>
          </View>
          <View style={styles.convoyStatItem}>
            <Ionicons name="time-outline" size={14} color={colors.mutedForeground} />
            <Text style={styles.convoyStatText}>
              {startDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} {startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        </View>
        <TouchableOpacity style={styles.joinBtn} onPress={() => {
          Alert.alert('Join Convoy', `Join "${item.name}"?`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Join', onPress: () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); Alert.alert('Joined!', 'You\'ve joined the convoy.'); } },
          ]);
        }}>
          <Text style={styles.joinBtnText}>Join Convoy</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Community</Text>
      </View>

      <View style={styles.tabRow}>
        <TouchableOpacity style={[styles.tab, activeTab === 'convoys' && styles.tabActive]} onPress={() => setActiveTab('convoys')}>
          <Text style={[styles.tabText, activeTab === 'convoys' && styles.tabTextActive]}>Convoys</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, activeTab === 'friends' && styles.tabActive]} onPress={() => setActiveTab('friends')}>
          <Text style={[styles.tabText, activeTab === 'friends' && styles.tabTextActive]}>Friends</Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'convoys' ? (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Active Convoys</Text>
            <TouchableOpacity style={styles.createBtn} onPress={() => setShowCreateConvoy(true)}>
              <Ionicons name="add" size={14} color="#fff" />
              <Text style={styles.createBtnText}>Create</Text>
            </TouchableOpacity>
          </View>
          {convoys.map((c) => <ConvoyCard key={c.id} item={c} />)}
        </ScrollView>
      ) : (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Friends · {friends.length}</Text>
          </View>
          {friends.map((f) => <FriendRow key={f.id} item={f} />)}
        </ScrollView>
      )}

      <Modal visible={showCreateConvoy} transparent animationType="slide" onRequestClose={() => setShowCreateConvoy(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Create Convoy</Text>
            <Text style={styles.inputLabel}>Convoy Name</Text>
            <TextInput
              style={styles.input} placeholder="e.g. Sunday Scenic Run"
              placeholderTextColor={colors.mutedForeground}
              value={newConvoy.name}
              onChangeText={(t) => setNewConvoy((p) => ({ ...p, name: t }))}
            />
            <Text style={styles.inputLabel}>Destination</Text>
            <TextInput
              style={styles.input} placeholder="e.g. Kirkstone Pass Inn"
              placeholderTextColor={colors.mutedForeground}
              value={newConvoy.destination}
              onChangeText={(t) => setNewConvoy((p) => ({ ...p, destination: t }))}
            />
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Private convoy</Text>
              <TouchableOpacity
                style={[styles.toggleBtn, newConvoy.isPrivate && styles.toggleBtnActive]}
                onPress={() => setNewConvoy((p) => ({ ...p, isPrivate: !p.isPrivate }))}>
                <View style={[styles.toggleThumb, newConvoy.isPrivate && styles.toggleThumbActive]} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.submitBtn} onPress={handleCreateConvoy}>
              <Text style={styles.submitBtnText}>Create Convoy</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, ScrollView,
  TextInput, Modal, Alert, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp, Friend, Convoy, Group, DriveOSEvent, EventType } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

const STATUS_COLOR: Record<Friend['status'], string> = {
  online: '#22c55e', driving: '#F4631A', offline: '#9ca3af',
};
const STATUS_LABEL: Record<Friend['status'], string> = {
  online: 'Online', driving: 'Driving', offline: 'Offline',
};

const EVENT_TYPE_LABELS: Record<EventType, string> = {
  static_car_meet: 'Car Meet', scenic_drive: 'Scenic Drive', convoy: 'Convoy',
  road_trip: 'Road Trip', show: 'Show / Exhibition', track_day: 'Track Day',
  closed_course: 'Closed Course', charity: 'Charity Event', photography: 'Photography Meet',
  owner_club: 'Owner Club Meet', other: 'Other',
};

const CONVOY_SECTIONS = [
  { key: 'my', label: 'My Convoys' },
  { key: 'joined', label: 'Joined' },
  { key: 'public', label: 'Public' },
] as const;

type CommunityTab = 'convoys' | 'friends' | 'groups' | 'events';
type ConvoySection = 'my' | 'joined' | 'public';

export default function CommunityScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    friends, friendRequests, sendFriendRequest, acceptFriendRequest, declineFriendRequest,
    removeFriend, blockUser,
    convoys, addConvoy, deleteConvoy, joinConvoy, leaveConvoy,
    groups, addGroup, joinGroup,
    events, addEvent, rsvpEvent,
    conversations, startConversation,
    userProfile,
  } = useApp();

  const [activeTab, setActiveTab] = useState<CommunityTab>('convoys');
  const [convoySection, setConvoySection] = useState<ConvoySection>('public');

  // Convoy create
  const [showCreateConvoy, setShowCreateConvoy] = useState(false);
  const [newConvoy, setNewConvoy] = useState({
    name: '', destination: '', description: '', startTime: '', maxParticipants: '12',
    isPrivate: false, privacyMethod: 'invite_only' as Convoy['privacyMethod'],
  });

  // Group create
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroup, setNewGroup] = useState({
    name: '', description: '', primaryLocation: '', vehicleInterests: '',
    isPublic: true, membershipMethod: 'open' as Group['membershipMethod'],
  });

  // Event create
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  const [newEvent, setNewEvent] = useState({
    name: '', description: '', location: '', date: '', startTime: '', endTime: '',
    eventType: 'static_car_meet' as EventType, isPublic: true, vehicleCategory: 'Open to All', entryCost: 'Free',
  });

  // Friend search
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [friendSearch, setFriendSearch] = useState('');

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
    addBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: colors.primary, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6,
    },
    addBtnText: { fontSize: 13, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    tabRow: {
      flexDirection: 'row', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4,
      backgroundColor: colors.background, gap: 4,
    },
    tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
    tabActive: { borderBottomColor: colors.primary },
    tabText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    tabTextActive: { color: colors.primary, fontFamily: 'Inter_600SemiBold' },
    content: { flex: 1, paddingBottom: (Platform.OS === 'web' ? 84 : insets.bottom + 50) + 16 },
    // Section pills (for convoys)
    sectionRow: {
      flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingVertical: 12,
    },
    sectionPill: {
      paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
      borderWidth: 1, borderColor: colors.border,
    },
    sectionPillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    sectionPillText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    sectionPillTextActive: { color: '#fff' },
    sectionHeader: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8,
    },
    sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    // Cards
    card: {
      marginHorizontal: 20, marginBottom: 10, backgroundColor: colors.card,
      borderRadius: 16, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    cardActiveConvoy: { borderColor: colors.primary, borderWidth: 1 },
    convoyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    convoyName: { fontSize: 16, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', flex: 1 },
    tag: {
      paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
      backgroundColor: colors.muted,
    },
    tagText: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    privateTagText: { color: colors.primary },
    cardMeta: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 4 },
    cardDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 10 },
    statRow: { flexDirection: 'row', gap: 16 },
    statItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    statText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    actionRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    primaryBtn: {
      flex: 1, paddingVertical: 10, borderRadius: 10,
      backgroundColor: colors.primary, alignItems: 'center',
    },
    primaryBtnText: { fontSize: 14, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    secondaryBtn: {
      paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10,
      borderWidth: 1, borderColor: colors.border, alignItems: 'center',
    },
    secondaryBtnText: { fontSize: 14, color: colors.foreground, fontFamily: 'Inter_500Medium' },
    destructiveBtn: { borderColor: colors.destructive },
    destructiveBtnText: { color: colors.destructive },
    // Friends
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
    locationText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    friendActions: { marginLeft: 'auto', flexDirection: 'row', gap: 6 },
    iconAction: { padding: 6, borderRadius: 8, backgroundColor: colors.muted },
    // Groups
    groupCard: {
      marginHorizontal: 20, marginBottom: 10, backgroundColor: colors.card,
      borderRadius: 16, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    groupName: { fontSize: 16, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    groupMeta: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 4 },
    memberBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: colors.primary + '15', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
      alignSelf: 'flex-start', marginTop: 8,
    },
    memberBadgeText: { fontSize: 11, color: colors.primary, fontFamily: 'Inter_500Medium' },
    // Events
    eventCard: {
      marginHorizontal: 20, marginBottom: 10, backgroundColor: colors.card,
      borderRadius: 16, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    eventName: { fontSize: 16, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    eventMeta: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 3 },
    rsvpRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    rsvpBtn: {
      flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center',
      borderWidth: 1, borderColor: colors.border,
    },
    rsvpBtnGoing: { backgroundColor: colors.primary, borderColor: colors.primary },
    rsvpBtnInterested: { borderColor: colors.primary, backgroundColor: colors.primary + '15' },
    rsvpBtnText: { fontSize: 13, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    rsvpBtnTextGoing: { color: '#fff' },
    rsvpBtnTextInterested: { color: colors.primary },
    emptyBox: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 40 },
    emptyText: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center', fontFamily: 'Inter_400Regular', marginTop: 10 },
    // Modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalContent: {
      backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
      padding: 24, paddingBottom: Math.max(insets.bottom, 16) + 16,
    },
    modalHandle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    modalTitle: { fontSize: 20, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginBottom: 20 },
    inputLabel: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginBottom: 6, marginTop: 12 },
    input: {
      backgroundColor: colors.muted, borderRadius: 12, padding: 14,
      fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular',
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 4 },
    toggleLabel: { fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular' },
    privacyNote: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 4, marginBottom: 12 },
    privacyOptionRow: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 12 },
    privacyOption: {
      flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center',
      borderWidth: 1, borderColor: colors.border,
    },
    privacyOptionActive: { borderColor: colors.primary, backgroundColor: colors.primary + '15' },
    privacyOptionText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    privacyOptionTextActive: { color: colors.primary },
    submitBtn: {
      backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14,
      alignItems: 'center', marginTop: 20,
    },
    submitBtnText: { fontSize: 16, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
  });

  // ── Create handlers ──

  function handleCreateConvoy() {
    if (!newConvoy.name.trim() || !newConvoy.destination.trim()) {
      Alert.alert('Missing info', 'Please enter a convoy name and destination.');
      return;
    }
    addConvoy({
      name: newConvoy.name,
      leaderId: 'me', leaderName: userProfile.name,
      destination: newConvoy.destination,
      description: newConvoy.description,
      driverCount: 1,
      isPrivate: newConvoy.isPrivate,
      startTime: newConvoy.startTime || new Date(Date.now() + 3600000).toISOString(),
      status: 'forming',
      maxParticipants: parseInt(newConvoy.maxParticipants, 10) || 12,
      privacyMethod: newConvoy.isPrivate ? newConvoy.privacyMethod : undefined,
      isOwn: true,
      isJoined: true,
    });
    setNewConvoy({ name: '', destination: '', description: '', startTime: '', maxParticipants: '12', isPrivate: false, privacyMethod: 'invite_only' });
    setShowCreateConvoy(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleDeleteConvoy(convoy: Convoy) {
    Alert.alert('Cancel Convoy', `Cancel "${convoy.name}"? Joined participants will be notified.`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel Convoy', style: 'destructive', onPress: () => {
          deleteConvoy(convoy.id);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        },
      },
    ]);
  }

  function handleCreateGroup() {
    if (!newGroup.name.trim()) { Alert.alert('Missing info', 'Please enter a group name.'); return; }
    addGroup({
      name: newGroup.name, description: newGroup.description,
      logoUri: null, isPublic: newGroup.isPublic,
      primaryLocation: newGroup.primaryLocation,
      vehicleInterests: newGroup.vehicleInterests,
      membershipMethod: newGroup.membershipMethod,
    });
    setNewGroup({ name: '', description: '', primaryLocation: '', vehicleInterests: '', isPublic: true, membershipMethod: 'open' });
    setShowCreateGroup(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleCreateEvent() {
    if (!newEvent.name.trim() || !newEvent.location.trim()) {
      Alert.alert('Missing info', 'Please enter an event name and location.');
      return;
    }
    addEvent({
      name: newEvent.name, description: newEvent.description,
      coverUri: null, location: newEvent.location,
      date: newEvent.date || new Date().toISOString().split('T')[0],
      startTime: newEvent.startTime || '10:00', endTime: newEvent.endTime || '13:00',
      eventType: newEvent.eventType, isPublic: newEvent.isPublic,
      groupId: null, capacity: 50, organiser: userProfile.name,
      vehicleCategory: newEvent.vehicleCategory, entryCost: newEvent.entryCost,
    });
    setNewEvent({ name: '', description: '', location: '', date: '', startTime: '', endTime: '', eventType: 'static_car_meet', isPublic: true, vehicleCategory: 'Open to All', entryCost: 'Free' });
    setShowCreateEvent(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleRemoveFriend(f: Friend) {
    Alert.alert('Remove Friend', `Remove ${f.name} from your friends?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { removeFriend(f.id); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } },
    ]);
  }

  // ── Render helpers ──

  const myConvoys = convoys.filter((c) => c.isOwn);
  const joinedConvoys = convoys.filter((c) => c.isJoined && !c.isOwn);
  const publicConvoys = convoys.filter((c) => !c.isPrivate && !c.isOwn && !c.isJoined);
  const pendingRequests = friendRequests.filter((r) => r.isIncoming && r.status === 'pending');

  function ConvoyCard({ convoy }: { convoy: Convoy }) {
    const startDate = new Date(convoy.startTime);
    const isOwn = convoy.isOwn;
    const isJoined = convoy.isJoined;
    return (
      <View style={[styles.card, isJoined && styles.cardActiveConvoy]}>
        <View style={styles.convoyHeader}>
          <Text style={styles.convoyName}>{convoy.name}</Text>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {convoy.isPrivate && <View style={styles.tag}><Text style={[styles.tagText, styles.privateTagText]}>Private</Text></View>}
            {isOwn && <View style={[styles.tag, { backgroundColor: colors.primary + '15' }]}><Text style={[styles.tagText, { color: colors.primary }]}>Yours</Text></View>}
            {isJoined && !isOwn && <View style={[styles.tag, { backgroundColor: '#22c55e20' }]}><Text style={[styles.tagText, { color: '#22c55e' }]}>Joined</Text></View>}
          </View>
        </View>
        <Text style={styles.cardMeta}>Led by {convoy.leaderName} · {convoy.destination}</Text>
        {convoy.description ? <Text style={[styles.cardMeta, { marginTop: 2 }]}>{convoy.description}</Text> : null}
        <View style={styles.cardDivider} />
        <View style={styles.statRow}>
          <View style={styles.statItem}>
            <Ionicons name="people-outline" size={14} color={colors.mutedForeground} />
            <Text style={styles.statText}>{convoy.driverCount}{convoy.maxParticipants ? `/${convoy.maxParticipants}` : ''} drivers</Text>
          </View>
          <View style={styles.statItem}>
            <Ionicons name="time-outline" size={14} color={colors.mutedForeground} />
            <Text style={styles.statText}>
              {startDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} {startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        </View>
        <View style={styles.actionRow}>
          {isOwn ? (
            <TouchableOpacity style={[styles.secondaryBtn, styles.destructiveBtn, { flex: 1 }]} onPress={() => handleDeleteConvoy(convoy)}>
              <Text style={[styles.secondaryBtnText, styles.destructiveBtnText]}>Cancel Convoy</Text>
            </TouchableOpacity>
          ) : isJoined ? (
            <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={() => {
              Alert.alert('Leave Convoy', `Leave "${convoy.name}"?`, [
                { text: 'Stay', style: 'cancel' },
                { text: 'Leave', style: 'destructive', onPress: () => leaveConvoy(convoy.id) },
              ]);
            }}>
              <Text style={styles.secondaryBtnText}>Leave</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.primaryBtn} onPress={() => {
              Alert.alert('Join Convoy', `Join "${convoy.name}"?`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Join', onPress: () => { joinConvoy(convoy.id); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } },
              ]);
            }}>
              <Text style={styles.primaryBtnText}>Join Convoy</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  function FriendRow({ item }: { item: Friend }) {
    return (
      <View style={styles.friendCard}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{item.initials}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.friendName}>{item.name}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: STATUS_COLOR[item.status] }]} />
            <Text style={styles.statusText}>{STATUS_LABEL[item.status]}</Text>
            {item.location ? <Text style={[styles.locationText, { marginLeft: 6 }]}>{item.location}</Text> : null}
          </View>
        </View>
        <View style={styles.friendActions}>
          <TouchableOpacity style={styles.iconAction} onPress={() => {
            const convId = startConversation(item.id, item.name, item.initials);
            router.push(`/conversation/${convId}`);
          }}>
            <Ionicons name="chatbubble-outline" size={16} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconAction} onPress={() => handleRemoveFriend(item)}>
            <Ionicons name="person-remove-outline" size={16} color={colors.destructive} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  function GroupCard({ group }: { group: Group }) {
    return (
      <View style={styles.groupCard}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.groupName}>{group.name}</Text>
            <Text style={styles.groupMeta}>{group.primaryLocation} · {group.memberCount} members · {group.vehicleInterests}</Text>
            <Text style={[styles.groupMeta, { marginTop: 4, lineHeight: 18 }]}>{group.description}</Text>
          </View>
          <View style={[styles.tag, { marginLeft: 8 }]}>
            <Text style={styles.tagText}>{group.isPublic ? 'Public' : 'Private'}</Text>
          </View>
        </View>
        {group.isMember && (
          <View style={styles.memberBadge}>
            <Ionicons name="checkmark-circle" size={13} color={colors.primary} />
            <Text style={styles.memberBadgeText}>{group.myRole === 'owner' ? 'Owner' : group.myRole === 'admin' ? 'Admin' : 'Member'}</Text>
          </View>
        )}
        <View style={styles.actionRow}>
          {!group.isMember ? (
            <TouchableOpacity style={styles.primaryBtn} onPress={() => {
              if (group.membershipMethod === 'open') {
                joinGroup(group.id);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                Alert.alert('Joined!', `You've joined ${group.name}.`);
              } else if (group.membershipMethod === 'request') {
                Alert.alert('Request sent', `Your request to join ${group.name} has been sent to the admins.`);
              } else {
                Alert.alert('Invite Only', 'This group requires an invitation from a member.');
              }
            }}>
              <Text style={styles.primaryBtnText}>
                {group.membershipMethod === 'open' ? 'Join Group' : group.membershipMethod === 'request' ? 'Request to Join' : 'Invite Only'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.push(`/group/${group.id}`)}>
              <Text style={styles.secondaryBtnText}>View Group</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  function EventCard({ event }: { event: DriveOSEvent }) {
    const isGoing = event.rsvpStatus === 'going';
    const isInterested = event.rsvpStatus === 'interested';
    return (
      <View style={styles.eventCard}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Text style={[styles.eventName, { flex: 1 }]}>{event.name}</Text>
          <View style={styles.tag}>
            <Text style={styles.tagText}>{EVENT_TYPE_LABELS[event.eventType]}</Text>
          </View>
        </View>
        <Text style={styles.eventMeta}>{event.date} · {event.startTime}–{event.endTime}</Text>
        <Text style={styles.eventMeta}>{event.location}</Text>
        <Text style={[styles.eventMeta, { marginTop: 2 }]}>Organised by {event.organiser} · {event.attendeeCount} attending · {event.entryCost}</Text>
        <View style={styles.rsvpRow}>
          <TouchableOpacity
            style={[styles.rsvpBtn, isGoing && styles.rsvpBtnGoing]}
            onPress={() => { rsvpEvent(event.id, isGoing ? null : 'going'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}>
            <Text style={[styles.rsvpBtnText, isGoing && styles.rsvpBtnTextGoing]}>
              {isGoing ? '✓ Going' : 'Going'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.rsvpBtn, isInterested && styles.rsvpBtnInterested]}
            onPress={() => { rsvpEvent(event.id, isInterested ? null : 'interested'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}>
            <Text style={[styles.rsvpBtnText, isInterested && styles.rsvpBtnTextInterested]}>Interested</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.rsvpBtn} onPress={() => router.push(`/event/${event.id}`)}>
            <Text style={styles.rsvpBtnText}>Details</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const tabHeaderAction = () => {
    if (activeTab === 'convoys') return { label: 'Create', onPress: () => setShowCreateConvoy(true) };
    if (activeTab === 'friends') return { label: 'Add', onPress: () => setShowAddFriend(true) };
    if (activeTab === 'groups') return { label: 'Create', onPress: () => setShowCreateGroup(true) };
    if (activeTab === 'events') return { label: 'Create', onPress: () => setShowCreateEvent(true) };
    return null;
  };
  const action = tabHeaderAction();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Community</Text>
        {action && (
          <TouchableOpacity style={styles.addBtn} onPress={action.onPress}>
            <Ionicons name="add" size={14} color="#fff" />
            <Text style={styles.addBtnText}>{action.label}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Tab bar */}
      <View style={styles.tabRow}>
        {(['convoys', 'friends', 'groups', 'events'] as CommunityTab[]).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, activeTab === t && styles.tabActive]} onPress={() => setActiveTab(t)}>
            <Text style={[styles.tabText, activeTab === t && styles.tabTextActive]}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {t === 'friends' && pendingRequests.length > 0 ? ` (${pendingRequests.length})` : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Convoys tab ── */}
      {activeTab === 'convoys' && (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sectionRow}>
            {CONVOY_SECTIONS.map((s) => (
              <TouchableOpacity key={s.key}
                style={[styles.sectionPill, convoySection === s.key && styles.sectionPillActive]}
                onPress={() => setConvoySection(s.key)}>
                <Text style={[styles.sectionPillText, convoySection === s.key && styles.sectionPillTextActive]}>{s.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {convoySection === 'my' && (
            myConvoys.length === 0
              ? <View style={styles.emptyBox}><Ionicons name="car-sport-outline" size={40} color={colors.mutedForeground} /><Text style={styles.emptyText}>You haven't created any convoys yet. Tap Create to start one.</Text></View>
              : myConvoys.map((c) => <ConvoyCard key={c.id} convoy={c} />)
          )}
          {convoySection === 'joined' && (
            joinedConvoys.length === 0
              ? <View style={styles.emptyBox}><Ionicons name="people-outline" size={40} color={colors.mutedForeground} /><Text style={styles.emptyText}>You haven't joined any convoys yet.</Text></View>
              : joinedConvoys.map((c) => <ConvoyCard key={c.id} convoy={c} />)
          )}
          {convoySection === 'public' && (
            publicConvoys.length === 0
              ? <View style={styles.emptyBox}><Ionicons name="earth-outline" size={40} color={colors.mutedForeground} /><Text style={styles.emptyText}>No public convoys nearby right now.</Text></View>
              : publicConvoys.map((c) => <ConvoyCard key={c.id} convoy={c} />)
          )}
        </ScrollView>
      )}

      {/* ── Friends tab ── */}
      {activeTab === 'friends' && (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {/* Pending requests */}
          {pendingRequests.length > 0 && (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Requests · {pendingRequests.length}</Text>
              </View>
              {pendingRequests.map((req) => (
                <View key={req.id} style={styles.friendCard}>
                  <View style={styles.avatar}><Text style={styles.avatarText}>{req.fromInitials}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.friendName}>{req.fromName}</Text>
                    <Text style={styles.statusText}>Wants to be friends</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <TouchableOpacity style={[styles.primaryBtn, { paddingHorizontal: 14, flex: 0 }]}
                      onPress={() => { acceptFriendRequest(req.id); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }}>
                      <Text style={styles.primaryBtnText}>Accept</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.secondaryBtn]}
                      onPress={() => declineFriendRequest(req.id)}>
                      <Text style={styles.secondaryBtnText}>Decline</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              <View style={{ height: 8 }} />
            </>
          )}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Friends · {friends.length}</Text>
          </View>
          {friends.length === 0
            ? <View style={styles.emptyBox}><Ionicons name="people-outline" size={40} color={colors.mutedForeground} /><Text style={styles.emptyText}>No friends yet. Tap Add to send a friend request.</Text></View>
            : friends.map((f) => <FriendRow key={f.id} item={f} />)
          }
        </ScrollView>
      )}

      {/* ── Groups tab ── */}
      {activeTab === 'groups' && (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {groups.length === 0
            ? <View style={styles.emptyBox}><Ionicons name="shield-outline" size={40} color={colors.mutedForeground} /><Text style={styles.emptyText}>No groups found. Create your own car club or community.</Text></View>
            : groups.map((g) => <GroupCard key={g.id} group={g} />)
          }
        </ScrollView>
      )}

      {/* ── Events tab ── */}
      {activeTab === 'events' && (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {events.length === 0
            ? <View style={styles.emptyBox}><Ionicons name="calendar-outline" size={40} color={colors.mutedForeground} /><Text style={styles.emptyText}>No events nearby. Create one for your community.</Text></View>
            : events.map((e) => <EventCard key={e.id} event={e} />)
          }
        </ScrollView>
      )}

      {/* ── Create Convoy modal ── */}
      <Modal visible={showCreateConvoy} transparent animationType="slide" onRequestClose={() => setShowCreateConvoy(false)}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }} keyboardShouldPersistTaps="handled">
          <View style={[styles.modalOverlay, { position: 'relative', backgroundColor: 'transparent' }]}>
            <View style={styles.modalContent}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Create Convoy</Text>
              <Text style={styles.inputLabel}>Convoy Name *</Text>
              <TextInput style={styles.input} placeholder="e.g. Sunday Scenic Run" placeholderTextColor={colors.mutedForeground} value={newConvoy.name} onChangeText={(t) => setNewConvoy((p) => ({ ...p, name: t }))} />
              <Text style={styles.inputLabel}>Destination *</Text>
              <TextInput style={styles.input} placeholder="e.g. Kirkstone Pass Inn" placeholderTextColor={colors.mutedForeground} value={newConvoy.destination} onChangeText={(t) => setNewConvoy((p) => ({ ...p, destination: t }))} />
              <Text style={styles.inputLabel}>Description</Text>
              <TextInput style={styles.input} placeholder="Optional details about the run…" placeholderTextColor={colors.mutedForeground} value={newConvoy.description} onChangeText={(t) => setNewConvoy((p) => ({ ...p, description: t }))} />
              <Text style={styles.inputLabel}>Max Participants</Text>
              <TextInput style={styles.input} placeholder="12" placeholderTextColor={colors.mutedForeground} value={newConvoy.maxParticipants} onChangeText={(t) => setNewConvoy((p) => ({ ...p, maxParticipants: t }))} keyboardType="numeric" />
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Private convoy</Text>
                <Switch value={newConvoy.isPrivate} onValueChange={(v) => setNewConvoy((p) => ({ ...p, isPrivate: v }))} trackColor={{ true: colors.primary }} />
              </View>
              {newConvoy.isPrivate && (
                <>
                  <Text style={styles.privacyNote}>Choose how participants join this convoy.</Text>
                  <View style={styles.privacyOptionRow}>
                    {(['invite_only', 'passcode', 'group_members'] as const).map((m) => (
                      <TouchableOpacity key={m} style={[styles.privacyOption, newConvoy.privacyMethod === m && styles.privacyOptionActive]}
                        onPress={() => setNewConvoy((p) => ({ ...p, privacyMethod: m }))}>
                        <Text style={[styles.privacyOptionText, newConvoy.privacyMethod === m && styles.privacyOptionTextActive]}>
                          {m === 'invite_only' ? 'Invite Only' : m === 'passcode' ? 'Passcode' : 'Group Only'}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {newConvoy.privacyMethod !== 'invite_only' && newConvoy.privacyMethod !== 'group_members' && (
                    <TextInput style={styles.input} placeholder="Enter a passcode (leave blank for invite-only)" placeholderTextColor={colors.mutedForeground} secureTextEntry />
                  )}
                  <Text style={styles.privacyNote}>If no passcode is entered, the convoy defaults to Invite Only.</Text>
                </>
              )}
              <TouchableOpacity style={styles.submitBtn} onPress={handleCreateConvoy}>
                <Text style={styles.submitBtnText}>Create Convoy</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </Modal>

      {/* ── Add Friend modal ── */}
      <Modal visible={showAddFriend} transparent animationType="slide" onRequestClose={() => setShowAddFriend(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Add Friend</Text>
            <Text style={styles.inputLabel}>Search by username or friend code</Text>
            <TextInput
              style={styles.input} placeholder="e.g. sarah_drives or DRIVE-1234"
              placeholderTextColor={colors.mutedForeground} value={friendSearch}
              onChangeText={setFriendSearch} autoCapitalize="none" autoCorrect={false}
            />
            <Text style={[styles.inputLabel, { marginTop: 16 }]}>Your friend code</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.muted, borderRadius: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.primary, fontFamily: 'Inter_700Bold', flex: 1, letterSpacing: 2 }}>{userProfile.friendCode ?? 'DRIVE-0000'}</Text>
              <TouchableOpacity onPress={() => Alert.alert('Share link', `https://driveos.app/invite/friend/${userProfile.friendCode}`)}>
                <Ionicons name="share-outline" size={20} color={colors.primary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.privacyNote}>Share your code or send a link so friends can find you directly.</Text>
            <TouchableOpacity style={styles.submitBtn} onPress={() => {
              if (!friendSearch.trim()) { Alert.alert('Enter a username or code'); return; }
              sendFriendRequest(friendSearch, friendSearch.slice(0, 2).toUpperCase());
              setFriendSearch('');
              setShowAddFriend(false);
              Alert.alert('Request sent', `Friend request sent to "${friendSearch}".`);
            }}>
              <Text style={styles.submitBtnText}>Send Request</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Create Group modal ── */}
      <Modal visible={showCreateGroup} transparent animationType="slide" onRequestClose={() => setShowCreateGroup(false)}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }} keyboardShouldPersistTaps="handled">
          <View style={[styles.modalOverlay, { position: 'relative', backgroundColor: 'transparent' }]}>
            <View style={styles.modalContent}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Create Group</Text>
              <Text style={styles.inputLabel}>Group Name *</Text>
              <TextInput style={styles.input} placeholder="e.g. Lake District MINI Club" placeholderTextColor={colors.mutedForeground} value={newGroup.name} onChangeText={(t) => setNewGroup((p) => ({ ...p, name: t }))} />
              <Text style={styles.inputLabel}>Description</Text>
              <TextInput style={[styles.input, { minHeight: 70 }]} placeholder="Tell people what this group is about…" placeholderTextColor={colors.mutedForeground} value={newGroup.description} onChangeText={(t) => setNewGroup((p) => ({ ...p, description: t }))} multiline />
              <Text style={styles.inputLabel}>Primary Location</Text>
              <TextInput style={styles.input} placeholder="e.g. Keswick, Cumbria" placeholderTextColor={colors.mutedForeground} value={newGroup.primaryLocation} onChangeText={(t) => setNewGroup((p) => ({ ...p, primaryLocation: t }))} />
              <Text style={styles.inputLabel}>Vehicle Interests</Text>
              <TextInput style={styles.input} placeholder="e.g. MINIs, Classics, Performance" placeholderTextColor={colors.mutedForeground} value={newGroup.vehicleInterests} onChangeText={(t) => setNewGroup((p) => ({ ...p, vehicleInterests: t }))} />
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Public group</Text>
                <Switch value={newGroup.isPublic} onValueChange={(v) => setNewGroup((p) => ({ ...p, isPublic: v }))} trackColor={{ true: colors.primary }} />
              </View>
              <Text style={styles.inputLabel}>Membership</Text>
              <View style={styles.privacyOptionRow}>
                {(['open', 'request', 'invite', 'code'] as const).map((m) => (
                  <TouchableOpacity key={m} style={[styles.privacyOption, newGroup.membershipMethod === m && styles.privacyOptionActive]}
                    onPress={() => setNewGroup((p) => ({ ...p, membershipMethod: m }))}>
                    <Text style={[styles.privacyOptionText, newGroup.membershipMethod === m && styles.privacyOptionTextActive]}>
                      {m === 'open' ? 'Open' : m === 'request' ? 'Request' : m === 'invite' ? 'Invite' : 'Code'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={styles.submitBtn} onPress={handleCreateGroup}>
                <Text style={styles.submitBtnText}>Create Group</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </Modal>

      {/* ── Create Event modal ── */}
      <Modal visible={showCreateEvent} transparent animationType="slide" onRequestClose={() => setShowCreateEvent(false)}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }} keyboardShouldPersistTaps="handled">
          <View style={[styles.modalOverlay, { position: 'relative', backgroundColor: 'transparent' }]}>
            <View style={styles.modalContent}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Create Event</Text>
              <Text style={styles.inputLabel}>Event Name *</Text>
              <TextInput style={styles.input} placeholder="e.g. Sunday Car Meet" placeholderTextColor={colors.mutedForeground} value={newEvent.name} onChangeText={(t) => setNewEvent((p) => ({ ...p, name: t }))} />
              <Text style={styles.inputLabel}>Location *</Text>
              <TextInput style={styles.input} placeholder="Venue name and postcode" placeholderTextColor={colors.mutedForeground} value={newEvent.location} onChangeText={(t) => setNewEvent((p) => ({ ...p, location: t }))} />
              <Text style={styles.inputLabel}>Description</Text>
              <TextInput style={[styles.input, { minHeight: 60 }]} placeholder="Tell attendees what to expect…" placeholderTextColor={colors.mutedForeground} value={newEvent.description} onChangeText={(t) => setNewEvent((p) => ({ ...p, description: t }))} multiline />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>Date</Text>
                  <TextInput style={styles.input} placeholder="2026-08-01" placeholderTextColor={colors.mutedForeground} value={newEvent.date} onChangeText={(t) => setNewEvent((p) => ({ ...p, date: t }))} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>Start</Text>
                  <TextInput style={styles.input} placeholder="10:00" placeholderTextColor={colors.mutedForeground} value={newEvent.startTime} onChangeText={(t) => setNewEvent((p) => ({ ...p, startTime: t }))} />
                </View>
              </View>
              <Text style={styles.inputLabel}>Event Type</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {(Object.entries(EVENT_TYPE_LABELS) as [EventType, string][]).map(([k, label]) => (
                    <TouchableOpacity key={k}
                      style={[styles.sectionPill, newEvent.eventType === k && styles.sectionPillActive]}
                      onPress={() => setNewEvent((p) => ({ ...p, eventType: k }))}>
                      <Text style={[styles.sectionPillText, newEvent.eventType === k && styles.sectionPillTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>Vehicle Category</Text>
                  <TextInput style={styles.input} placeholder="Open to All" placeholderTextColor={colors.mutedForeground} value={newEvent.vehicleCategory} onChangeText={(t) => setNewEvent((p) => ({ ...p, vehicleCategory: t }))} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>Entry Cost</Text>
                  <TextInput style={styles.input} placeholder="Free" placeholderTextColor={colors.mutedForeground} value={newEvent.entryCost} onChangeText={(t) => setNewEvent((p) => ({ ...p, entryCost: t }))} />
                </View>
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Public event</Text>
                <Switch value={newEvent.isPublic} onValueChange={(v) => setNewEvent((p) => ({ ...p, isPublic: v }))} trackColor={{ true: colors.primary }} />
              </View>
              <TouchableOpacity style={styles.submitBtn} onPress={handleCreateEvent}>
                <Text style={styles.submitBtnText}>Create Event</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </Modal>
    </View>
  );
}

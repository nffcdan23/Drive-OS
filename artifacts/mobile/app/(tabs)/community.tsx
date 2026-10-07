import { GlassSurface, GlassButton } from "@/components/Glass";
import { APP_NAME } from "@/constants/brand";
import { describeError } from "@/lib/backend/http";
import {
  KeyboardAwareSheet,
  SheetScrollView,
} from "@/components/KeyboardAwareSheet";
import { ScreenTitle, Disclosure } from "@/components/Cockpit";
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  SectionHeader,
  CommunityPreviewCard,
  EventPreviewCard,
  UserActivityCard,
} from "@/components/Discovery";
import { sectionAccent } from "@/constants/colors";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  ScrollView,
  TextInput,
  Alert,
  Switch,
  Image,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import {
  useApp,
  Friend,
  Convoy,
  Group,
  DriveOSEvent,
  EventType,
} from "@/context/AppContext";
import * as Haptics from "expo-haptics";

const STATUS_COLOR: Record<Friend["status"], string> = {
  online: "#22c55e",
  driving: "#00CFE8",
  offline: "#9ca3af",
};
const STATUS_LABEL: Record<Friend["status"], string> = {
  online: "Online",
  driving: "Driving",
  offline: "Offline",
};

const EVENT_TYPE_LABELS: Record<EventType, string> = {
  static_car_meet: "Car Meet",
  scenic_drive: "Scenic Drive",
  convoy: "Convoy",
  road_trip: "Road Trip",
  show: "Show / Exhibition",
  track_day: "Track Day",
  closed_course: "Closed Course",
  charity: "Charity Event",
  photography: "Photography Meet",
  owner_club: "Owner Club Meet",
  other: "Other",
};

const CONVOY_SECTIONS = [
  { key: "my", label: "My Convoys" },
  { key: "joined", label: "Joined" },
  { key: "public", label: "Public" },
] as const;

type CommunityTab = "overview" | "convoys" | "friends" | "groups" | "events";
type ConvoySection = "my" | "joined" | "public";

// The create sheets' blank forms
const BLANK_CONVOY = {
  name: "",
  destination: "",
  description: "",
  startTime: "",
  maxParticipants: "12",
  isPrivate: false,
  privacyMethod: "invite_only" as Convoy["privacyMethod"],
};
const BLANK_GROUP = {
  name: "",
  description: "",
  primaryLocation: "",
  vehicleInterests: "",
  isPublic: true,
  membershipMethod: "open" as Group["membershipMethod"],
};
const BLANK_EVENT = {
  name: "",
  description: "",
  location: "",
  date: "",
  startTime: "",
  endTime: "",
  eventType: "static_car_meet" as EventType,
  isPublic: true,
  vehicleCategory: "Open to All",
  entryCost: "Free",
};

export default function CommunityScreen() {
  const colors = { ...useColors(), primary: sectionAccent.social };
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    friends,
    friendRequests,
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    removeFriend,
    blockUser,
    convoys,
    addConvoy,
    deleteConvoy,
    joinConvoy,
    leaveConvoy,
    groups,
    addGroup,
    joinGroup,
    events,
    addEvent,
    rsvpEvent,
    conversations,
    userProfile,
    refreshProfileStats,
  } = useApp();

  // Friends' status (online, driving, last active) changes on their phones,
  // so reload it whenever this screen is shown, and on pull-to-refresh.
  // Until live updates exist this is the only way the list catches up
  // without leaving the app.
  useFocusEffect(
    useCallback(() => {
      void refreshProfileStats();
    }, [refreshProfileStats]),
  );
  const [pulling, setPulling] = useState(false);
  const pullToRefresh = useCallback(async () => {
    setPulling(true);
    try {
      await refreshProfileStats();
    } finally {
      setPulling(false);
    }
  }, [refreshProfileStats]);
  const friendsRefresh = (
    <RefreshControl refreshing={pulling} onRefresh={pullToRefresh} tintColor={colors.primary} />
  );

  const [activeTab, setActiveTab] = useState<CommunityTab>("overview");
  const [convoySection, setConvoySection] = useState<ConvoySection>("public");

  const { section } = useLocalSearchParams<{ section?: string }>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (
      section === "convoys" ||
      section === "events" ||
      section === "friends" ||
      section === "groups"
    )
      setActiveTab(section);
  }, [section]);
  const matches = (name: string) =>
    name.toLowerCase().includes(query.trim().toLowerCase());
  const liveFriends = friends.filter(
    (f) => f.status !== "offline" && matches(f.name),
  );
  const activeConvoys = convoys.filter(
    (c) => c.status === "active" && matches(c.name),
  );

  // Create sheets.  Closing one (created, or dismissed) clears its form.
  const [showCreateConvoy, setShowCreateConvoy] = useState(false);
  const [newConvoy, setNewConvoy] = useState(BLANK_CONVOY);
  const closeCreateConvoy = () => {
    setShowCreateConvoy(false);
    setNewConvoy(BLANK_CONVOY);
  };
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroup, setNewGroup] = useState(BLANK_GROUP);
  const closeCreateGroup = () => {
    setShowCreateGroup(false);
    setNewGroup(BLANK_GROUP);
  };
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  const [newEvent, setNewEvent] = useState(BLANK_EVENT);
  const closeCreateEvent = () => {
    setShowCreateEvent(false);
    setNewEvent(BLANK_EVENT);
  };

  // Friend search
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [friendSearch, setFriendSearch] = useState("");
  // Closing Add Friend (sent, or dismissed) leaves nothing typed behind
  const closeAddFriend = () => {
    setShowAddFriend(false);
    setFriendSearch("");
  };
  // Friend actions in flight: their buttons are disabled (and show a
  // spinner) until the server answers, so a second tap can't send it twice
  // (The refs see a tap made before the disabled button has re-rendered.)
  const [sendingRequest, setSendingRequest] = useState(false);
  const sendingRef = useRef(false);
  const [friendBusy, setFriendBusy] = useState<
    Record<string, "accept" | "decline" | "remove">
  >({});
  const friendBusyRef = useRef(new Set<string>());
  async function runFriendAction(
    id: string,
    kind: "accept" | "decline" | "remove",
    action: () => Promise<boolean>,
  ) {
    if (friendBusyRef.current.has(id)) return false;
    friendBusyRef.current.add(id);
    setFriendBusy((b) => ({ ...b, [id]: kind }));
    try {
      return await action();
    } finally {
      friendBusyRef.current.delete(id);
      setFriendBusy(({ [id]: _done, ...rest }) => rest);
    }
  }

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: insets.top + 24,
      paddingHorizontal: 20,
      paddingBottom: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
    },
    headerTitle: {
      fontSize: 28,
      fontWeight: "700",
      color: colors.foreground,
    },
    addBtn: {
      minHeight: 44,
      justifyContent: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.primary,
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    addBtnText: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.primaryForeground,
    },
    tabRow: {
      flexDirection: "row",
      paddingHorizontal: 20,
      paddingTop: 14,
      paddingBottom: 4,
      backgroundColor: colors.background,
      gap: 4,
    },
    tab: {
      minHeight: 44,
      justifyContent: "center",
      flexGrow: 0,
      paddingVertical: 8,
      paddingHorizontal: 12,
      alignItems: "center",
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabActive: { borderBottomColor: colors.primary },
    tabText: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontWeight: "500",
    },
    tabTextActive: { color: colors.primary, fontWeight: "600" },
    content: { flex: 1, paddingBottom: Math.max(insets.bottom, 12) + 100 },
    // Section pills (for convoys)
    sectionRow: {
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    sectionPill: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sectionPillActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    sectionPillText: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontWeight: "500",
    },
    sectionPillTextActive: { color: colors.primaryForeground },
    sectionHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingTop: 4,
      paddingBottom: 8,
    },
    sectionTitle: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.foreground,
    },
    // Cards
    card: {
      marginHorizontal: 20,
      marginBottom: 10,
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    cardActiveConvoy: { borderColor: colors.primary, borderWidth: 1 },
    convoyHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
    },
    convoyName: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.foreground,

      flex: 1,
    },
    tag: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 8,
      backgroundColor: colors.muted,
    },
    tagText: {
      fontSize: 11,
      color: colors.mutedForeground,
    },
    privateTagText: { color: colors.primary },
    cardMeta: {
      fontSize: 13,
      color: colors.mutedForeground,

      marginTop: 4,
    },
    cardDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginVertical: 10,
    },
    statRow: { flexDirection: "row", gap: 16 },
    statItem: { flexDirection: "row", alignItems: "center", gap: 4 },
    statText: {
      fontSize: 13,
      color: colors.mutedForeground,
    },
    actionRow: { flexDirection: "row", gap: 8, marginTop: 12 },
    primaryBtn: {
      minHeight: 44,
      justifyContent: "center",
      flex: 1,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: colors.primary,
      alignItems: "center",
    },
    primaryBtnText: {
      fontSize: 14,
      fontWeight: "600",
      color: colors.primaryForeground,
    },
    secondaryBtn: {
      minHeight: 44,
      justifyContent: "center",
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
    },
    secondaryBtnText: {
      fontSize: 14,
      color: colors.foreground,
      fontWeight: "500",
    },
    destructiveBtn: { borderColor: colors.destructive },
    destructiveBtnText: { color: colors.destructive },
    // Friends
    friendCard: {
      marginHorizontal: 20,
      marginBottom: 8,
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    avatar: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.foreground,
    },
    friendName: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.foreground,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 2,
    },
    statusDot: { width: 7, height: 7, borderRadius: 4 },
    statusText: {
      fontSize: 12,
      color: colors.mutedForeground,
    },
    locationText: {
      fontSize: 12,
      color: colors.mutedForeground,
    },
    friendActions: { marginLeft: "auto", flexDirection: "row", gap: 6 },
    iconAction: { padding: 6, borderRadius: 8, backgroundColor: colors.muted },
    // Groups
    groupCard: {
      marginHorizontal: 20,
      marginBottom: 10,
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    groupName: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.foreground,
    },
    groupMeta: {
      fontSize: 13,
      color: colors.mutedForeground,

      marginTop: 4,
    },
    memberBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.primary + "15",
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
      alignSelf: "flex-start",
      marginTop: 8,
    },
    memberBadgeText: {
      fontSize: 11,
      color: colors.primary,
      fontWeight: "500",
    },
    // Events
    eventCard: {
      marginHorizontal: 20,
      marginBottom: 10,
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    eventName: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.foreground,
    },
    eventMeta: {
      fontSize: 13,
      color: colors.mutedForeground,

      marginTop: 3,
    },
    rsvpRow: { flexDirection: "row", gap: 8, marginTop: 12 },
    rsvpBtn: {
      flex: 1,
      paddingVertical: 8,
      borderRadius: 10,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    rsvpBtnGoing: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    rsvpBtnInterested: {
      borderColor: colors.primary,
      backgroundColor: colors.primary + "15",
    },
    rsvpBtnText: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.foreground,
    },
    rsvpBtnTextGoing: { color: "#fff" },
    rsvpBtnTextInterested: { color: colors.primary },
    emptyBox: {
      alignItems: "center",
      paddingVertical: 48,
      paddingHorizontal: 40,
    },
    emptyText: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: "center",

      marginTop: 10,
    },
    // Sheets
    modalContent: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      padding: 24,
      paddingBottom: Math.max(insets.bottom, 16) + 16,
    },
    // A long create sheet's panel shrinks to fit; its fields then scroll
    modalScrollable: { flexShrink: 1 },
    modalHandle: {
      width: 40,
      height: 4,
      backgroundColor: colors.border,
      borderRadius: 2,
      alignSelf: "center",
      marginBottom: 20,
    },
    modalTitle: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.foreground,

      marginBottom: 20,
    },
    inputLabel: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontWeight: "500",
      marginBottom: 6,
      marginTop: 12,
    },
    input: {
      backgroundColor: colors.muted,
      borderRadius: 12,
      padding: 14,
      fontSize: 15,
      color: colors.foreground,

      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    toggleRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 16,
      marginBottom: 4,
    },
    toggleLabel: {
      fontSize: 15,
      color: colors.foreground,
    },
    privacyNote: {
      fontSize: 12,
      color: colors.mutedForeground,

      marginTop: 4,
      marginBottom: 12,
    },
    privacyOptionRow: {
      flexDirection: "row",
      gap: 8,
      marginTop: 8,
      marginBottom: 12,
    },
    privacyOption: {
      flex: 1,
      paddingVertical: 8,
      borderRadius: 10,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    privacyOptionActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primary + "15",
    },
    privacyOptionText: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontWeight: "500",
    },
    privacyOptionTextActive: { color: colors.primary },
    submitBtn: {
      backgroundColor: colors.primary,
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: "center",
      marginTop: 20,
    },
    submitBtnText: {
      fontSize: 16,
      fontWeight: "600",
      color: "#fff",
    },
  });

  // ── Create handlers ──

  function handleCreateConvoy() {
    if (!newConvoy.name.trim() || !newConvoy.destination.trim()) {
      Alert.alert(
        "Missing info",
        "Please enter a convoy name and destination.",
      );
      return;
    }
    addConvoy({
      name: newConvoy.name,
      leaderId: "me",
      leaderName: userProfile.name,
      destination: newConvoy.destination,
      description: newConvoy.description,
      driverCount: 1,
      isPrivate: newConvoy.isPrivate,
      startTime:
        newConvoy.startTime || new Date(Date.now() + 3600000).toISOString(),
      status: "forming",
      maxParticipants: parseInt(newConvoy.maxParticipants, 10) || 12,
      privacyMethod: newConvoy.isPrivate ? newConvoy.privacyMethod : undefined,
      isOwn: true,
      isJoined: true,
    });
    closeCreateConvoy();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleDeleteConvoy(convoy: Convoy) {
    Alert.alert(
      "Cancel Convoy",
      `Cancel "${convoy.name}"? Joined participants will be notified.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Cancel Convoy",
          style: "destructive",
          onPress: () => {
            deleteConvoy(convoy.id);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          },
        },
      ],
    );
  }

  function handleCreateGroup() {
    if (!newGroup.name.trim()) {
      Alert.alert("Missing info", "Please enter a group name.");
      return;
    }
    addGroup({
      name: newGroup.name,
      description: newGroup.description,
      logoUri: null,
      isPublic: newGroup.isPublic,
      primaryLocation: newGroup.primaryLocation,
      vehicleInterests: newGroup.vehicleInterests,
      membershipMethod: newGroup.membershipMethod,
    });
    closeCreateGroup();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleCreateEvent() {
    if (!newEvent.name.trim() || !newEvent.location.trim()) {
      Alert.alert("Missing info", "Please enter an event name and location.");
      return;
    }
    addEvent({
      name: newEvent.name,
      description: newEvent.description,
      coverUri: null,
      location: newEvent.location,
      date: newEvent.date || new Date().toISOString().split("T")[0],
      startTime: newEvent.startTime || "10:00",
      endTime: newEvent.endTime || "13:00",
      eventType: newEvent.eventType,
      isPublic: newEvent.isPublic,
      groupId: null,
      capacity: 50,
      organiser: userProfile.name,
      vehicleCategory: newEvent.vehicleCategory,
      entryCost: newEvent.entryCost,
    });
    closeCreateEvent();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleRemoveFriend(f: Friend) {
    if (friendBusyRef.current.has(f.id)) return;
    Alert.alert("Remove Friend", `Remove ${f.name} from your friends?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          void runFriendAction(f.id, "remove", () => removeFriend(f.id)).then(
            (done) => {
              if (done) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            },
          );
        },
      },
    ]);
  }

  // ── Render helpers ──

  const myConvoys = convoys.filter((c) => c.isOwn);
  const joinedConvoys = convoys.filter((c) => c.isJoined && !c.isOwn);
  const publicConvoys = convoys.filter(
    (c) => !c.isPrivate && !c.isOwn && !c.isJoined,
  );
  const pendingRequests = friendRequests.filter(
    (r) => r.isIncoming && r.status === "pending",
  );

  function ConvoyCard({ convoy }: { convoy: Convoy }) {
    const startDate = new Date(convoy.startTime);
    const isOwn = convoy.isOwn;
    const isJoined = convoy.isJoined;
    return (
      <GlassSurface style={[styles.card, isJoined && styles.cardActiveConvoy]}>
        <View style={styles.convoyHeader}>
          <Text style={styles.convoyName}>{convoy.name}</Text>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {convoy.isPrivate && (
              <View style={styles.tag}>
                <Text style={[styles.tagText, styles.privateTagText]}>
                  Private
                </Text>
              </View>
            )}
            {isOwn && (
              <View
                style={[styles.tag, { backgroundColor: colors.primary + "15" }]}
              >
                <Text style={[styles.tagText, { color: colors.primary }]}>
                  Yours
                </Text>
              </View>
            )}
            {isJoined && !isOwn && (
              <View style={[styles.tag, { backgroundColor: "#22c55e20" }]}>
                <Text style={[styles.tagText, { color: "#22c55e" }]}>
                  Joined
                </Text>
              </View>
            )}
          </View>
        </View>
        <Text style={styles.cardMeta}>
          Led by {convoy.leaderName} · {convoy.destination}
        </Text>
        {convoy.description ? (
          <Text style={[styles.cardMeta, { marginTop: 2 }]}>
            {convoy.description}
          </Text>
        ) : null}
        <View style={styles.cardDivider} />
        <View style={styles.statRow}>
          <View style={styles.statItem}>
            <Ionicons
              name="people-outline"
              size={14}
              color={colors.mutedForeground}
            />
            <Text style={styles.statText}>
              {convoy.driverCount}
              {convoy.maxParticipants ? `/${convoy.maxParticipants}` : ""}{" "}
              drivers
            </Text>
          </View>
          <View style={styles.statItem}>
            <Ionicons
              name="time-outline"
              size={14}
              color={colors.mutedForeground}
            />
            <Text style={styles.statText}>
              {startDate.toLocaleDateString("en-GB", {
                weekday: "short",
                day: "numeric",
                month: "short",
              })}{" "}
              {startDate.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          </View>
        </View>
        <View style={styles.actionRow}>
          {isOwn ? (
            <TouchableOpacity
              style={[styles.secondaryBtn, styles.destructiveBtn, { flex: 1 }]}
              onPress={() => handleDeleteConvoy(convoy)}
            >
              <Text
                style={[styles.secondaryBtnText, styles.destructiveBtnText]}
              >
                Cancel Convoy
              </Text>
            </TouchableOpacity>
          ) : isJoined ? (
            <TouchableOpacity
              style={[styles.secondaryBtn, { flex: 1 }]}
              onPress={() => {
                Alert.alert("Leave Convoy", `Leave "${convoy.name}"?`, [
                  { text: "Stay", style: "cancel" },
                  {
                    text: "Leave",
                    style: "destructive",
                    onPress: () => leaveConvoy(convoy.id),
                  },
                ]);
              }}
            >
              <Text style={styles.secondaryBtnText}>Leave</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => {
                Alert.alert("Join Convoy", `Join "${convoy.name}"?`, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Join",
                    onPress: () => {
                      joinConvoy(convoy.id);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.primaryBtnText}>Join Convoy</Text>
            </TouchableOpacity>
          )}
        </View>
      </GlassSurface>
    );
  }

  function FriendRow({ item }: { item: Friend }) {
    return (
      <GlassSurface style={styles.friendCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{item.initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.friendName}>{item.name}</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: STATUS_COLOR[item.status] },
              ]}
            />
            <Text style={styles.statusText}>{STATUS_LABEL[item.status]}</Text>
          </View>
        </View>
        {/* No message button until messaging exists */}
        <View style={styles.friendActions}>
          <TouchableOpacity
            style={styles.iconAction}
            onPress={() => handleRemoveFriend(item)}
            disabled={!!friendBusy[item.id]}
            accessibilityLabel={`Remove ${item.name}`}
          >
            {friendBusy[item.id] ? (
              <ActivityIndicator size="small" color={colors.destructive} />
            ) : (
              <Ionicons
                name="person-remove-outline"
                size={16}
                color={colors.destructive}
              />
            )}
          </TouchableOpacity>
        </View>
      </GlassSurface>
    );
  }

  function GroupCard({ group }: { group: Group }) {
    return (
      <GlassSurface style={styles.groupCard}>
        {group.logoUri && (
          <Image
            source={{ uri: group.logoUri }}
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              marginBottom: 12,
            }}
          />
        )}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.groupName}>{group.name}</Text>
            <Text style={styles.groupMeta}>
              {group.primaryLocation} · {group.memberCount} members ·{" "}
              {group.vehicleInterests}
            </Text>
            <Text style={[styles.groupMeta, { marginTop: 4, lineHeight: 18 }]}>
              {group.description}
            </Text>
          </View>
          <View style={[styles.tag, { marginLeft: 8 }]}>
            <Text style={styles.tagText}>
              {group.isPublic ? "Public" : "Private"}
            </Text>
          </View>
        </View>
        {group.isMember && (
          <View style={styles.memberBadge}>
            <Ionicons
              name="checkmark-circle"
              size={13}
              color={colors.primary}
            />
            <Text style={styles.memberBadgeText}>
              {group.myRole === "owner"
                ? "Owner"
                : group.myRole === "admin"
                  ? "Admin"
                  : "Member"}
            </Text>
          </View>
        )}
        <View style={styles.actionRow}>
          {!group.isMember ? (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => {
                if (group.membershipMethod === "open") {
                  joinGroup(group.id);
                  Haptics.notificationAsync(
                    Haptics.NotificationFeedbackType.Success,
                  );
                  Alert.alert("Joined!", `You've joined ${group.name}.`);
                } else if (group.membershipMethod === "request") {
                  joinGroup(group.id);
                } else {
                  Alert.alert(
                    "Invite Only",
                    "This group requires an invitation from a member.",
                  );
                }
              }}
            >
              <Text style={styles.primaryBtnText}>
                {group.membershipMethod === "open"
                  ? "Join Group"
                  : group.membershipMethod === "request"
                    ? "Request to Join"
                    : "Invite Only"}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => router.push(`/group/${group.id}`)}
            >
              <Text style={styles.secondaryBtnText}>View Group</Text>
            </TouchableOpacity>
          )}
        </View>
      </GlassSurface>
    );
  }

  function EventCard({ event }: { event: DriveOSEvent }) {
    const isGoing = event.rsvpStatus === "going";
    const isInterested = event.rsvpStatus === "interested";
    return (
      <GlassSurface style={styles.eventCard}>
        {event.coverUri && (
          <Image
            source={{ uri: event.coverUri }}
            resizeMode="cover"
            style={{
              width: "100%",
              height: 150,
              borderRadius: 14,
              marginBottom: 12,
            }}
          />
        )}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <Text style={[styles.eventName, { flex: 1 }]}>{event.name}</Text>
          <View style={styles.tag}>
            <Text style={styles.tagText}>
              {EVENT_TYPE_LABELS[event.eventType]}
            </Text>
          </View>
        </View>
        <Text style={styles.eventMeta}>
          {event.date} · {event.startTime}–{event.endTime}
        </Text>
        <Text style={styles.eventMeta}>{event.location}</Text>
        <Text style={[styles.eventMeta, { marginTop: 2 }]}>
          Organised by {event.organiser} · {event.attendeeCount} attending ·{" "}
          {event.entryCost}
        </Text>
        <View style={styles.rsvpRow}>
          <TouchableOpacity
            style={[styles.rsvpBtn, isGoing && styles.rsvpBtnGoing]}
            onPress={() => {
              rsvpEvent(event.id, isGoing ? null : "going");
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          >
            <Text
              style={[styles.rsvpBtnText, isGoing && styles.rsvpBtnTextGoing]}
            >
              {isGoing ? "✓ Going" : "Going"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.rsvpBtn, isInterested && styles.rsvpBtnInterested]}
            onPress={() => {
              rsvpEvent(event.id, isInterested ? null : "interested");
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          >
            <Text
              style={[
                styles.rsvpBtnText,
                isInterested && styles.rsvpBtnTextInterested,
              ]}
            >
              Interested
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.rsvpBtn}
            onPress={() => router.push(`/event/${event.id}`)}
          >
            <Text style={styles.rsvpBtnText}>Details</Text>
          </TouchableOpacity>
        </View>
      </GlassSurface>
    );
  }

  const tabHeaderAction = () => {
    if (activeTab === "overview")
      return {
        label: "Add",
        onPress: () =>
          Alert.alert("Social", "Bring people together.", [
            { text: "Add Friend", onPress: () => setShowAddFriend(true) },
            {
              text: "Create Community",
              onPress: () => setShowCreateGroup(true),
            },
            { text: "Create Event", onPress: () => setShowCreateEvent(true) },
            { text: "Create Convoy", onPress: () => setShowCreateConvoy(true) },
            { text: "Cancel", style: "cancel" },
          ]),
      };
    if (activeTab === "convoys")
      return { label: "Create", onPress: () => setShowCreateConvoy(true) };
    if (activeTab === "friends")
      return { label: "Add", onPress: () => setShowAddFriend(true) };
    if (activeTab === "groups")
      return { label: "Create", onPress: () => setShowCreateGroup(true) };
    if (activeTab === "events")
      return { label: "Create", onPress: () => setShowCreateEvent(true) };
    return null;
  };
  const action = tabHeaderAction();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <ScreenTitle
          title="Social"
          eyebrow="See who’s driving and what’s happening."
        />
        {action && (
          <GlassButton
            style={styles.addBtn}
            accessibilityLabel={
              activeTab === "overview"
                ? "Add friend, community, event or convoy"
                : action.label
            }
            onPress={action.onPress}
          >
            <Ionicons name="add" size={22} color={colors.foreground} />
            {activeTab !== "overview" && (
              <Text style={[styles.addBtnText, { color: colors.foreground }]}>
                {action.label}
              </Text>
            )}
          </GlassButton>
        )}
      </View>

      <GlassSurface
        style={{
          marginHorizontal: 20,
          marginBottom: 12,
          minHeight: 50,
          borderRadius: 24,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Ionicons name="search" size={18} color={colors.mutedForeground} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search friends, communities or events"
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel="Search Social"
          style={{
            flex: 1,
            minHeight: 50,
            color: colors.foreground,
            fontSize: 14,
          }}
        />
      </GlassSurface>
      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0, height: 64 }}
        contentContainerStyle={styles.tabRow}
      >
        {(
          [
            "overview",
            "friends",
            "groups",
            "events",
            "convoys",
          ] as CommunityTab[]
        ).map((t) => (
          <TouchableOpacity
            key={t}
            accessibilityRole="button"
            accessibilityState={{ selected: activeTab === t }}
            style={[styles.tab, activeTab === t && styles.tabActive]}
            onPress={() => setActiveTab(t)}
          >
            <Text
              style={[styles.tabText, activeTab === t && styles.tabTextActive]}
            >
              {t === "groups"
                ? "Communities"
                : t === "overview"
                  ? "Now"
                  : t.charAt(0).toUpperCase() + t.slice(1)}
              {t === "friends" && pendingRequests.length > 0
                ? ` (${pendingRequests.length})`
                : ""}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {activeTab === "overview" && (
        <ScrollView
          refreshControl={friendsRefresh}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 12) + 100,
          }}
        >
          <GlassSurface
            style={{
              marginHorizontal: 20,
              marginTop: 16,
              paddingVertical: 16,
              borderRadius: 20,
              flexDirection: "row",
            }}
          >
            {[
              [
                friends.filter((f) => f.status === "online").length,
                "online",
                "people-outline",
              ],
              [
                friends.filter((f) => f.status === "driving").length,
                "driving",
                "car-outline",
              ],
              [
                convoys.filter((c) => c.status === "active").length,
                "live convoys",
                "git-network-outline",
              ],
            ].map(([count, label, icon]) => (
              <View
                key={label}
                style={{ flex: 1, alignItems: "center", gap: 5 }}
              >
                <Ionicons name={icon as any} size={24} color={colors.primary} />
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 21,
                    fontWeight: "600",
                  }}
                >
                  {count}
                </Text>
                <Text style={styles.cardMeta}>{label}</Text>
              </View>
            ))}
          </GlassSurface>
          {liveFriends.length > 0 && (
            <>
              <SectionHeader
                title="Live Now"
                onPress={() => setActiveTab("friends")}
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
              >
                {liveFriends.map((friend) => (
                  <UserActivityCard
                    key={friend.id}
                    friend={friend}
                    onPress={() => setActiveTab("friends")}
                  />
                ))}
              </ScrollView>
            </>
          )}
          <SectionHeader
            title="Communities"
            onPress={() => setActiveTab("groups")}
          />
          {groups.filter((g) => matches(g.name)).length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
            >
              {groups
                .filter((g) => matches(g.name))
                .map((group) => (
                  <CommunityPreviewCard
                    key={group.id}
                    group={group}
                    onPress={() => router.push(`/group/${group.id}`)}
                  />
                ))}
            </ScrollView>
          ) : (
            <GlassSurface
              style={{ marginHorizontal: 20, padding: 20, borderRadius: 20 }}
            >
              <Text style={styles.groupName}>Find your people</Text>
              <Text style={[styles.cardMeta, { marginTop: 6 }]}>
                {query
                  ? "No communities match your search."
                  : "Create a community around your car, your area or your favourite roads."}
              </Text>
            </GlassSurface>
          )}
          <SectionHeader
            title="Events & Convoys"
            onPress={() => setActiveTab("events")}
          />
          {events.filter((e) => matches(e.name)).length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
            >
              {events
                .filter((e) => matches(e.name))
                .map((event) => (
                  <EventPreviewCard
                    key={event.id}
                    event={event}
                    onPress={() => router.push(`/event/${event.id}`)}
                  />
                ))}
            </ScrollView>
          )}
          {activeConvoys.map((convoy) => (
            <ConvoyCard key={convoy.id} convoy={convoy} />
          ))}
          {!events.filter((e) => matches(e.name)).length &&
            !activeConvoys.length && (
              <GlassSurface
                style={{ marginHorizontal: 20, padding: 20, borderRadius: 20 }}
              >
                <Text style={styles.eventName}>Your next shared drive</Text>
                <Text style={[styles.cardMeta, { marginTop: 6 }]}>
                  {query
                    ? "No events or live convoys match your search."
                    : "No events or live convoys yet. Plan something with your community."}
                </Text>
              </GlassSurface>
            )}
          <SectionHeader
            title="Friends"
            onPress={() => setActiveTab("friends")}
          />
          {friends
            .filter((f) => matches(f.name))
            .slice(0, 3)
            .map((friend) => (
              <FriendRow key={friend.id} item={friend} />
            ))}
          {!friends.length && (
            <GlassButton
              style={{ marginHorizontal: 20, padding: 18, borderRadius: 20 }}
              onPress={() => setShowAddFriend(true)}
            >
              <Text style={styles.friendName}>Add a friend</Text>
              <Text style={[styles.cardMeta, { marginTop: 5 }]}>
                Connect using their friend code.
              </Text>
            </GlassButton>
          )}
        </ScrollView>
      )}

      {/* ── Convoys tab ── */}
      {activeTab === "convoys" && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 12) + 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.sectionRow}
          >
            {CONVOY_SECTIONS.map((s) => (
              <TouchableOpacity
                key={s.key}
                style={[
                  styles.sectionPill,
                  convoySection === s.key && styles.sectionPillActive,
                ]}
                onPress={() => setConvoySection(s.key)}
              >
                <Text
                  style={[
                    styles.sectionPillText,
                    convoySection === s.key && styles.sectionPillTextActive,
                  ]}
                >
                  {s.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {convoySection === "my" &&
            (myConvoys.filter((item) => matches(item.name)).length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons
                  name="car-sport-outline"
                  size={40}
                  color={colors.mutedForeground}
                />
                <Text style={styles.emptyText}>
                  You haven't created any convoys yet. Tap Create to start one.
                </Text>
              </View>
            ) : (
              myConvoys
                .filter((c) => matches(c.name))
                .map((c) => <ConvoyCard key={c.id} convoy={c} />)
            ))}
          {convoySection === "joined" &&
            (joinedConvoys.filter((item) => matches(item.name)).length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons
                  name="people-outline"
                  size={40}
                  color={colors.mutedForeground}
                />
                <Text style={styles.emptyText}>
                  You haven't joined any convoys yet.
                </Text>
              </View>
            ) : (
              joinedConvoys
                .filter((c) => matches(c.name))
                .map((c) => <ConvoyCard key={c.id} convoy={c} />)
            ))}
          {convoySection === "public" &&
            (publicConvoys.filter((item) => matches(item.name)).length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons
                  name="earth-outline"
                  size={40}
                  color={colors.mutedForeground}
                />
                <Text style={styles.emptyText}>
                  No public convoys nearby right now.
                </Text>
              </View>
            ) : (
              publicConvoys
                .filter((c) => matches(c.name))
                .map((c) => <ConvoyCard key={c.id} convoy={c} />)
            ))}
        </ScrollView>
      )}

      {/* ── Friends tab ── */}
      {activeTab === "friends" && (
        <ScrollView
          refreshControl={friendsRefresh}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 12) + 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          {/* Pending requests */}
          {pendingRequests.length > 0 && (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>
                  Requests · {pendingRequests.length}
                </Text>
              </View>
              {pendingRequests.map((req) => (
                <View key={req.id} style={styles.friendCard}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{req.fromInitials}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.friendName}>{req.fromName}</Text>
                    <Text style={styles.statusText}>Wants to be friends</Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    <TouchableOpacity
                      style={[
                        styles.primaryBtn,
                        { paddingHorizontal: 14, flex: 0 },
                        !!friendBusy[req.id] && { opacity: 0.6 },
                      ]}
                      disabled={!!friendBusy[req.id]}
                      onPress={() => {
                        void runFriendAction(req.id, "accept", () =>
                          acceptFriendRequest(req.id),
                        ).then((done) => {
                          if (done) {
                            Haptics.notificationAsync(
                              Haptics.NotificationFeedbackType.Success,
                            );
                          }
                        });
                      }}
                    >
                      {friendBusy[req.id] === "accept" ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.primaryBtnText}>Accept</Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.secondaryBtn,
                        !!friendBusy[req.id] && { opacity: 0.6 },
                      ]}
                      disabled={!!friendBusy[req.id]}
                      onPress={() => {
                        void runFriendAction(req.id, "decline", () =>
                          declineFriendRequest(req.id),
                        );
                      }}
                    >
                      {friendBusy[req.id] === "decline" ? (
                        <ActivityIndicator
                          size="small"
                          color={colors.foreground}
                        />
                      ) : (
                        <Text style={styles.secondaryBtnText}>Decline</Text>
                      )}
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
          {friends.filter((item) => matches(item.name)).length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons
                name="people-outline"
                size={40}
                color={colors.mutedForeground}
              />
              <Text style={styles.emptyText}>
                No friends yet. Tap Add to send a friend request.
              </Text>
            </View>
          ) : (
            friends
              .filter((f) => matches(f.name))
              .map((f) => <FriendRow key={f.id} item={f} />)
          )}
        </ScrollView>
      )}

      {/* ── Groups tab ── */}
      {activeTab === "groups" && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 12) + 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          {groups.filter((item) => matches(item.name)).length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons
                name="shield-outline"
                size={40}
                color={colors.mutedForeground}
              />
              <Text style={styles.emptyText}>
                No groups found. Create your own car club or community.
              </Text>
            </View>
          ) : (
            groups
              .filter((g) => matches(g.name))
              .map((g) => <GroupCard key={g.id} group={g} />)
          )}
        </ScrollView>
      )}

      {/* ── Events tab ── */}
      {activeTab === "events" && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 12) + 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          {events.filter((item) => matches(item.name)).length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons
                name="calendar-outline"
                size={40}
                color={colors.mutedForeground}
              />
              <Text style={styles.emptyText}>
                No events nearby. Create one for your community.
              </Text>
            </View>
          ) : (
            events
              .filter((e) => matches(e.name))
              .map((e) => <EventCard key={e.id} event={e} />)
          )}
        </ScrollView>
      )}

      {/* ── Create Convoy modal ── */}
      <KeyboardAwareSheet
        visible={showCreateConvoy}
        onClose={closeCreateConvoy}
        backdropColor="rgba(0,0,0,0.5)"
        scrollable
      >
        <GlassSurface
          material="dense"
          style={[styles.modalContent, styles.modalScrollable]}
        >
          <View style={styles.modalHandle} />
          <SheetScrollView>
            <Text style={styles.modalTitle}>Create Convoy</Text>
            <Text style={styles.inputLabel}>Convoy Name *</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Sunday Scenic Run"
              placeholderTextColor={colors.mutedForeground}
              value={newConvoy.name}
              onChangeText={(t) => setNewConvoy((p) => ({ ...p, name: t }))}
            />
            <Text style={styles.inputLabel}>Destination *</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Kirkstone Pass Inn"
              placeholderTextColor={colors.mutedForeground}
              value={newConvoy.destination}
              onChangeText={(t) =>
                setNewConvoy((p) => ({ ...p, destination: t }))
              }
            />
            <Text style={styles.inputLabel}>Description</Text>
            <TextInput
              style={styles.input}
              placeholder="Optional details about the run…"
              placeholderTextColor={colors.mutedForeground}
              value={newConvoy.description}
              onChangeText={(t) =>
                setNewConvoy((p) => ({ ...p, description: t }))
              }
            />
            <Text style={styles.inputLabel}>Max Participants</Text>
            <TextInput
              style={styles.input}
              placeholder="12"
              placeholderTextColor={colors.mutedForeground}
              value={newConvoy.maxParticipants}
              onChangeText={(t) =>
                setNewConvoy((p) => ({ ...p, maxParticipants: t }))
              }
              keyboardType="numeric"
            />
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Private convoy</Text>
              <Switch
                value={newConvoy.isPrivate}
                onValueChange={(v) =>
                  setNewConvoy((p) => ({ ...p, isPrivate: v }))
                }
                trackColor={{ true: colors.primary }}
              />
            </View>
            {newConvoy.isPrivate && (
              <>
                <Text style={styles.privacyNote}>
                  Choose how participants join this convoy.
                </Text>
                <View style={styles.privacyOptionRow}>
                  {(["invite_only", "passcode", "group_members"] as const).map(
                    (m) => (
                      <TouchableOpacity
                        key={m}
                        style={[
                          styles.privacyOption,
                          newConvoy.privacyMethod === m &&
                            styles.privacyOptionActive,
                        ]}
                        onPress={() =>
                          setNewConvoy((p) => ({ ...p, privacyMethod: m }))
                        }
                      >
                        <Text
                          style={[
                            styles.privacyOptionText,
                            newConvoy.privacyMethod === m &&
                              styles.privacyOptionTextActive,
                          ]}
                        >
                          {m === "invite_only"
                            ? "Invite Only"
                            : m === "passcode"
                              ? "Passcode"
                              : "Group Only"}
                        </Text>
                      </TouchableOpacity>
                    ),
                  )}
                </View>
                {newConvoy.privacyMethod !== "invite_only" &&
                  newConvoy.privacyMethod !== "group_members" && (
                    <TextInput
                      style={styles.input}
                      placeholder="Enter a passcode (leave blank for invite-only)"
                      placeholderTextColor={colors.mutedForeground}
                      secureTextEntry
                    />
                  )}
                <Text style={styles.privacyNote}>
                  If no passcode is entered, the convoy defaults to Invite Only.
                </Text>
              </>
            )}
            <TouchableOpacity
              style={styles.submitBtn}
              onPress={handleCreateConvoy}
            >
              <Text style={styles.submitBtnText}>Create Convoy</Text>
            </TouchableOpacity>
          </SheetScrollView>
        </GlassSurface>
      </KeyboardAwareSheet>

      {/* ── Add Friend modal ── */}
      <KeyboardAwareSheet
        visible={showAddFriend}
        onClose={closeAddFriend}
        backdropColor="rgba(0,0,0,0.5)"
      >
        <GlassSurface material="dense" style={styles.modalContent}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>Add Friend</Text>
          <Text style={styles.inputLabel}>Their friend code</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. K7M2QX9P"
            placeholderTextColor={colors.mutedForeground}
            value={friendSearch}
            onChangeText={setFriendSearch}
            autoCapitalize="characters"
            maxLength={12}
            autoCorrect={false}
          />
          <Text style={[styles.inputLabel, { marginTop: 16 }]}>
            Your friend code
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              backgroundColor: colors.muted,
              borderRadius: 12,
              padding: 14,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.border,
            }}
          >
            <Text
              style={{
                fontSize: 18,
                fontWeight: "700",
                color: colors.primary,

                flex: 1,
                letterSpacing: 2,
              }}
            >
              {userProfile.friendCode ?? "…"}
            </Text>
            <TouchableOpacity
              onPress={() =>
                Alert.alert(
                  "Share link",
                  `Share this code with a friend: ${userProfile.friendCode ?? ""}`,
                )
              }
            >
              <Ionicons name="share-outline" size={20} color={colors.primary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.privacyNote}>
            Share your code or send a link so friends can find you directly.
          </Text>
          <TouchableOpacity
            style={[styles.submitBtn, sendingRequest && { opacity: 0.6 }]}
            disabled={sendingRequest}
            onPress={async () => {
              if (sendingRef.current) return;
              const code = friendSearch.replace(/\s+/g, "").toUpperCase();
              if (!/^[A-Z0-9]{8}$/.test(code)) {
                Alert.alert(
                  "Enter a friend code",
                  "Friend codes are 8 letters and numbers.",
                );
                return;
              }
              sendingRef.current = true;
              setSendingRequest(true);
              try {
                const result = await sendFriendRequest(code);
                closeAddFriend();
                Alert.alert(
                  result === "accepted" ? "You're now friends" : "Request sent",
                  result === "accepted"
                    ? "They had already sent you a request, so you're now connected."
                    : `They'll see your request next time they open ${APP_NAME}.`,
                );
              } catch (err) {
                Alert.alert("Request not sent", describeError(err));
              } finally {
                sendingRef.current = false;
                setSendingRequest(false);
              }
            }}
          >
            {sendingRequest ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitBtnText}>Send Request</Text>
            )}
          </TouchableOpacity>
        </GlassSurface>
      </KeyboardAwareSheet>

      {/* ── Create Group modal ── */}
      <KeyboardAwareSheet
        visible={showCreateGroup}
        onClose={closeCreateGroup}
        backdropColor="rgba(0,0,0,0.5)"
        scrollable
      >
        <GlassSurface
          material="dense"
          style={[styles.modalContent, styles.modalScrollable]}
        >
          <View style={styles.modalHandle} />
          <SheetScrollView>
            <Text style={styles.modalTitle}>Create Group</Text>
            <Text style={styles.inputLabel}>Group Name *</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Lake District MINI Club"
              placeholderTextColor={colors.mutedForeground}
              value={newGroup.name}
              onChangeText={(t) => setNewGroup((p) => ({ ...p, name: t }))}
            />
            <Text style={styles.inputLabel}>Description</Text>
            <TextInput
              style={[styles.input, { minHeight: 70 }]}
              placeholder="Tell people what this group is about…"
              placeholderTextColor={colors.mutedForeground}
              value={newGroup.description}
              onChangeText={(t) =>
                setNewGroup((p) => ({ ...p, description: t }))
              }
              multiline
            />
            <Text style={styles.inputLabel}>Primary Location</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Keswick, Cumbria"
              placeholderTextColor={colors.mutedForeground}
              value={newGroup.primaryLocation}
              onChangeText={(t) =>
                setNewGroup((p) => ({ ...p, primaryLocation: t }))
              }
            />
            <Text style={styles.inputLabel}>Vehicle Interests</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. MINIs, Classics, Performance"
              placeholderTextColor={colors.mutedForeground}
              value={newGroup.vehicleInterests}
              onChangeText={(t) =>
                setNewGroup((p) => ({ ...p, vehicleInterests: t }))
              }
            />
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Public group</Text>
              <Switch
                value={newGroup.isPublic}
                onValueChange={(v) =>
                  setNewGroup((p) => ({ ...p, isPublic: v }))
                }
                trackColor={{ true: colors.primary }}
              />
            </View>
            <Text style={styles.inputLabel}>Membership</Text>
            <View style={styles.privacyOptionRow}>
              {(["open", "request", "invite", "code"] as const).map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[
                    styles.privacyOption,
                    newGroup.membershipMethod === m &&
                      styles.privacyOptionActive,
                  ]}
                  onPress={() =>
                    setNewGroup((p) => ({ ...p, membershipMethod: m }))
                  }
                >
                  <Text
                    style={[
                      styles.privacyOptionText,
                      newGroup.membershipMethod === m &&
                        styles.privacyOptionTextActive,
                    ]}
                  >
                    {m === "open"
                      ? "Open"
                      : m === "request"
                        ? "Request"
                        : m === "invite"
                          ? "Invite"
                          : "Code"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={styles.submitBtn}
              onPress={handleCreateGroup}
            >
              <Text style={styles.submitBtnText}>Create Group</Text>
            </TouchableOpacity>
          </SheetScrollView>
        </GlassSurface>
      </KeyboardAwareSheet>

      {/* ── Create Event modal ── */}
      <KeyboardAwareSheet
        visible={showCreateEvent}
        onClose={closeCreateEvent}
        backdropColor="rgba(0,0,0,0.5)"
        scrollable
      >
        <GlassSurface
          material="dense"
          style={[styles.modalContent, styles.modalScrollable]}
        >
          <View style={styles.modalHandle} />
          <SheetScrollView>
            <Text style={styles.modalTitle}>Create Event</Text>
            <Text style={styles.inputLabel}>Event Name *</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Sunday Car Meet"
              placeholderTextColor={colors.mutedForeground}
              value={newEvent.name}
              onChangeText={(t) => setNewEvent((p) => ({ ...p, name: t }))}
            />
            <Text style={styles.inputLabel}>Location *</Text>
            <TextInput
              style={styles.input}
              placeholder="Venue name and postcode"
              placeholderTextColor={colors.mutedForeground}
              value={newEvent.location}
              onChangeText={(t) => setNewEvent((p) => ({ ...p, location: t }))}
            />
            <Text style={styles.inputLabel}>Description</Text>
            <TextInput
              style={[styles.input, { minHeight: 60 }]}
              placeholder="Tell attendees what to expect…"
              placeholderTextColor={colors.mutedForeground}
              value={newEvent.description}
              onChangeText={(t) =>
                setNewEvent((p) => ({ ...p, description: t }))
              }
              multiline
            />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>Date</Text>
                <TextInput
                  style={styles.input}
                  placeholder="2026-08-01"
                  placeholderTextColor={colors.mutedForeground}
                  value={newEvent.date}
                  onChangeText={(t) => setNewEvent((p) => ({ ...p, date: t }))}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>Start</Text>
                <TextInput
                  style={styles.input}
                  placeholder="10:00"
                  placeholderTextColor={colors.mutedForeground}
                  value={newEvent.startTime}
                  onChangeText={(t) =>
                    setNewEvent((p) => ({ ...p, startTime: t }))
                  }
                />
              </View>
            </View>
            <Text style={styles.inputLabel}>Event Type</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 4 }}
            >
              <View style={{ flexDirection: "row", gap: 8 }}>
                {(
                  Object.entries(EVENT_TYPE_LABELS) as [EventType, string][]
                ).map(([k, label]) => (
                  <TouchableOpacity
                    key={k}
                    style={[
                      styles.sectionPill,
                      newEvent.eventType === k && styles.sectionPillActive,
                    ]}
                    onPress={() => setNewEvent((p) => ({ ...p, eventType: k }))}
                  >
                    <Text
                      style={[
                        styles.sectionPillText,
                        newEvent.eventType === k &&
                          styles.sectionPillTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>Vehicle Category</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Open to All"
                  placeholderTextColor={colors.mutedForeground}
                  value={newEvent.vehicleCategory}
                  onChangeText={(t) =>
                    setNewEvent((p) => ({ ...p, vehicleCategory: t }))
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>Entry Cost</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Free"
                  placeholderTextColor={colors.mutedForeground}
                  value={newEvent.entryCost}
                  onChangeText={(t) =>
                    setNewEvent((p) => ({ ...p, entryCost: t }))
                  }
                />
              </View>
            </View>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Public event</Text>
              <Switch
                value={newEvent.isPublic}
                onValueChange={(v) =>
                  setNewEvent((p) => ({ ...p, isPublic: v }))
                }
                trackColor={{ true: colors.primary }}
              />
            </View>
            <TouchableOpacity
              style={styles.submitBtn}
              onPress={handleCreateEvent}
            >
              <Text style={styles.submitBtnText}>Create Event</Text>
            </TouchableOpacity>
          </SheetScrollView>
        </GlassSurface>
      </KeyboardAwareSheet>
    </View>
  );
}

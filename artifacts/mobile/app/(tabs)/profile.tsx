import { ScreenTitle } from "@/components/Cockpit";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Platform,
  AppState,
  AppStateStatus,
  Alert,
  Modal,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { describeError } from "@/lib/backend/http";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { formatDistance, distanceUnit } from "@/lib/units";

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    userProfile,
    journeys,
    resolvedUnitSystem,
    profileStats,
    refreshProfileStats,
    updateProfile,
    setAvatar,
  } = useApp();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", username: "", bio: "" });
  const [avatarBusy, setAvatarBusy] = useState(false);

  const openEdit = () => {
    setForm({ name: userProfile.name, username: userProfile.username ?? "", bio: userProfile.bio ?? "" });
    setEditing(true);
  };
  const saveEdit = () => {
    if (!form.name.trim()) { Alert.alert("Name required", "Enter the name other drivers will see."); return; }
    if (form.username.trim() && !/^[A-Za-z0-9_.]{3,30}$/.test(form.username.trim())) {
      Alert.alert("Username", "Use 3–30 letters, numbers, dots or underscores.");
      return;
    }
    updateProfile({ name: form.name.trim(), username: form.username.trim() || undefined, bio: form.bio.trim() });
    setEditing(false);
  };
  const pickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== "granted") { Alert.alert("Photo access needed", "Allow photo access to choose a profile picture."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.9 });
    if (r.canceled || !r.assets[0]?.uri) return;
    setAvatarBusy(true);
    try {
      await setAvatar(r.assets[0].uri);
    } catch (err) {
      Alert.alert("Profile picture not saved", describeError(err));
    } finally {
      setAvatarBusy(false);
    }
  };

  // Refresh stats whenever this screen comes into focus
  useFocusEffect(
    useCallback(() => {
      refreshProfileStats();
    }, [refreshProfileStats]),
  );

  // Refresh stats when the app returns to the foreground
  const appState = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (
        appState.current.match(/inactive|background/) &&
        nextState === "active"
      ) {
        refreshProfileStats();
      }
      appState.current = nextState;
    });
    return () => sub.remove();
  }, [refreshProfileStats]);

  // The server reports XP remaining in the current 1,000-XP level.
  const xpProgress = 1 - userProfile.xpToNextLevel / 1000;
  const unlockedAchievements = userProfile.achievements.filter(
    (a) => a.unlockedAt !== null,
  );

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { flex: 1 },
    content: {
      paddingBottom: Math.max(insets.bottom, 12) + 100,
    },
    heroSection: {
      paddingTop: insets.top + 24,
      paddingHorizontal: 20,
      paddingBottom: 24,
      backgroundColor: colors.card,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      alignItems: "flex-start",
    },
    avatar: {
      marginTop: 24,
      width: 64,
      height: 64,
      borderRadius: 18,
      backgroundColor: colors.primary + "20",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.primary,
    },
    avatarText: {
      fontSize: 28,
      fontWeight: "700",
      color: colors.primary,
      fontFamily: "Inter_700Bold",
    },
    driverName: {
      fontSize: 30,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      marginTop: 12,
    },
    levelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 4,
    },
    levelBadge: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 3,
    },
    levelBadgeText: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.primaryForeground,
      fontFamily: "Inter_700Bold",
    },
    levelLabel: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    xpRow: { width: "100%", marginTop: 14 },
    xpLabelRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 6,
    },
    xpLabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    xpBar: { height: 6, backgroundColor: colors.muted, borderRadius: 3 },
    xpFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
    settingsBtn: {
      minWidth: 48,
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      position: "absolute",
      top: insets.top + 24,
      right: 20,
    },
    statsSection: { padding: 20 },
    sectionTitle: {
      fontSize: 16,
      fontWeight: "600",
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
      marginBottom: 12,
    },
    statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    statCard: {
      flex: 1,
      minWidth: "45%",
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      alignItems: "center",
    },
    statValue: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      marginTop: 6,
    },
    statLabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
      textAlign: "center",
    },
    achievementsSection: { paddingHorizontal: 20, paddingBottom: 12 },
    achievementRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    achievementCard: {
      width: "30%",
      alignItems: "center",
      padding: 10,
      borderRadius: 14,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    achievementLocked: { opacity: 0.35 },
    achievementTitle: {
      fontSize: 10,
      fontWeight: "600",
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
      textAlign: "center",
      marginTop: 6,
    },
    settingsSection: { paddingHorizontal: 20 },
    settingsCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    },
    settingsRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    settingsLabel: {
      flex: 1,
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
    },
  });

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.heroSection}>
          <ScreenTitle title="Driver profile" eyebrow="Every mile counts" />
          <TouchableOpacity style={styles.avatar} onPress={pickAvatar} accessibilityLabel="Change profile picture" disabled={avatarBusy}>
            {userProfile.avatarUrl ? (
              <Image source={{ uri: userProfile.avatarUrl }} style={{ width: 64, height: 64, borderRadius: 18 }} contentFit="cover" />
            ) : (
              <Text style={styles.avatarText}>{userProfile.name.charAt(0)}</Text>
            )}
            {avatarBusy ? <ActivityIndicator style={{ position: "absolute" }} color={colors.primary} /> : null}
          </TouchableOpacity>
          <Text style={styles.driverName}>{userProfile.name}</Text>
          <View style={styles.levelRow}>
            <View style={styles.levelBadge}>
              <Text style={styles.levelBadgeText}>LVL {userProfile.level}</Text>
            </View>
            <Text style={styles.levelLabel}>Driver</Text>
          </View>
          <View style={styles.xpRow}>
            <View style={styles.xpLabelRow}>
              <Text style={styles.xpLabel}>
                {userProfile.xp.toLocaleString()} XP
              </Text>
              <Text style={styles.xpLabel}>
                {userProfile.xpToNextLevel.toLocaleString()} XP to Level{" "}
                {userProfile.level + 1}
              </Text>
            </View>
            <View style={styles.xpBar}>
              <View
                style={[
                  styles.xpFill,
                  { width: `${Math.min(100, xpProgress * 100)}%` as any },
                ]}
              />
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={() => router.push("/settings")}
        >
          <Ionicons
            name="settings-outline"
            size={24}
            color={colors.foreground}
          />
        </TouchableOpacity>

        {/* Stats */}
        <View style={styles.statsSection}>
          <Text style={styles.sectionTitle}>Your driving record</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Ionicons
                name="navigate-outline"
                size={20}
                color={colors.primary}
              />
              <Text style={styles.statValue}>
                {formatDistance(profileStats.totalDistance, resolvedUnitSystem)}
              </Text>
              <Text style={styles.statLabel}>
                Total {distanceUnit(resolvedUnitSystem)}
              </Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="flag-outline" size={20} color={colors.primary} />
              <Text style={styles.statValue}>{profileStats.journeys}</Text>
              <Text style={styles.statLabel}>Journeys</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="car-outline" size={20} color={colors.primary} />
              <Text style={styles.statValue}>{profileStats.vehicles}</Text>
              <Text style={styles.statLabel}>Vehicles</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons
                name="people-outline"
                size={20}
                color={colors.primary}
              />
              <Text style={styles.statValue}>{profileStats.friends}</Text>
              <Text style={styles.statLabel}>Friends</Text>
            </View>
          </View>
        </View>

        {/* Achievements */}
        <View style={styles.achievementsSection}>
          <Text style={styles.sectionTitle}>
            Achievements · {unlockedAchievements.length}/
            {userProfile.achievements.length}
          </Text>
          <View style={styles.achievementRow}>
            {userProfile.achievements.map((ach) => (
              <View
                key={ach.id}
                style={[
                  styles.achievementCard,
                  !ach.unlockedAt && styles.achievementLocked,
                ]}
              >
                <Ionicons
                  name={ach.icon as any}
                  size={24}
                  color={
                    ach.unlockedAt ? colors.primary : colors.mutedForeground
                  }
                />
                <Text style={styles.achievementTitle}>{ach.title}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Settings shortcuts */}
        <View style={styles.settingsSection}>
          <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Settings</Text>
          <View style={styles.settingsCard}>
            {[
              {
                icon: "person-outline",
                label: "Edit Profile",
                onPress: openEdit,
              },
              {
                icon: "shield-checkmark-outline",
                label: "Account & Settings",
                onPress: () => router.push("/settings"),
              },
              {
                icon: "walk-outline",
                label: "Passenger Mode",
                onPress: () => router.push("/settings"),
              },
              {
                icon: "car-outline",
                label: "Connected Devices (OBD / HUD)",
                onPress: () => {},
              },
              {
                icon: "information-circle-outline",
                label: "About this app",
                onPress: () => {},
              },
            ].map((item, i) => (
              <TouchableOpacity
                key={i}
                style={[
                  styles.settingsRow,
                  i === 4 && { borderBottomWidth: 0 },
                ]}
                onPress={item.onPress}
              >
                <Ionicons
                  name={item.icon as any}
                  size={20}
                  color={colors.mutedForeground}
                />
                <Text style={styles.settingsLabel}>{item.label}</Text>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedForeground}
                />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </ScrollView>

      <Modal visible={editing} transparent animationType="slide" onRequestClose={() => setEditing(false)}>
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}>
          <View style={{ backgroundColor: colors.card, padding: 20, paddingBottom: insets.bottom + 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: 10 }}>
            <Text style={{ color: colors.foreground, fontSize: 18, fontFamily: "Inter_700Bold" }}>Edit profile</Text>
            {([
              ["name", "Display name", 50],
              ["username", "Username (optional)", 30],
              ["bio", "Bio (optional)", 500],
            ] as const).map(([key, label, max]) => (
              <TextInput
                key={key}
                placeholder={label}
                placeholderTextColor={colors.mutedForeground}
                value={form[key]}
                onChangeText={(t) => setForm((f) => ({ ...f, [key]: t }))}
                maxLength={max}
                autoCapitalize={key === "username" ? "none" : "sentences"}
                multiline={key === "bio"}
                style={{ minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: colors.input, color: colors.foreground, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, fontFamily: "Inter_400Regular" }}
              />
            ))}
            <TouchableOpacity onPress={saveEdit} style={{ height: 48, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: colors.primaryForeground, fontFamily: "Inter_600SemiBold", fontSize: 16 }}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEditing(false)} style={{ alignItems: "center", padding: 8 }}>
              <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold" }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

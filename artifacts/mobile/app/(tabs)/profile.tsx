import { GlassButton, GlassSurface } from "@/components/Glass";
import { KeyboardAwareSheet } from "@/components/KeyboardAwareSheet";
import { useSignOut } from "@/hooks/useSignOut";
import { sectionAccent } from "@/constants/colors";
import { ScreenTitle, Disclosure } from "@/components/Cockpit";
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
import { locationSharingSummary } from "@/components/LocationSharingSettings";
import { formatDistance, distanceUnit } from "@/lib/units";

export default function ProfileScreen() {
  const colors = { ...useColors(), primary: sectionAccent.profile };
  const handleSignOut = useSignOut();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    userProfile,
    activeVehicle,
    groups,
    journeys,
    resolvedUnitSystem,
    profileStats,
    refreshProfileStats,
    updateProfile,
    setAvatar,
    locationSharing,
  } = useApp();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", username: "", bio: "" });
  const [avatarBusy, setAvatarBusy] = useState(false);

  const openEdit = () => {
    setForm({
      name: userProfile.name,
      username: userProfile.username ?? "",
      bio: userProfile.bio ?? "",
    });
    setEditing(true);
  };
  const saveEdit = () => {
    if (!form.name.trim()) {
      Alert.alert("Name required", "Enter the name other drivers will see.");
      return;
    }
    if (
      form.username.trim() &&
      !/^[A-Za-z0-9_.]{3,30}$/.test(form.username.trim())
    ) {
      Alert.alert(
        "Username",
        "Use 3–30 letters, numbers, dots or underscores.",
      );
      return;
    }
    updateProfile({
      name: form.name.trim(),
      username: form.username.trim() || undefined,
      bio: form.bio.trim(),
    });
    setEditing(false);
  };
  const pickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== "granted") {
      Alert.alert(
        "Photo access needed",
        "Allow photo access to choose a profile picture.",
      );
      return;
    }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
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
    row: { flexDirection: "row", alignItems: "center", gap: 12 },
    name: { color: colors.foreground, fontSize: 25, fontWeight: "700" },
    muted: { color: colors.mutedForeground, fontSize: 13, lineHeight: 19 },
    panel: { borderRadius: 22, padding: 18, marginBottom: 14 },
    avatar: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.secondary,
      borderWidth: 1,
      borderColor: colors.primary,
    },
    stat: { flex: 1, alignItems: "center", gap: 4 },
    value: { color: colors.foreground, fontSize: 18, fontWeight: "600" },
    settingsRow: {
      minHeight: 70,
      paddingVertical: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    label: { color: colors.foreground, fontSize: 16 },
  });
  return (
    <View style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 20,
          paddingHorizontal: 18,
          paddingBottom: Math.max(insets.bottom, 12) + 100,
        }}
      >
        <View style={[styles.row, { marginBottom: 22 }]}>
          <ScreenTitle
            title="Profile"
            eyebrow="Your account, settings and preferences."
          />
          <GlassButton
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
              marginLeft: "auto",
            }}
            onPress={() => router.push("/settings")}
            accessibilityLabel="App Preferences"
          >
            <Ionicons
              name="settings-outline"
              size={22}
              color={colors.foreground}
            />
          </GlassButton>
        </View>
        <GlassSurface style={styles.panel}>
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            <TouchableOpacity
              style={styles.avatar}
              onPress={pickAvatar}
              accessibilityRole="button"
              accessibilityLabel="Change profile picture"
              disabled={avatarBusy}
            >
              {userProfile.avatarUrl ? (
                <Image
                  source={{ uri: userProfile.avatarUrl }}
                  style={{ width: 70, height: 70, borderRadius: 35 }}
                  contentFit="cover"
                />
              ) : (
                <Text style={[styles.name, { color: colors.primary }]}>
                  {userProfile.name.charAt(0)}
                </Text>
              )}
              {avatarBusy && (
                <ActivityIndicator
                  style={{ position: "absolute" }}
                  color={colors.primary}
                />
              )}
            </TouchableOpacity>
            <View style={{ flex: 1, minWidth: 90 }}>
              <Text style={styles.name}>{userProfile.name}</Text>
              {userProfile.username && (
                <Text style={styles.muted}>@{userProfile.username}</Text>
              )}
            </View>
            <GlassButton
              onPress={openEdit}
              style={{ minHeight: 44, paddingHorizontal: 12, borderRadius: 20 }}
              accessibilityLabel="Edit Profile"
            >
              <Text
                style={[
                  styles.muted,
                  { color: colors.foreground, marginVertical: 12 },
                ]}
              >
                Edit Profile
              </Text>
            </GlassButton>
          </View>
          <View style={[styles.row, { marginTop: 22, gap: 0 }]}>
            {[
              [profileStats.journeys, "Drives"],
              [
                formatDistance(
                  profileStats.totalDistance,
                  resolvedUnitSystem,
                ).replace(/ (mi|km)$/, ""),
                distanceUnit(resolvedUnitSystem) === "mi"
                  ? "Miles"
                  : "Kilometres",
              ],
              [profileStats.friends, "Friends"],
              [groups.filter((g) => g.isMember).length, "Communities"],
            ].map(([value, label]) => (
              <View key={label} style={styles.stat}>
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  style={styles.value}
                >
                  {value}
                </Text>
                <Text style={[styles.muted, { fontSize: 10 }]}>{label}</Text>
              </View>
            ))}
          </View>
        </GlassSurface>
        {activeVehicle && (
          <GlassButton
            style={[styles.panel, styles.row]}
            onPress={() => router.push(`/vehicle/${activeVehicle.id}`)}
          >
            {activeVehicle.imageUri ? (
              <Image
                source={{ uri: activeVehicle.imageUri }}
                style={{ width: 80, height: 58, borderRadius: 12 }}
                contentFit="cover"
              />
            ) : (
              <Ionicons
                name="car-outline"
                size={38}
                color={colors.mutedForeground}
              />
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.muted}>Current Vehicle</Text>
              <Text style={[styles.label, { marginTop: 4 }]}>
                {activeVehicle.nickname ||
                  `${activeVehicle.make} ${activeVehicle.model}`}
              </Text>
              <Text style={styles.muted}>
                {activeVehicle.year} · {activeVehicle.make}
              </Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={colors.mutedForeground}
            />
          </GlassButton>
        )}
        <GlassSurface style={[styles.panel, { paddingVertical: 0 }]}>
          {(
            [
              [
                "person-outline",
                "Account",
                "Personal details, email and security",
                "account",
              ],
              [
                "lock-closed-outline",
                "Privacy",
                "Visibility, recordings and location",
                "privacy",
              ],
              [
                "notifications-outline",
                "Notifications",
                "Friends, communities and events",
                "notifications",
              ],
              [
                "options-outline",
                "App Preferences",
                "Units and passenger mode",
                "preferences",
              ],
              [
                "help-circle-outline",
                "Help & Support",
                "Using Derwent and connection help",
                "help",
              ],
              [
                "document-text-outline",
                "Legal",
                "Terms, privacy and licences",
                "legal",
              ],
            ] as const
          ).map(([icon, label, subtitle, section], index) => (
            <TouchableOpacity
              key={section}
              accessibilityRole="button"
              onPress={() =>
                router.push({ pathname: "/settings", params: { section } })
              }
              style={[
                styles.settingsRow,
                index === 5 && { borderBottomWidth: 0 },
              ]}
            >
              <Ionicons name={icon} size={23} color={colors.foreground} />
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{label}</Text>
                <Text style={[styles.muted, { marginTop: 3, fontSize: 12 }]}>
                  {section === "privacy" &&
                  locationSharing &&
                  locationSharing.mode !== "off"
                    ? locationSharingSummary(locationSharing)
                    : subtitle}
                </Text>
              </View>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={colors.mutedForeground}
              />
            </TouchableOpacity>
          ))}
        </GlassSurface>
        <GlassSurface style={[styles.panel, { paddingHorizontal: 0 }]}>
          <Disclosure title={`Driving record · Level ${userProfile.level}`}>
            <View style={{ paddingHorizontal: 18, gap: 12 }}>
              <Text style={styles.muted}>
                {userProfile.xp.toLocaleString()} XP ·{" "}
                {userProfile.xpToNextLevel.toLocaleString()} to next level
              </Text>
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: colors.secondary,
                }}
              >
                <View
                  style={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: colors.primary,
                    width: `${Math.max(0, Math.min(100, xpProgress * 100))}%`,
                  }}
                />
              </View>
              <Text style={styles.label}>
                Achievements · {unlockedAchievements.length}/
                {userProfile.achievements.length}
              </Text>
              {userProfile.achievements.map((ach) => (
                <View
                  key={ach.id}
                  style={[styles.row, { opacity: ach.unlockedAt ? 1 : 0.5 }]}
                >
                  <Ionicons
                    name={ach.icon as any}
                    size={20}
                    color={colors.primary}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>{ach.title}</Text>
                    <Text style={styles.muted}>{ach.description}</Text>
                  </View>
                </View>
              ))}
            </View>
          </Disclosure>
        </GlassSurface>
        <GlassButton
          style={[styles.panel, styles.row, { minHeight: 56 }]}
          onPress={handleSignOut}
          accessibilityLabel="Log Out"
        >
          <Ionicons
            name="log-out-outline"
            size={23}
            color={colors.destructive}
          />
          <Text style={[styles.label, { color: colors.destructive }]}>
            Log Out
          </Text>
        </GlassButton>
      </ScrollView>

      <KeyboardAwareSheet
        visible={editing}
        onClose={() => setEditing(false)}
        backdropColor="rgba(0,0,0,0.5)"
      >
        <View
          style={{
            backgroundColor: colors.card,
            padding: 20,
            paddingBottom: insets.bottom + 20,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            gap: 10,
          }}
        >
          <Text
            style={{
              color: colors.foreground,
              fontSize: 18,
              fontWeight: "700",
            }}
          >
            Edit profile
          </Text>
          {(
            [
              ["name", "Display name", 50],
              ["username", "Username (optional)", 30],
              ["bio", "Bio (optional)", 500],
            ] as const
          ).map(([key, label, max]) => (
            <TextInput
              key={key}
              placeholder={label}
              placeholderTextColor={colors.mutedForeground}
              value={form[key]}
              onChangeText={(t) => setForm((f) => ({ ...f, [key]: t }))}
              maxLength={max}
              autoCapitalize={key === "username" ? "none" : "sentences"}
              multiline={key === "bio"}
              style={{
                minHeight: 46,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.input,
                color: colors.foreground,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 16,
              }}
            />
          ))}
          <TouchableOpacity
            onPress={saveEdit}
            style={{
              height: 48,
              borderRadius: 12,
              backgroundColor: colors.primary,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                color: colors.primaryForeground,
                fontWeight: "600",
                fontSize: 16,
              }}
            >
              Save
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setEditing(false)}
            style={{ alignItems: "center", padding: 8 }}
          >
            <Text style={{ color: colors.primary, fontWeight: "600" }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAwareSheet>
    </View>
  );
}

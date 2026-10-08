import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  TextInput,
  Switch,
  Linking,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { GlassSurface, GlassButton } from "@/components/Glass";
import { KeyboardAwareSheet } from "@/components/KeyboardAwareSheet";
import { ScreenTitle } from "@/components/Cockpit";
import { AccountPreferences } from "@/components/AccountPreferences";
import { useSignOut } from "@/hooks/useSignOut";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/context/AuthContext";
import { describeError } from "@/lib/backend/http";
import { UNIT_SYSTEM_OPTIONS } from "@/lib/units";
import colors, { sectionAccent } from "@/constants/colors";
const c = colors.dark;
const sectionTitles: Record<string, string> = {
  account: "Account",
  privacy: "Privacy",
  notifications: "Notifications",
  preferences: "App Preferences",
  help: "Help & Support",
  legal: "Legal",
};
const subtitles: Record<string, string> = {
  account: "Your personal information and account.",
  privacy: "Control your data and how you appear to others.",
  notifications: "Choose which in-app alerts matter to you.",
  preferences: "Make Derwent feel right for you.",
  help: "A little help for the road ahead.",
  legal: "App information and policy documents.",
};
export default function SettingsScreen() {
  const { section: requested } = useLocalSearchParams<{ section?: string }>();
  const section =
    requested && sectionTitles[requested] ? requested : "preferences";
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    isPassengerMode,
    togglePassengerMode,
    unitSystem,
    setUnitSystem,
    deleteAccount,
    retrySync,
    sync,
    userProfile,
  } = useApp();
  const { email, signOut } = useAuth();
  const handleSignOut = useSignOut();
  const [showDelete, setShowDelete] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  async function handleDeleteAccount() {
    setDeleting(true);
    try {
      await deleteAccount();
      setShowDelete(false);
      await signOut().catch(() => {});
    } catch (err) {
      Alert.alert("Account not deleted", describeError(err));
    } finally {
      setDeleting(false);
    }
  }
  const legalLinks = [
    { label: "Terms", url: process.env.EXPO_PUBLIC_TERMS_URL },
    { label: "Privacy Policy", url: process.env.EXPO_PUBLIC_PRIVACY_URL },
  ];
  const openLink = (url: string) => {
    void Linking.openURL(url).catch((err) =>
      Alert.alert("Could not open link", describeError(err)),
    );
  };
  return (
    <View style={s.page}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: 18,
          paddingBottom: insets.bottom + 36,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <GlassButton
          style={s.back}
          onPress={() => router.back()}
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={23} color={c.foreground} />
        </GlassButton>
        <View style={{ marginTop: 16, marginBottom: 24 }}>
          <ScreenTitle
            title={sectionTitles[section]}
            eyebrow={subtitles[section]}
          />
        </View>
        {(section === "privacy" || section === "notifications") && (
          <AccountPreferences section={section} />
        )}
        {section === "account" && (
          <>
            <GlassSurface style={s.card}>
              <Text style={s.title}>Profile Information</Text>
              {[
                ["Name", userProfile.name],
                [
                  "Username",
                  userProfile.username ? `@${userProfile.username}` : "Not set",
                ],
                ["Email Address", email || "Linked sign-in account"],
                ["Bio", userProfile.bio || "Not set"],
              ].map(([label, value]) => (
                <View key={label} style={s.infoRow}>
                  <Text style={s.label}>{label}</Text>
                  <Text style={[s.note, { flex: 1, textAlign: "right" }]}>
                    {value}
                  </Text>
                </View>
              ))}
              <Text style={s.note}>
                Edit your name, photo and bio from Profile.
              </Text>
            </GlassSurface>
            <GlassSurface style={s.card}>
              <Text style={s.title}>Account Status</Text>
              <Text style={s.note}>
                {sync.lastSyncedAt
                  ? `Last synced ${new Date(sync.lastSyncedAt).toLocaleString("en-GB")}`
                  : "Not synced yet"}
              </Text>
              <GlassButton style={s.action} onPress={handleSignOut}>
                <Ionicons
                  name="log-out-outline"
                  size={20}
                  color={c.foreground}
                />
                <Text style={s.label}>Log Out</Text>
              </GlassButton>
            </GlassSurface>
            <GlassSurface style={s.card}>
              <Text style={s.title}>Account Management</Text>
              <GlassButton
                style={s.action}
                onPress={() => {
                  setDeleteText("");
                  setShowDelete(true);
                }}
              >
                <Ionicons
                  name="trash-outline"
                  size={20}
                  color={c.destructive}
                />
                <Text style={[s.label, { color: c.destructive }]}>
                  Delete Account
                </Text>
              </GlassButton>
            </GlassSurface>
          </>
        )}
        {section === "preferences" && (
          <>
            <GlassSurface style={s.card}>
              <Text style={s.title}>Units of Measurement</Text>
              {UNIT_SYSTEM_OPTIONS.map((option) => (
                <GlassButton
                  key={option.value}
                  style={s.action}
                  onPress={() => setUnitSystem(option.value)}
                  accessibilityState={{ selected: unitSystem === option.value }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.label}>{option.label}</Text>
                    <Text style={s.note}>{option.sub}</Text>
                  </View>
                  {unitSystem === option.value && (
                    <Ionicons
                      name="checkmark"
                      size={21}
                      color={sectionAccent.profile}
                    />
                  )}
                </GlassButton>
              ))}
            </GlassSurface>
            <GlassSurface style={s.card}>
              <View style={s.infoRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.title}>Passenger Mode</Text>
                  <Text style={s.note}>
                    Location may update, but drives, speed records and XP are
                    not recorded.
                  </Text>
                </View>
                <Switch
                  accessibilityLabel="Passenger Mode"
                  value={isPassengerMode}
                  onValueChange={togglePassengerMode}
                  trackColor={{ true: sectionAccent.profile }}
                />
              </View>
            </GlassSurface>
          </>
        )}
        {section === "help" && (
          <>
            <GlassSurface style={s.card}>
              <Text style={s.title}>On the Road</Text>
              <Text style={s.label}>Recording a drive</Text>
              <Text style={s.note}>
                Tap Start Drive on Drive. Pause, resume or finish from the
                recording controls.
              </Text>
              <Text style={s.label}>Choosing a destination</Text>
              <Text style={s.note}>
                Tap the search field on Drive. Choose a saved place or search an
                address to open directions in your maps app.
              </Text>
              <Text style={s.label}>Your vehicles</Text>
              <Text style={s.note}>
                Open a car in Garage to edit its details and photo. With
                multiple cars, use Set Primary to choose your driving vehicle.
              </Text>
            </GlassSurface>
            <GlassSurface style={s.card}>
              <Text style={s.title}>Connection & Sync</Text>
              <Text style={s.note}>
                Recorded drives and edits stay on your phone while waiting to
                upload. Keep the app open with a connection to retry.
              </Text>
              <GlassButton
                style={s.action}
                disabled={syncing}
                onPress={() => {
                  setSyncing(true);
                  void retrySync()
                    .catch((err) =>
                      Alert.alert("Sync failed", describeError(err)),
                    )
                    .finally(() => setSyncing(false));
                }}
              >
                {syncing ? (
                  <ActivityIndicator color={c.primary} />
                ) : (
                  <Ionicons name="refresh" size={20} color={c.primary} />
                )}
                <Text style={s.label}>Retry Uploads</Text>
              </GlassButton>
            </GlassSurface>
            <GlassSurface style={s.card}>
              <Text style={s.title}>Diagnostics</Text>
              <Text style={s.note}>
                A record of drive recording and crashes on this phone, to help
                investigate problems. It never includes your location or sign-in
                details.
              </Text>
              <GlassButton
                style={s.action}
                onPress={() => router.push("/diagnostics")}
              >
                <Ionicons name="pulse-outline" size={20} color={c.primary} />
                <Text style={[s.label, { flex: 1 }]}>
                  View & Share Diagnostics
                </Text>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={c.mutedForeground}
                />
              </GlassButton>
            </GlassSurface>
          </>
        )}
        {section === "legal" && (
          <>
            <GlassSurface style={s.card}>
              <Text style={s.title}>Policy Documents</Text>
              {legalLinks.map((link) => (
                <GlassButton
                  key={link.label}
                  style={s.action}
                  disabled={!link.url}
                  accessibilityState={{ disabled: !link.url }}
                  onPress={() => link.url && openLink(link.url)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.label}>{link.label}</Text>
                    {!link.url && <Text style={s.note}>Not available yet</Text>}
                  </View>
                  {link.url && (
                    <Ionicons
                      name="open-outline"
                      size={18}
                      color={c.mutedForeground}
                    />
                  )}
                </GlassButton>
              ))}
            </GlassSurface>
            <GlassSurface style={s.card}>
              <Text style={s.title}>Derwent</Text>
              <Text style={s.note}>
                Version {Constants.expoConfig?.version || "—"}
              </Text>
              <Text style={s.note}>
                Built with Expo, React Native and Supabase.
              </Text>
              <GlassButton
                style={s.action}
                onPress={() =>
                  openLink("https://github.com/expo/expo/blob/main/LICENSE")
                }
              >
                <Text style={s.label}>Expo Licence</Text>
                <Ionicons
                  name="open-outline"
                  size={18}
                  color={c.mutedForeground}
                />
              </GlassButton>
              <GlassButton
                style={s.action}
                onPress={() =>
                  openLink(
                    "https://github.com/facebook/react-native/blob/main/LICENSE",
                  )
                }
              >
                <Text style={s.label}>React Native Licence</Text>
                <Ionicons
                  name="open-outline"
                  size={18}
                  color={c.mutedForeground}
                />
              </GlassButton>
            </GlassSurface>
          </>
        )}
      </ScrollView>
      <KeyboardAwareSheet
        visible={showDelete}
        onClose={() => {
          if (!deleting) setShowDelete(false);
        }}
        backdropColor="rgba(0,0,0,0.55)"
      >
        <GlassSurface
          material="dense"
          style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
        >
          <Text style={s.title}>Delete your account?</Text>
          <Text style={s.note}>
            This permanently deletes your account and its data. Type DELETE to
            confirm.
          </Text>
          <TextInput
            accessibilityLabel="Type DELETE to confirm account deletion"
            value={deleteText}
            onChangeText={setDeleteText}
            editable={!deleting}
            autoCapitalize="characters"
            placeholder="DELETE"
            placeholderTextColor={c.mutedForeground}
            style={s.input}
          />
          <GlassButton
            style={[s.action, { justifyContent: "center" }]}
            disabled={deleteText !== "DELETE" || deleting}
            onPress={() => void handleDeleteAccount()}
          >
            {deleting ? (
              <ActivityIndicator color={c.destructive} />
            ) : (
              <Text
                style={{
                  color:
                    deleteText === "DELETE" ? c.destructive : c.mutedForeground,
                }}
              >
                Delete Account Permanently
              </Text>
            )}
          </GlassButton>
          <GlassButton
            style={[s.action, { justifyContent: "center" }]}
            disabled={deleting}
            onPress={() => setShowDelete(false)}
          >
            <Text style={s.label}>Cancel</Text>
          </GlassButton>
        </GlassSurface>
      </KeyboardAwareSheet>
    </View>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  card: { borderRadius: 22, padding: 18, marginBottom: 16, gap: 12 },
  title: { color: c.foreground, fontSize: 18, fontWeight: "600" },
  label: { color: c.foreground, fontSize: 15 },
  note: { color: c.mutedForeground, fontSize: 13, lineHeight: 20 },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  action: {
    minHeight: 52,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  sheet: {
    padding: 24,
    gap: 16,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    paddingHorizontal: 16,
    color: c.foreground,
    fontSize: 16,
  },
});

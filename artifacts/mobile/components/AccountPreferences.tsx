import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  Switch,
  ActivityIndicator,
  StyleSheet,
  Linking,
} from "react-native";
import { ep } from "@/lib/backendClient";
import { type ServerSettings, type Visibility } from "@/lib/backend/endpoints";
import { describeError } from "@/lib/backend/http";
import { showsActivityStatus } from "@/lib/backend/mappers";
import { GlassSurface, GlassButton } from "@/components/Glass";
import { Ionicons } from "@expo/vector-icons";
import colors, { sectionAccent } from "@/constants/colors";
const c = colors.dark;
const visibilityLabels: Record<Visibility, string> = {
  private: "Only Me",
  friends: "Friends",
  public: "Everyone",
};

export function AccountPreferences({
  section,
}: {
  section: "privacy" | "notifications";
}) {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!ep) throw new Error("Account settings are unavailable.");
      const profile = await ep.getMe();
      if (!profile.settings)
        throw new Error("Account settings are unavailable. Please try again.");
      setSettings(profile.settings);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function update(fields: Partial<ServerSettings>) {
    if (!ep || saving) return;
    setSaving(true);
    setError(null);
    try {
      const profile = await ep.updateSettings(fields);
      if (!profile.settings)
        throw new Error("Settings could not be confirmed. Please reload.");
      setSettings(profile.settings);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }
  const visibility = (
    label: string,
    key:
      | "profileVisibility"
      | "defaultJourneyVisibility"
      | "defaultLocationVisibility",
  ) => (
    <View style={s.row} key={key}>
      <Text style={s.label}>{label}</Text>
      <View style={s.choices}>
        {(["private", "friends", "public"] as const).map((value) => (
          <GlassButton
            key={value}
            style={[
              s.choice,
              settings?.[key] === value && {
                borderColor: sectionAccent.profile,
              },
            ]}
            onPress={() => void update({ [key]: value })}
            disabled={saving}
            accessibilityState={{
              selected: settings?.[key] === value,
              disabled: saving,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                color:
                  settings?.[key] === value
                    ? sectionAccent.profile
                    : c.mutedForeground,
              }}
            >
              {visibilityLabels[value]}
            </Text>
          </GlassButton>
        ))}
      </View>
    </View>
  );
  return (
    <View style={{ gap: 16 }}>
      {loading ? <ActivityIndicator color={sectionAccent.profile} /> : null}
      {error && (
        <GlassSurface style={s.card}>
          <Text style={{ color: c.destructive, lineHeight: 20 }}>{error}</Text>
          <GlassButton
            style={s.choice}
            onPress={() => void load()}
            disabled={saving}
          >
            <Text style={s.label}>Reload Settings</Text>
          </GlassButton>
        </GlassSurface>
      )}
      {settings && section === "privacy" && (
        <>
          <GlassSurface style={s.card}>
            <Text style={s.title}>Visibility</Text>
            {visibility("Profile", "profileVisibility")}
            {visibility("New drive recordings", "defaultJourneyVisibility")}
            {visibility("New saved places", "defaultLocationVisibility")}
            <Text style={s.note}>
              Defaults apply to new drives and places. Existing items keep their
              current visibility.
            </Text>
          </GlassSurface>
          <GlassSurface style={s.card}>
            <Text style={s.title}>Friends & Location</Text>
            <View style={s.toggle}>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Allow Friend Requests</Text>
                <Text style={s.note}>Let other drivers connect with you.</Text>
              </View>
              <Switch
                accessibilityLabel="Allow Friend Requests"
                disabled={saving}
                value={settings.allowFriendRequests === "everyone"}
                trackColor={{ true: sectionAccent.profile }}
                onValueChange={(value) =>
                  void update({
                    allowFriendRequests: value ? "everyone" : "nobody",
                  })
                }
              />
            </View>
            <View style={s.toggle}>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Show Activity Status</Text>
                <Text style={s.note}>
                  Allow friends to see when you're online, driving, or when
                  you were last active.
                </Text>
              </View>
              <Switch
                accessibilityLabel="Show Activity Status"
                disabled={saving}
                value={showsActivityStatus(settings)}
                trackColor={{ true: sectionAccent.profile }}
                onValueChange={(value) =>
                  void update({ showActivityStatus: value })
                }
              />
            </View>
            <View style={s.toggle}>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Live Location in Convoys</Text>
                <Text style={s.note}>
                  Your permission for live sharing when available.
                </Text>
              </View>
              <Switch
                accessibilityLabel="Live Location in Convoys"
                disabled={saving}
                value={settings.shareLiveLocationInConvoys}
                trackColor={{ true: sectionAccent.profile }}
                onValueChange={(value) =>
                  void update({ shareLiveLocationInConvoys: value })
                }
              />
            </View>
            <GlassButton
              style={s.permission}
              onPress={() => {
                void Linking.openSettings().catch((err) =>
                  setError(describeError(err)),
                );
              }}
            >
              <Ionicons
                name="location-outline"
                size={20}
                color={sectionAccent.profile}
              />
              <Text style={[s.label, { flex: 1 }]}>
                Device Location Permissions
              </Text>
            </GlassButton>
          </GlassSurface>
        </>
      )}
      {settings && section === "notifications" && (
        <GlassSurface style={s.card}>
          <Text style={s.title}>In-app Alerts</Text>
          {(
            [
              ["friends", "Friends"],
              ["convoys", "Convoys"],
              ["groups", "Communities"],
              ["events", "Events"],
              ["achievements", "Achievements"],
            ] as const
          ).map(([key, label]) => (
            <View key={key} style={s.toggle}>
              <Text style={[s.label, { flex: 1 }]}>{label}</Text>
              <Switch
                accessibilityLabel={`${label} notifications`}
                disabled={saving}
                value={settings.notificationPrefs[key] ?? true}
                trackColor={{ true: sectionAccent.profile }}
                onValueChange={(value) =>
                  void update({
                    notificationPrefs: {
                      ...settings.notificationPrefs,
                      [key]: value,
                    },
                  })
                }
              />
            </View>
          ))}
        </GlassSurface>
      )}
      {saving && (
        <ActivityIndicator
          color={sectionAccent.profile}
          accessibilityLabel="Saving settings"
        />
      )}
    </View>
  );
}
const s = StyleSheet.create({
  card: { borderRadius: 22, padding: 18, gap: 12 },
  title: { color: c.foreground, fontSize: 18, fontWeight: "600" },
  label: { color: c.foreground, fontSize: 15 },
  row: {
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    borderRadius: 18,
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  toggle: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  note: {
    color: c.mutedForeground,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  permission: {
    minHeight: 52,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 16,
  },
});

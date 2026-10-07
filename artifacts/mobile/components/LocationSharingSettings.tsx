import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Switch, ActivityIndicator, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "@/context/AppContext";
import { describeError } from "@/lib/backend/http";
import type {
  LocationFriendAudience,
  LocationSharingMode,
} from "@/lib/backend/liveLocation";
import type { ServerLocationSharing } from "@/lib/backend/endpoints";
import { GlassSurface, GlassButton } from "@/components/Glass";
import colors, { sectionAccent } from "@/constants/colors";
const c = colors.dark;

const MODES: Array<[LocationSharingMode, string]> = [
  ["off", "Off"],
  ["while_driving", "While Driving"],
  ["while_using", "While Using Derwent"],
];
const AUDIENCES: Array<[LocationFriendAudience, string]> = [
  ["none", "Nobody"],
  ["selected", "Selected Friends"],
  ["all", "All Friends"],
];

/** "Location Sharing · 3 people", or why nothing is shared. */
export function locationSharingSummary(
  s: ServerLocationSharing | null,
): string {
  if (!s || s.mode === "off") return "Location Sharing · Off";
  if (s.sharingWithCount === 0) return "Location Sharing · No one chosen";
  return `Location Sharing · ${s.sharingWithCount} ${s.sharingWithCount === 1 ? "person" : "people"}`;
}

/**
 * Privacy → Live Location: WHO may see your position (friends, chosen
 * Convoys) and WHEN it is shared. Everything is enforced by the server; this
 * screen only changes the settings and shows what they mean.
 */
export function LocationSharingSettings() {
  const {
    locationSharing: sharing,
    refreshLocationSharing,
    updateLocationSharing,
    setLocationShareFriend,
    setLocationShareConvoy,
  } = useApp();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await refreshLocationSharing();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [refreshLocationSharing]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  const choice = <T extends string>(
    options: Array<[T, string]>,
    current: T | undefined,
    onPick: (v: T) => void,
    label: string,
  ) => (
    <View style={s.choices} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map(([value, text]) => {
        const selected = current === value;
        return (
          <GlassButton
            key={value}
            style={[s.choice, selected && { borderColor: sectionAccent.profile }]}
            onPress={() => onPick(value)}
            disabled={!!busy}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: !!busy }}
          >
            <Text
              style={{
                fontSize: 12,
                color: selected ? sectionAccent.profile : c.mutedForeground,
              }}
            >
              {text}
            </Text>
          </GlassButton>
        );
      })}
    </View>
  );

  const off = !sharing || sharing.mode === "off";
  const eligibleConvoys = sharing?.convoys.filter((cv) => cv.eligible) ?? [];
  const otherConvoys = sharing?.convoys.filter((cv) => !cv.eligible) ?? [];

  return (
    <GlassSurface style={s.card}>
      <Text style={s.title}>Live Location</Text>
      <View style={s.summary} accessibilityLiveRegion="polite">
        <Ionicons
          name={off ? "location-outline" : "location"}
          size={18}
          color={off ? c.mutedForeground : sectionAccent.profile}
        />
        <Text style={[s.label, { flex: 1 }]}>
          {locationSharingSummary(sharing)}
        </Text>
        {sharing?.live ? <Text style={s.badge}>Sharing now</Text> : null}
      </View>
      <Text style={s.note}>
        Only people you choose can see where you are. Your live location is
        never public, and being in a Community never shares it.
      </Text>
      {loading && !sharing ? (
        <ActivityIndicator color={sectionAccent.profile} />
      ) : null}
      {error ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: c.destructive, lineHeight: 20 }}>{error}</Text>
          <GlassButton style={s.choice} onPress={() => void load()} disabled={!!busy}>
            <Text style={s.label}>Try Again</Text>
          </GlassButton>
        </View>
      ) : null}

      {sharing && (
        <>
          <View style={s.row}>
            <Text style={s.label}>When</Text>
            {choice(MODES, sharing.mode, (mode) =>
              void run("mode", () => updateLocationSharing({ mode })), "When to share")}
            <Text style={s.note}>
              {sharing.mode === "while_driving"
                ? "Shared only during a drive Derwent is recording, including with your phone locked."
                : sharing.mode === "while_using"
                  ? "Shared only while Derwent is open on screen, including during a drive. Leaving the app or locking your phone stops it at once; your drive keeps recording."
                  : "Nothing is shared."}{" "}
              Derwent never shares your location in the background outside a drive.
            </Text>
          </View>

          <View style={s.row}>
            <Text style={s.label}>Friends</Text>
            {choice(AUDIENCES, sharing.friendAudience, (friendAudience) =>
              void run("audience", () => updateLocationSharing({ friendAudience })), "Which friends")}
            {sharing.friendAudience === "selected" &&
              (sharing.friends.length ? (
                sharing.friends.map((f) => (
                  <View key={f.id} style={s.toggle}>
                    <Text style={[s.label, { flex: 1 }]}>{f.displayName}</Text>
                    <Switch
                      accessibilityLabel={`Share live location with ${f.displayName}`}
                      disabled={!!busy}
                      value={f.selected}
                      trackColor={{ true: sectionAccent.profile }}
                      onValueChange={(on) =>
                        void run(`friend:${f.id}`, () => setLocationShareFriend(f.id, on))
                      }
                    />
                  </View>
                ))
              ) : (
                <Text style={s.note}>Add friends to choose who can see you.</Text>
              ))}
          </View>

          <View style={[s.row, { borderBottomWidth: 0 }]}>
            <Text style={s.label}>Convoys</Text>
            <Text style={s.note}>
              Joining a Convoy never shares your location. Turn it on for each
              Convoy you want; its members see you while it applies, and it
              stops if you leave.
            </Text>
            {eligibleConvoys.map((cv) => (
              <View key={cv.id} style={s.toggle}>
                <View style={{ flex: 1 }}>
                  <Text style={s.label}>{cv.name}</Text>
                  <Text style={s.note}>
                    {cv.otherMembers} {cv.otherMembers === 1 ? "other member" : "other members"}
                  </Text>
                </View>
                <Switch
                  accessibilityLabel={`Share live location with ${cv.name}`}
                  disabled={!!busy}
                  value={cv.shared}
                  trackColor={{ true: sectionAccent.profile }}
                  onValueChange={(on) =>
                    void run(`convoy:${cv.id}`, () => setLocationShareConvoy(cv.id, on))
                  }
                />
              </View>
            ))}
            {otherConvoys.map((cv) => (
              <View key={cv.id} style={s.toggle}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.label, { color: c.mutedForeground }]}>{cv.name}</Text>
                  <Text style={s.note}>
                    Not available: people can join this Convoy without an
                    invitation code.
                  </Text>
                </View>
                <Switch accessibilityLabel={`${cv.name} can't be shared with`} disabled value={false} />
              </View>
            ))}
            {!sharing.convoys.length && (
              <Text style={s.note}>You're not in any upcoming Convoys.</Text>
            )}
          </View>
          {off && (sharing.friendAudience !== "none" || eligibleConvoys.some((cv) => cv.shared)) ? (
            <Text style={s.note}>Sharing is off, so none of these see you.</Text>
          ) : null}
        </>
      )}
      {busy ? (
        <ActivityIndicator color={sectionAccent.profile} accessibilityLabel="Saving" />
      ) : null}
    </GlassSurface>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: 22, padding: 18, gap: 12 },
  title: { color: c.foreground, fontSize: 18, fontWeight: "600" },
  label: { color: c.foreground, fontSize: 15 },
  summary: { flexDirection: "row", alignItems: "center", gap: 8 },
  badge: {
    color: sectionAccent.profile,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
  },
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
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
  },
  note: { color: c.mutedForeground, fontSize: 12, lineHeight: 18 },
});

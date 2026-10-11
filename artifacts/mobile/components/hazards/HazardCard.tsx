/**
 * A tapped hazard marker: what it is, how long ago it was reported, and
 * "Still there" / "Not there". Never who reported it or who voted: the
 * server never sends that. A driver's own report or vote is shown as such
 * (the only identity they see is their own), and they can vote only once.
 *
 * It reads the selected hazard itself, so it closes on its own when the
 * hazard expires or is cleared. It shares its place with a friend's live
 * card: opening either closes the other.
 */
import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { HazardActionError, useHazardActions, useSelectedHazard } from "@/context/HazardsContext";
import { kindInfo, reportedAgo } from "@/lib/hazards/model";
import { friendMapSelection } from "@/lib/liveMap";

const FG = "#F3F5F7";
const MUTED = "rgba(243,245,247,0.65)";

export function HazardCard({ style }: { style?: StyleProp<ViewStyle> }) {
  const hazard = useSelectedHazard();
  const { select, vote } = useHazardActions();
  const [busy, setBusy] = useState<"still_there" | "not_there" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // "Reported 12 min ago" moves on while the card is open
  useEffect(() => {
    if (!hazard) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [hazard?.id]);
  useEffect(() => {
    setMessage(null);
    setBusy(null);
    // One card at a time: a hazard's replaces a friend's
    if (hazard) friendMapSelection.select(null);
  }, [hazard?.id]);
  // ...and a friend's replaces a hazard's
  useEffect(
    () => friendMapSelection.subscribe(() => {
      if (friendMapSelection.current != null) select(null);
    }),
    [select],
  );

  if (!hazard) return null;
  const info = kindInfo(hazard.kind);
  const mine = hazard.myVote;
  const status =
    mine === "reported" ? "You reported this"
      : mine === "still_there" ? "You said it's still there"
        : mine === "not_there" ? "You said it's gone"
          : null;

  const cast = async (choice: "still_there" | "not_there") => {
    if (busy) return;
    Haptics.selectionAsync();
    setBusy(choice);
    setMessage(null);
    try {
      await vote(hazard.id, choice);
      setMessage(choice === "still_there" ? "Thanks. Others will see it's still there." : "Thanks. It's removed once others agree.");
    } catch (err) {
      setMessage(err instanceof HazardActionError ? err.message : "That didn't go through.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <GlassSurface material="dense" style={[styles.card, style]} accessibilityLiveRegion="polite">
      <View style={styles.row}>
        <View style={[styles.badge, { backgroundColor: info.color }]}>
          <Ionicons name={info.icon as keyof typeof Ionicons.glyphMap} size={20} color="#fff" />
        </View>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {info.label}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {reportedAgo(hazard.reportedAt, now)}
            {hazard.confirmations > 0 ? ` · confirmed by ${hazard.confirmations}` : ""}
          </Text>
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={() => select(null)}>
          <Ionicons name="close" size={22} color={MUTED} />
        </TouchableOpacity>
      </View>
      {status || message ? <Text style={styles.note}>{message ?? status}</Text> : null}
      {mine ? null : (
        <View style={styles.actions}>
          <GlassButton
            accessibilityRole="button"
            accessibilityLabel="Still there"
            style={styles.action}
            disabled={busy != null}
            onPress={() => void cast("still_there")}
          >
            {busy === "still_there" ? <ActivityIndicator color={FG} /> : <Text style={styles.actionText}>Still there</Text>}
          </GlassButton>
          <GlassButton
            accessibilityRole="button"
            accessibilityLabel="Not there"
            style={styles.action}
            disabled={busy != null}
            onPress={() => void cast("not_there")}
          >
            {busy === "not_there" ? <ActivityIndicator color={FG} /> : <Text style={styles.actionText}>Not there</Text>}
          </GlassButton>
        </View>
      )}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, padding: 14, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  badge: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
  title: { color: FG, fontSize: 17, fontWeight: "700" },
  sub: { color: MUTED, fontSize: 13, marginTop: 1 },
  note: { color: MUTED, fontSize: 13 },
  actions: { flexDirection: "row", gap: 10 },
  action: { flex: 1, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  actionText: { color: FG, fontSize: 15, fontWeight: "600" },
});

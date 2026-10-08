// The compact card shown when a friend's live marker is tapped: who, whether
// they're driving (with current speed when known) or stationary, and how
// fresh the position is. It reads the selection and the shared positions
// itself, so opening it or ticking "Updated 4s ago" never re-renders the
// Drive screen or the map. It closes by itself when the position goes
// (revoked, expired, sharing stopped). It never moves the camera.

import React, { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassSurface } from "@/components/Glass";
import { useSharedLocations } from "@/context/AppContext";
import { buildMarkerModels, friendMapSelection, statusLine, updatedAgo } from "@/lib/liveMap";
import { FRIEND_ACCENT } from "./FriendMarkerFace";
import { useSharerIdentities } from "./useFriendMarkers";

export const FriendLiveCard = memo(function FriendLiveCard({
  units,
  style,
}: {
  units: "imperial" | "metric";
  style?: StyleProp<ViewStyle>;
}) {
  const selectedId = useSyncExternalStore(
    useCallback((fn: () => void) => friendMapSelection.subscribe(fn), []),
    () => friendMapSelection.current,
  );
  const locations = useSharedLocations();
  const location = useMemo(
    () => (selectedId ? locations.find((l) => l.userId === selectedId) ?? null : null),
    [locations, selectedId],
  );
  const ids = useMemo(() => (selectedId ? [selectedId] : []), [selectedId]);
  const identities = useSharerIdentities(ids);
  const [now, setNow] = useState(() => Date.now());

  // Ticks only while the card is open
  useEffect(() => {
    if (!location) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [location]);

  // The position went away (revoked, expired, stopped): close
  useEffect(() => {
    if (selectedId && !location) friendMapSelection.select(null);
  }, [selectedId, location]);

  if (!location) return null;
  const model = buildMarkerModels([location], identities, now)[0];
  if (!model) return null;

  return (
    <GlassSurface material="dense" style={[s.card, style]}>
      <View style={[s.avatar, model.mode === "driving" && s.avatarDriving]}>
        {model.avatarUrl ? (
          <Image source={{ uri: model.avatarUrl }} style={s.avatarImage} />
        ) : (
          <Text style={s.initials}>{model.initials}</Text>
        )}
      </View>
      <View style={{ flex: 1 }} accessibilityLiveRegion="polite">
        <Text style={s.name} numberOfLines={1}>{model.name}</Text>
        <Text style={[s.status, model.mode === "driving" && { color: FRIEND_ACCENT }]} numberOfLines={1}>
          {statusLine(model, units)}
        </Text>
        <Text style={[s.updated, model.stale && s.staleText]}>{updatedAgo(model.recordedAt, now)}</Text>
      </View>
      <Pressable
        onPress={() => friendMapSelection.select(null)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={s.close}
      >
        <Ionicons name="close" size={18} color="#A9B3BE" />
      </Pressable>
    </GlassSurface>
  );
});

const s = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 20,
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 8,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#141A20",
    borderWidth: 2,
    borderColor: "rgba(57,217,160,0.75)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarDriving: { borderColor: FRIEND_ACCENT, borderWidth: 3 },
  avatarImage: { width: 40, height: 40, borderRadius: 20 },
  initials: { color: "#F3F5F7", fontSize: 15, fontWeight: "700" },
  name: { color: "#F3F5F7", fontSize: 16, fontWeight: "600" },
  status: { color: "#F3F5F7", fontSize: 13, marginTop: 2 },
  updated: { color: "#A9B3BE", fontSize: 12, marginTop: 2 },
  staleText: { color: "#F0B575" },
  close: { padding: 6, alignSelf: "flex-start" },
});

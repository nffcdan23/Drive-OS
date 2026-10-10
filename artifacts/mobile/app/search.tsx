/**
 * Search: where are we going? Typing shows the user's own matches at once
 * (saved places, Beauty Spots, recent destinations, nearby shared spots;
 * these work offline) and Mapbox Search Box results under them (addresses,
 * postcodes, towns, businesses), or goes straight to coordinates typed or
 * pasted in. Choosing any of them opens the same route preview on the Drive
 * map (Navigation Phase 2A).
 *
 * With nothing typed: Home and Work, recent destinations, saved places and
 * Beauty Spots, as before. Places are stored in the user's account; recent
 * destinations on this device only. Search Box results are used for the
 * preview only and never stored (Mapbox's terms).
 */
import { GlassSurface } from "@/components/Glass";
import { openDirections } from "@/lib/directions";
import {
  placeDestination,
  spotDestination,
  useRouteToPlace,
} from "@/hooks/useRouteToPlace";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp, type NearbySpot, type SavedPlace } from "@/context/AppContext";
import {
  useDestinationSearch,
  useRecentDestinations,
} from "@/context/NavigationContext";
import {
  KIND_ICON,
  KIND_LABEL,
  SavePlaceSheet,
  VISIBILITY_LABEL,
  currentPosition,
} from "@/components/places/SavePlaceSheet";
import { describeError } from "@/lib/backend/http";
import { formatShortDistance } from "@/lib/units";
import { coordinateDestination, formatCoordinates } from "@/lib/navigation/coordinates";
import { localMatches, type LocalMatch } from "@/lib/navigation/localResults";
import type { Destination } from "@/lib/navigation/model";
import { SEARCH, type SearchResult, type SearchResultKind } from "@/lib/navigation/search";

type Section = "saved" | "spots";

const RESULT_ICON: Record<SearchResultKind, keyof typeof Ionicons.glyphMap> = {
  poi: "business-outline",
  address: "home-outline",
  street: "git-commit-outline",
  postcode: "mail-outline",
  place: "business-outline",
  region: "map-outline",
  other: "location-outline",
};
const LOCAL_ICON: Record<LocalMatch["icon"], keyof typeof Ionicons.glyphMap> = {
  saved: "bookmark-outline",
  spot: "triangle-outline",
  recent: "time-outline",
  home: "home-outline",
  work: "briefcase-outline",
};

export default function PlacesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { places, addPlace, deletePlace, findNearbySpots, isDriving, resolvedUnitSystem } = useApp();
  // A route preview on the Drive map, or the phone's maps app as before
  const routeToPlace = useRouteToPlace();
  // Mapbox Search Box: only where a result can be previewed on the Mapbox map
  const { search, state: remote } = useDestinationSearch(isDriving);
  const recents = useRecentDestinations();
  const [query, setQueryText] = useState("");
  const params = useLocalSearchParams<{ section?: string }>();
  const [section, setSection] = useState<Section>(
    params.section === "spots" ? "spots" : "saved",
  );
  const [showSave, setShowSave] = useState(false);
  const [nearby, setNearby] = useState<NearbySpot[] | null>(null);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  // The search result being looked up (one at a time)
  const [opening, setOpening] = useState<string | null>(null);

  const setQuery = (text: string) => {
    setQueryText(text);
    search.setQuery(text);
  };
  const typing = !!query.trim();

  const saved = useMemo(
    () => places.filter((p) => p.kind !== "beauty_spot"),
    [places],
  );
  const mySpots = useMemo(
    () => places.filter((p) => p.kind === "beauty_spot"),
    [places],
  );
  const home = saved.find((p) => p.kind === "home");
  const work = saved.find((p) => p.kind === "work");

  const loadNearby = useCallback(async () => {
    setNearbyLoading(true);
    setNearbyError(null);
    try {
      const pos = await currentPosition();
      setNearby(await findNearbySpots(pos.latitude, pos.longitude, 50_000));
    } catch (err) {
      setNearbyError(describeError(err));
    } finally {
      setNearbyLoading(false);
    }
  }, [findNearbySpots]);

  useEffect(() => {
    if (section === "spots" && nearby === null && !nearbyLoading)
      void loadNearby();
  }, [section, nearby, nearbyLoading, loadNearby]);

  const local = useMemo(
    () =>
      localMatches(query, {
        places,
        recents: recents.items,
        nearby: nearby ?? [],
      }),
    [query, places, recents.items, nearby],
  );

  const confirmDelete = (p: SavedPlace) =>
    Alert.alert(
      `Delete "${p.name}"?`,
      "It will be removed from your account on all devices.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deletePlace(p.id),
        },
      ],
    );

  const go = (destination: Destination) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void routeToPlace(destination);
  };

  // A Search Box result: where it is (retrieve), then the same preview as any place
  const openResult = async (r: SearchResult) => {
    if (opening) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setOpening(r.id);
    try {
      const destination = await search.select(r);
      await routeToPlace(destination);
    } catch (err) {
      Alert.alert("Couldn't open that place", describeError(err));
    } finally {
      setOpening(null);
    }
  };

  const submit = () => {
    if (remote.coordinates) go(coordinateDestination(remote.coordinates));
    else if (remote.status === "ready" && remote.results[0]) void openResult(remote.results[0]);
    else if (!search.available && typing) void openDirections(query);
  };

  const s = styles(colors, insets.top, insets.bottom);

  const PlaceRow = ({ p }: { p: SavedPlace }) => (
    <TouchableOpacity
      style={s.row}
      onPress={() => go(placeDestination(p))}
      onLongPress={() => confirmDelete(p)}
      accessibilityHint="Long-press to delete"
    >
      <View style={s.iconWrap}>
        <Ionicons name={KIND_ICON[p.kind]} size={18} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.name}>{p.name}</Text>
        <Text style={s.meta} numberOfLines={1}>
          {KIND_LABEL[p.kind]}
          {p.kind === "beauty_spot"
            ? ` · ${VISIBILITY_LABEL[p.visibility]}`
            : p.address
              ? ` · ${p.address}`
              : ""}
          {p.syncState === "pending" ? " · Waiting to upload" : ""}
        </Text>
      </View>
      <TouchableOpacity
        onPress={() => confirmDelete(p)}
        hitSlop={10}
        accessibilityLabel={`Delete ${p.name}`}
      >
        <Ionicons
          name="trash-outline"
          size={18}
          color={colors.mutedForeground}
        />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  const DestinationRow = ({
    icon,
    title,
    detail,
    onPress,
    onLongPress,
    busy,
    label,
  }: {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    detail: string | null;
    onPress: () => void;
    onLongPress?: () => void;
    busy?: boolean;
    label?: string;
  }) => (
    <TouchableOpacity
      style={s.row}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label ?? `${title}${detail ? `, ${detail}` : ""}`}
    >
      <View style={s.iconWrap}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.name} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={s.meta} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {busy ? <ActivityIndicator color={colors.primary} /> : null}
    </TouchableOpacity>
  );

  // ── With something typed: coordinates, the user's own matches, then Search Box ──
  function results() {
    return (
      <>
        {remote.coordinates ? (
          <DestinationRow
            icon="pin-outline"
            title="Dropped Pin"
            detail={formatCoordinates(remote.coordinates)}
            label={`Go to coordinates ${formatCoordinates(remote.coordinates)}`}
            onPress={() => go(coordinateDestination(remote.coordinates!))}
          />
        ) : null}
        {local.length ? <Text style={s.header}>Your places</Text> : null}
        {local.map((m) => (
          <DestinationRow
            key={m.destination.id}
            icon={LOCAL_ICON[m.icon]}
            title={m.destination.name}
            detail={m.detail}
            onPress={() => go(m.destination)}
          />
        ))}
        {remote.coordinates ? null : remoteSection()}
      </>
    );
  }

  function remoteSection() {
    if (!search.available) {
      // Not on the Mapbox map (or a drive is recording): the phone's maps app
      return (
        <DestinationRow
          icon="search"
          title={query.trim()}
          detail="Find directions in Maps"
          label={`Find directions to ${query.trim()} in Maps`}
          onPress={() => void openDirections(query)}
        />
      );
    }
    if (query.trim().length < SEARCH.minQueryLength) return null;
    return (
      <>
        <Text style={s.header}>Places</Text>
        {remote.status === "loading" && !remote.results.length ? (
          <View style={s.statusRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={s.meta}>Searching…</Text>
          </View>
        ) : null}
        {remote.status === "ready" && !remote.results.length ? (
          <Text style={s.sectionNote}>No places found. Try a postcode or town.</Text>
        ) : null}
        {remote.status === "offline" ||
        remote.status === "error" ||
        remote.status === "unavailable" ? (
          <View style={s.statusRow}>
            <Ionicons
              name={remote.status === "offline" ? "cloud-offline-outline" : "alert-circle-outline"}
              size={18}
              color={colors.mutedForeground}
            />
            <Text style={[s.meta, { flex: 1, marginTop: 0 }]}>{remote.message}</Text>
            {remote.status !== "unavailable" ? (
              <TouchableOpacity accessibilityRole="button" onPress={() => search.retry()} hitSlop={8}>
                <Text style={s.retry}>Retry</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
        {remote.results.map((r) => (
          <DestinationRow
            key={r.id}
            icon={RESULT_ICON[r.kind]}
            title={r.name}
            detail={
              [
                r.distanceM != null ? formatShortDistance(r.distanceM, resolvedUnitSystem) : null,
                r.category,
                r.subtitle,
              ]
                .filter(Boolean)
                .join(" · ") || null
            }
            busy={opening === r.id}
            onPress={() => void openResult(r)}
          />
        ))}
        {remote.results.length ? (
          <Text style={s.sectionNote}>Place search by Mapbox</Text>
        ) : null}
      </>
    );
  }

  // ── Nothing typed: Home and Work, recent destinations, then the tabs ──
  function content() {
    if (section === "saved") {
      return (
        <>
          {recents.items.length ? <Text style={s.header}>Recent</Text> : null}
          {recents.items.slice(0, 5).map((r) => (
            <DestinationRow
              key={r.id}
              icon="time-outline"
              title={r.name}
              detail={r.subtitle}
              onPress={() => go(r)}
              onLongPress={() => recents.remove(r.id)}
            />
          ))}
          <Text style={s.header}>Saved places</Text>
          {saved.length ? (
            saved.map((p) => <PlaceRow key={p.id} p={p} />)
          ) : (
            <Text style={s.empty}>
              No saved places yet. Save where you are with the button below,
              or save any place from its route preview.
            </Text>
          )}
        </>
      );
    }
    const others = (nearby ?? []).filter((n) => !n.isOwn);
    return (
      <>
        <Text style={s.header}>My Beauty Spots</Text>
        {mySpots.map((p) => (
          <PlaceRow key={p.id} p={p} />
        ))}
        {!mySpots.length ? (
          <Text style={s.empty}>You haven't saved any Beauty Spots yet.</Text>
        ) : null}
        <View style={s.nearbyHeader}>
          <Text style={s.header}>Shared nearby</Text>
          <TouchableOpacity onPress={loadNearby} hitSlop={10}>
            <Ionicons name="refresh" size={18} color={colors.primary} />
          </TouchableOpacity>
        </View>
        {nearbyLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 16 }} />
        ) : null}
        {nearbyError ? (
          <Text style={[s.empty, { color: colors.destructive }]}>
            {nearbyError}
          </Text>
        ) : null}
        {!nearbyLoading && !nearbyError && nearby && !others.length ? (
          <Text style={s.empty}>No shared Beauty Spots within 50 km.</Text>
        ) : null}
        {others.map((n) => (
          <TouchableOpacity
            key={n.id}
            style={s.row}
            accessibilityRole="button"
            accessibilityLabel={`Directions to ${n.name}`}
            onPress={() => go(spotDestination(n))}
          >
            <View style={s.iconWrap}>
              <Ionicons
                name="triangle-outline"
                size={18}
                color={colors.primary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{n.name}</Text>
              <Text style={s.meta}>
                {n.distanceM != null
                  ? `${(n.distanceM / 1000).toFixed(1)} km away`
                  : ""}
                {n.visibility === "friends" ? " · Friend" : ""}
              </Text>
            </View>
          </TouchableOpacity>
        ))}
      </>
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={s.searchHeader}>
        <GlassSurface style={s.searchInputWrap}>
          <Ionicons name="search" size={18} color={colors.mutedForeground} />
          <TextInput
            style={s.searchInput}
            placeholder="Address, postcode, place or coordinates"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Search destinations"
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={submit}
          />
          {query ? (
            <TouchableOpacity
              accessibilityLabel="Clear search"
              onPress={() => setQuery("")}
            >
              <Ionicons
                name="close-circle"
                size={18}
                color={colors.mutedForeground}
              />
            </TouchableOpacity>
          ) : null}
        </GlassSurface>
        <TouchableOpacity style={s.cancelBtn} onPress={() => router.back()}>
          <Text style={s.cancelText}>Close</Text>
        </TouchableOpacity>
      </View>
      {typing ? null : (
        <>
          {home || work ? (
            <View style={s.shortcuts}>
              {[home, work].map((p) =>
                p ? (
                  <TouchableOpacity
                    key={p.id}
                    style={s.shortcut}
                    accessibilityRole="button"
                    accessibilityLabel={`Go ${p.kind === "home" ? "home" : "to work"}`}
                    onPress={() => go(placeDestination(p))}
                  >
                    <Ionicons name={KIND_ICON[p.kind]} size={18} color={colors.primary} />
                    <Text style={s.shortcutText}>{KIND_LABEL[p.kind]}</Text>
                  </TouchableOpacity>
                ) : null,
              )}
            </View>
          ) : null}
          <View style={s.tabs}>
            {(["saved", "spots"] as const).map((t) => (
              <TouchableOpacity
                key={t}
                style={[s.tab, section === t && s.tabActive]}
                onPress={() => setSection(t)}
              >
                <Text style={[s.tabText, section === t && s.tabTextActive]}>
                  {t === "saved" ? "Saved" : "Beauty Spots"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
      <FlatList
        data={[null]}
        renderItem={() => <View>{typing ? results() : content()}</View>}
        keyExtractor={() => "c"}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
      />
      {typing ? null : (
        <TouchableOpacity
          style={s.saveBtn}
          onPress={() => setShowSave(true)}
          accessibilityRole="button"
        >
          <Ionicons
            name="add-circle-outline"
            size={20}
            color={colors.primaryForeground}
          />
          <Text style={s.saveText}>Save where I am</Text>
        </TouchableOpacity>
      )}
      <SavePlaceSheet
        visible={showSave}
        defaultKind={section === "spots" ? "beauty_spot" : "favourite_road"}
        onClose={() => setShowSave(false)}
        onSave={addPlace}
      />
    </KeyboardAvoidingView>
  );
}

const styles = (c: ReturnType<typeof useColors>, top: number, bottom: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    searchHeader: {
      paddingTop: top + 16,
      paddingHorizontal: 16,
      paddingBottom: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    searchInputWrap: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      height: 44,
      borderRadius: 12,
    },
    searchInput: { flex: 1, color: c.foreground, fontSize: 16 },
    cancelBtn: { paddingHorizontal: 4 },
    cancelText: { color: c.primary, fontSize: 15, fontWeight: "600" },
    tabs: {
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    tab: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 16,
      backgroundColor: c.muted,
    },
    tabActive: { backgroundColor: c.primary },
    tabText: { color: c.mutedForeground, fontWeight: "600", fontSize: 13 },
    tabTextActive: { color: c.primaryForeground },
    list: { paddingBottom: bottom + 100 },
    header: {
      color: c.mutedForeground,
      fontSize: 12,
      fontWeight: "600",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 6,
    },
    nearbyHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingRight: 20,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: c.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    name: { color: c.foreground, fontSize: 15, fontWeight: "600" },
    meta: { color: c.mutedForeground, fontSize: 12, marginTop: 2 },
    empty: {
      color: c.mutedForeground,
      paddingHorizontal: 20,
      paddingVertical: 8,
    },
    saveBtn: {
      position: "absolute",
      left: 20,
      right: 20,
      bottom: bottom + 16,
      height: 50,
      borderRadius: 14,
      backgroundColor: c.primary,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    saveText: { color: c.primaryForeground, fontWeight: "600", fontSize: 16 },
    sectionNote: {
      color: c.mutedForeground,
      fontSize: 13,
      paddingHorizontal: 20,
      paddingVertical: 6,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    retry: { color: c.primary, fontWeight: "600", fontSize: 14 },
    shortcuts: {
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    shortcut: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 14,
      height: 44,
      borderRadius: 12,
      backgroundColor: c.muted,
    },
    shortcutText: { color: c.foreground, fontWeight: "600", fontSize: 14 },
  });

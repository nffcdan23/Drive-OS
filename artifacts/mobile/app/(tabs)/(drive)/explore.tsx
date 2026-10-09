import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Image,
  TextInput,
  ActivityIndicator,
  Modal,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { SectionHeader, EventPreviewCard } from "@/components/Discovery";
import { ScreenTitle } from "@/components/Cockpit";
import { useApp, type NearbySpot, type SavedPlace } from "@/context/AppContext";
import {
  placeDestination,
  spotDestination,
  useRouteToPlace,
} from "@/hooks/useRouteToPlace";
import colors from "@/constants/colors";
import { requestForegroundLocation } from "@/lib/locationPermission";
import { describeError } from "@/lib/backend/http";
import { formatDistance } from "@/lib/units";
const c = colors.dark;
const durations = ["30 min", "1 hr", "2 hr", "4 hr+"];
const roads = ["B-roads", "A-roads", "Motorways"];

export default function ExploreScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { journeys, places, events, findNearbySpots, resolvedUnitSystem } =
    useApp();
  // A route preview on the Drive map, or the phone's maps app as before
  const routeToPlace = useRouteToPlace();
  const [duration, setDuration] = useState("1 hr");
  const [preferences, setPreferences] = useState(["B-roads"]);
  const [mode, setMode] = useState<"loop" | "destination">("loop");
  const [destination, setDestination] = useState<SavedPlace | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [nearby, setNearby] = useState<NearbySpot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = journeys.flatMap((j) => j.photos)[0];
  const matches = (name: string) =>
    name.toLowerCase().includes(query.trim().toLowerCase());
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const nearbyEvents = events.filter(
    (e) => matches(e.name) && e.date >= todayIso,
  );
  const savedSpots = places.filter((p) => matches(p.name));
  const loadNearby = useCallback(
    async (request = true) => {
      setBusy(true);
      setError(null);
      try {
        const permission = request
          ? await requestForegroundLocation()
          : await Location.getForegroundPermissionsAsync();
        if (permission.status !== "granted") {
          if (request)
            setError("Allow location access to find places around you.");
          return;
        }
        const position =
          (await Location.getLastKnownPositionAsync({ maxAge: 60_000 })) ??
          (await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          }));
        setNearby(
          await findNearbySpots(
            position.coords.latitude,
            position.coords.longitude,
            50_000,
          ),
        );
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [findNearbySpots],
  );
  useEffect(() => {
    void loadNearby(false);
  }, [loadNearby]);
  const spots = (nearby ?? []).filter(
    (p) => matches(p.name) && !places.some((saved) => saved.id === p.id),
  );
  return (
    <View style={s.page}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: Math.max(insets.bottom, 12) + 100,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.header}>
          <GlassButton
            style={s.back}
            onPress={() => router.back()}
            accessibilityLabel="Back to Drive"
          >
            <Ionicons name="arrow-back" size={22} color={c.foreground} />
          </GlassButton>
          <ScreenTitle
            title="Explore"
            eyebrow="Find places worth driving for."
          />
        </View>
        <GlassSurface style={s.search}>
          <Ionicons name="search" size={19} color={c.mutedForeground} />
          <TextInput
            accessibilityLabel="Search places and events"
            value={query}
            onChangeText={setQuery}
            placeholder="Search roads, places or events"
            placeholderTextColor={c.mutedForeground}
            style={s.input}
          />
        </GlassSurface>
        <GlassSurface style={s.planner}>
          {!!photo && (
            <Image
              source={{ uri: photo }}
              style={[StyleSheet.absoluteFill, { opacity: 0.18 }]}
              resizeMode="cover"
            />
          )}
          <View style={s.plannerHeading}>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>Build Your Route</Text>
              <Text style={s.description}>A great drive, at your pace.</Text>
            </View>
            <Ionicons name="git-branch-outline" size={32} color={c.primary} />
          </View>
          <View style={s.options}>
            {durations.map((value) => (
              <GlassButton
                key={value}
                accessibilityLabel={`Drive duration, ${value}`}
                style={[s.chip, value === duration && s.selected]}
                onPress={() => setDuration(value)}
                accessibilityState={{ selected: value === duration }}
              >
                <Text
                  style={[
                    s.chipText,
                    value === duration && { color: c.primary },
                  ]}
                >
                  {value}
                </Text>
              </GlassButton>
            ))}
          </View>
          <View style={s.options}>
            {roads.map((value) => (
              <GlassButton
                key={value}
                accessibilityLabel={`Road preference, ${value}`}
                style={[s.chip, preferences.includes(value) && s.selected]}
                onPress={() =>
                  setPreferences((p) =>
                    p.includes(value)
                      ? p.filter((r) => r !== value)
                      : [...p, value],
                  )
                }
                accessibilityState={{ selected: preferences.includes(value) }}
              >
                <Text
                  style={[
                    s.chipText,
                    preferences.includes(value) && { color: c.primary },
                  ]}
                >
                  {value}
                </Text>
              </GlassButton>
            ))}
          </View>
          <View style={s.options}>
            <GlassButton
              style={[s.chip, { flex: 1 }, mode === "loop" && s.selected]}
              onPress={() => setMode("loop")}
              accessibilityState={{ selected: mode === "loop" }}
            >
              <Ionicons
                name="repeat"
                size={17}
                color={mode === "loop" ? c.primary : c.foreground}
              />
              <Text style={s.chipText}>Loop Route</Text>
            </GlassButton>
            <GlassButton
              style={[
                s.chip,
                { flex: 1 },
                mode === "destination" && s.selected,
              ]}
              onPress={() => {
                setMode("destination");
                setPicking(true);
              }}
              accessibilityState={{ selected: mode === "destination" }}
            >
              <Ionicons
                name="location-outline"
                size={17}
                color={c.foreground}
              />
              <Text numberOfLines={1} style={[s.chipText, { flexShrink: 1 }]}>
                {destination?.name || "Destination"}
              </Text>
            </GlassButton>
          </View>
          <GlassButton
            material="accent"
            disabled
            accessibilityState={{ disabled: true }}
            accessibilityLabel="Build Route, coming soon"
            style={s.build}
          >
            <Ionicons name="play" size={21} color={c.primaryForeground} />
            <Text style={s.buildText}>Build Route</Text>
          </GlassButton>
          <Text style={s.coming}>
            Route generation is coming soon. Discover places below.
          </Text>
        </GlassSurface>
        <SectionHeader
          title="Around You"
          onPress={() =>
            router.push({ pathname: "/search", params: { section: "spots" } })
          }
        />
        {busy ? <ActivityIndicator color={c.primary} /> : null}
        {error && <Text style={s.error}>{error}</Text>}
        {(savedSpots.length > 0 || spots.length > 0) && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.carousel}
          >
            {[...savedSpots, ...spots].map((p) => (
              <GlassButton
                key={p.id}
                style={s.place}
                onPress={() =>
                  void routeToPlace(
                    "isOwn" in p ? spotDestination(p) : placeDestination(p),
                  )
                }
              >
                <View style={s.placeImage}>
                  <Ionicons
                    name={
                      p.category === "scenic_road"
                        ? "map-outline"
                        : "location-outline"
                    }
                    size={38}
                    color={c.primary}
                  />
                </View>
                <Text style={s.placeName} numberOfLines={2}>
                  {p.name}
                </Text>
                <Text style={s.description}>
                  {(p.category || "Saved place").replace(/_/g, " ")}
                </Text>
                {"distanceM" in p && p.distanceM != null && (
                  <Text style={s.description}>
                    {formatDistance(p.distanceM / 1000, resolvedUnitSystem)}{" "}
                    away
                  </Text>
                )}
              </GlassButton>
            ))}
          </ScrollView>
        )}
        {!busy && !savedSpots.length && !spots.length && (
          <GlassSurface style={s.empty}>
            <Ionicons name="compass-outline" size={30} color={c.primary} />
            <Text style={s.description}>
              {nearby === null
                ? "Find scenic roads and shared places near you."
                : "No places found. Save a favourite or explore a little further."}
            </Text>
            <GlassButton style={s.chip} onPress={() => void loadNearby()}>
              <Text style={s.chipText}>
                {error ? "Try Again" : "Find Nearby Places"}
              </Text>
            </GlassButton>
          </GlassSurface>
        )}
        <SectionHeader
          title="Community Events"
          onPress={() =>
            router.push({
              pathname: "/(tabs)/community",
              params: { section: "events" },
            })
          }
        />
        {nearbyEvents.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.carousel}
          >
            {nearbyEvents.map((e) => (
              <EventPreviewCard
                key={e.id}
                event={e}
                onPress={() => router.push(`/event/${e.id}`)}
              />
            ))}
          </ScrollView>
        ) : (
          <GlassSurface style={s.empty}>
            <Ionicons
              name="calendar-outline"
              size={28}
              color={c.mutedForeground}
            />
            <Text style={s.description}>
              {query
                ? "No events match your search."
                : "No upcoming events yet. Find your community in Social."}
            </Text>
          </GlassSurface>
        )}
      </ScrollView>
      <Modal
        visible={picking}
        transparent
        animationType="slide"
        onRequestClose={() => setPicking(false)}
      >
        <View style={s.overlay}>
          <GlassSurface
            material="dense"
            style={[s.sheet, { paddingBottom: insets.bottom + 100 }]}
          >
            <Text style={s.title}>Choose a destination</Text>
            <Text style={s.description}>Select one of your saved places.</Text>
            <ScrollView style={{ maxHeight: 340 }}>
              {places.map((p) => (
                <GlassButton
                  key={p.id}
                  style={[
                    s.chip,
                    { marginTop: 12, justifyContent: "flex-start" },
                  ]}
                  onPress={() => {
                    setDestination(p);
                    setPicking(false);
                  }}
                >
                  <Text style={s.chipText}>{p.name}</Text>
                </GlassButton>
              ))}
            </ScrollView>
            {!places.length && (
              <Text style={s.description}>
                Save a place from Drive search first.
              </Text>
            )}
            <GlassButton style={s.chip} onPress={() => setPicking(false)}>
              <Text style={s.chipText}>Done</Text>
            </GlassButton>
          </GlassSurface>
        </View>
      </Modal>
    </View>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    marginBottom: 18,
  },
  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  search: {
    marginHorizontal: 16,
    borderRadius: 24,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 10,
  },
  input: { flex: 1, minHeight: 52, fontSize: 15, color: c.foreground },
  planner: { margin: 16, marginBottom: 0, borderRadius: 26, padding: 18 },
  plannerHeading: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: {
    color: c.foreground,
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.6,
  },
  description: {
    color: c.mutedForeground,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  label: {
    color: c.foreground,
    fontSize: 13,
    fontWeight: "500",
    marginTop: 18,
    marginBottom: 8,
  },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 12 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  chipText: { color: c.foreground, fontSize: 13 },
  selected: { borderColor: c.primary + "70" },
  build: {
    minHeight: 56,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
    opacity: 0.5,
  },
  buildText: { color: c.primaryForeground, fontSize: 18, fontWeight: "600" },
  coming: {
    color: c.mutedForeground,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
  },
  carousel: { paddingHorizontal: 16, gap: 12 },
  place: { width: 175, padding: 12, borderRadius: 20 },
  placeImage: {
    height: 90,
    borderRadius: 14,
    backgroundColor: c.secondary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  placeName: { color: c.foreground, fontSize: 15, fontWeight: "600" },
  empty: {
    marginHorizontal: 16,
    padding: 20,
    borderRadius: 20,
    gap: 10,
    alignItems: "flex-start",
  },
  error: { color: c.destructive, paddingHorizontal: 20, marginBottom: 12 },
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    gap: 12,
  },
});

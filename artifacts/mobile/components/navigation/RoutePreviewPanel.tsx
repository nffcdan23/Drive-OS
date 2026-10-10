/**
 * The route preview panel (Navigation Phase 2A), in place of the Drive
 * screen's bottom actions while a preview is open. In the screen, not a
 * modal sheet, so the map above stays free to pan and zoom.
 *
 * It reads the whole preview state itself (useRoutePreview), so route
 * choices and updates re-render this panel only, never the Drive screen.
 *
 * Start Navigation (Phase 3) turns the chosen route into Derwent's own
 * turn-by-turn guidance, and records the drive (Phase 3.1) with the usual
 * recorder, unless one is already recording or Passenger Mode is on. Opening the place in the phone's maps app stays as
 * a second choice, except for a Search Box result, which Mapbox's terms
 * keep to Mapbox maps. Routes are only ever fetched when the user taps
 * (Update Route, Try Again, or Start with an out-of-date route), never on
 * their own.
 *
 * The bookmark saves the destination as a place (Phase 2B): shown filled when
 * it's already saved, and not at all for a Search Box result, which Mapbox's
 * terms allow for temporary use only.
 */
import React, { memo, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { SavePlaceSheet } from "@/components/places/SavePlaceSheet";
import { saveability } from "@/lib/navigation/places";
import {
  useRoutePreview,
  useRoutePreviewStore,
  useStartNavigation,
  useUpdateRoutePreview,
} from "@/context/NavigationContext";
import { canNavigate } from "@/lib/navigation/startNavigation";
import { canStoreDestination } from "@/lib/navigation/model";
import { describeError } from "@/lib/backend/http";
import {
  arrivalTime,
  formatClock,
  formatDuration,
  formatRouteDistance,
  formatVia,
} from "@/lib/navigation/format";
import { ROUTE_COLORS } from "@/lib/navigation/routeLayers";
import type { Destination, NavRoute } from "@/lib/navigation/model";
import type { ResolvedUnitSystem } from "@/lib/units";

/** Mapbox's terms ask apps using its directions to tell users this */
export const ROAD_SAFETY_NOTICE =
  "Directions are a guide. Always follow road signs, signals and local traffic laws.";

const MAPS_APP = Platform.OS === "ios" ? "Apple Maps" : "Google Maps";

/** The arrival times shown move on each minute, without refetching anything */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const RouteOption = memo(function RouteOption({
  route,
  selected,
  recommended,
  now,
  unitSystem,
  onPress,
}: {
  route: NavRoute;
  selected: boolean;
  recommended: boolean;
  now: number;
  unitSystem: ResolvedUnitSystem;
  onPress: () => void;
}) {
  const colors = useColors();
  const via = formatVia(route.summary);
  const duration = formatDuration(route.durationS);
  const distance = formatRouteDistance(route.distanceM, unitSystem);
  const arrive = formatClock(arrivalTime(now, route.durationS));
  return (
    <TouchableOpacity
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${recommended ? "Recommended route" : "Alternative route"}, ${duration}, ${distance}, arrive ${arrive}${via ? `, ${via}` : ""}`}
      onPress={onPress}
      style={[
        styles.option,
        { borderColor: selected ? ROUTE_COLORS.selected : colors.border },
        selected && styles.optionSelected,
      ]}
    >
      <View style={styles.optionTop}>
        <Text style={[styles.duration, { color: colors.foreground }]}>{duration}</Text>
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          {distance} · Arrive {arrive}
        </Text>
      </View>
      <Text numberOfLines={1} style={[styles.via, { color: colors.mutedForeground }]}>
        {recommended ? "Recommended" : "Alternative"}
        {via ? ` · ${via}` : ""}
      </Text>
    </TouchableOpacity>
  );
});

export function RoutePreviewPanel({
  unitSystem,
  onOpenInMaps,
}: {
  unitSystem: ResolvedUnitSystem;
  /** Start, for now: the place in the phone's maps app */
  onOpenInMaps: (destination: Destination) => void;
}) {
  const colors = useColors();
  const state = useRoutePreview();
  const store = useRoutePreviewStore();
  const update = useUpdateRoutePreview();
  const startNavigation = useStartNavigation();
  const [starting, setStarting] = useState(false);
  const now = useMinuteClock();
  const [updateFailed, setUpdateFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { places, addPlace, isPassengerMode } = useApp();
  // A message about the last Update Route belongs to that preview only
  const requestKey = state.phase === "idle" ? null : `${state.destination.id}`;
  useEffect(() => setUpdateFailed(null), [requestKey]);

  if (state.phase === "idle") return null;
  const { destination } = state;
  const save = saveability(places, destination);
  const selectedRoute =
    state.phase === "preview" ? state.routes.find((r) => r.index === state.selectedIndex) ?? state.routes[0] : null;
  // Derwent guides along the route itself when it can; the phone's maps app
  // is the other way, never for a Search Box result (Mapbox's terms)
  const navigable = state.phase === "preview" && canNavigate(selectedRoute);
  const handOff = canStoreDestination(destination);

  const requestUpdate = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setUpdateFailed(null);
    // No position to start from: say so (the store keeps what it has)
    update().catch((err: unknown) =>
      setUpdateFailed(err instanceof Error ? err.message : "Couldn't find where you are."),
    );
  };
  const cancel = () => {
    Haptics.selectionAsync();
    store.cancel();
  };

  return (
    <GlassSurface material="dense" style={styles.panel}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.title, { color: colors.foreground }]}>
            {destination.name}
          </Text>
          {destination.subtitle ? (
            <Text numberOfLines={1} style={[styles.subtitle, { color: colors.mutedForeground }]}>
              {destination.subtitle}
            </Text>
          ) : null}
        </View>
        {save.kind === "saved" ? (
          <View accessible accessibilityLabel="Saved to your places" style={styles.bookmark}>
            <Ionicons name="bookmark" size={22} color={colors.primary} />
          </View>
        ) : save.kind === "can_save" ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Save ${destination.name} to your places`}
            hitSlop={10}
            style={styles.bookmark}
            onPress={() => {
              Haptics.selectionAsync();
              setSaving(true);
            }}
          >
            <Ionicons name="bookmark-outline" size={22} color={colors.foreground} />
          </TouchableOpacity>
        ) : null}
      </View>

      {state.phase === "routing" ? (
        <View style={styles.status}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[styles.statusText, { color: colors.mutedForeground }]}>Finding routes…</Text>
        </View>
      ) : null}

      {state.phase === "previewFailed" ? (
        <View style={styles.status}>
          <Text style={[styles.statusText, { color: colors.foreground }]}>{state.error.message}</Text>
          <TouchableOpacity accessibilityRole="button" onPress={requestUpdate} style={styles.inlineAction}>
            <Text style={[styles.inlineActionText, { color: colors.primary }]}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {state.phase === "preview" ? (
        <>
          <View accessibilityRole="radiogroup" style={styles.options}>
            {state.routes.map((r, i) => (
              <RouteOption
                key={r.routeId}
                route={r}
                selected={r.index === state.selectedIndex}
                recommended={i === 0}
                now={now}
                unitSystem={unitSystem}
                onPress={() => {
                  Haptics.selectionAsync();
                  store.select(r.index);
                }}
              />
            ))}
          </View>
          {state.stale || state.updateError || state.refreshing || updateFailed ? (
            <View style={styles.staleRow}>
              <Text style={[styles.staleText, { color: colors.mutedForeground }]}>
                {state.refreshing
                  ? "Updating route…"
                  : state.updateError?.message ??
                    updateFailed ??
                    (state.stale === "moved"
                      ? "You've moved since this route was planned."
                      : "This route may be out of date.")}
              </Text>
              {state.refreshing ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <TouchableOpacity accessibilityRole="button" onPress={requestUpdate} hitSlop={8}>
                  <Text style={[styles.inlineActionText, { color: colors.primary }]}>Update Route</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null}
        </>
      ) : null}

      <View style={styles.actions}>
        <GlassButton
          accessibilityLabel="Cancel route preview"
          style={styles.cancel}
          onPress={cancel}
        >
          <Text style={[styles.cancelText, { color: colors.foreground }]}>Cancel</Text>
        </GlassButton>
        {navigable ? (
          <GlassButton
            material="accent"
            accessibilityLabel={`Start navigation to ${destination.name}`}
            accessibilityHint={isPassengerMode ? "Starts guidance" : "Starts guidance and records this drive"}
            accessibilityState={{ disabled: starting, busy: starting }}
            disabled={starting}
            style={styles.start}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setStarting(true);
              startNavigation()
                .catch((err: unknown) => Alert.alert("Couldn't start navigation", describeError(err)))
                .finally(() => setStarting(false));
            }}
          >
            {starting ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Ionicons name="navigate" size={20} color={colors.primaryForeground} />
            )}
            <Text numberOfLines={1} style={[styles.startText, { color: colors.primaryForeground }]}>
              Start Navigation
            </Text>
          </GlassButton>
        ) : handOff ? (
          <GlassButton
            material="accent"
            accessibilityLabel={`Open ${destination.name} in ${MAPS_APP}`}
            style={styles.start}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onOpenInMaps(destination);
            }}
          >
            <Ionicons name="open-outline" size={20} color={colors.primaryForeground} />
            <Text numberOfLines={1} style={[styles.startText, { color: colors.primaryForeground }]}>
              Open in {MAPS_APP}
            </Text>
          </GlassButton>
        ) : null}
      </View>
      {navigable && handOff ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Open ${destination.name} in ${MAPS_APP} instead`}
          onPress={() => {
            Haptics.selectionAsync();
            onOpenInMaps(destination);
          }}
          style={styles.handOff}
          hitSlop={6}
        >
          <Text style={[styles.handOffText, { color: colors.mutedForeground }]}>Open in {MAPS_APP} instead</Text>
        </TouchableOpacity>
      ) : null}
      <Text style={[styles.notice, { color: colors.mutedForeground }]}>{ROAD_SAFETY_NOTICE}</Text>
      <SavePlaceSheet
        visible={saving && save.kind === "can_save"}
        defaultKind="poi"
        destination={destination}
        onClose={() => setSaving(false)}
        onSave={addPlace}
      />
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 14,
    marginBottom: 14,
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    gap: 10,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  bookmark: { padding: 4 },
  title: { fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  subtitle: { fontSize: 13, marginTop: 2 },
  status: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, flexWrap: "wrap" },
  statusText: { fontSize: 15, flexShrink: 1 },
  inlineAction: { paddingVertical: 4 },
  inlineActionText: { fontSize: 15, fontWeight: "600" },
  options: { gap: 8 },
  option: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 2,
  },
  optionSelected: { backgroundColor: "rgba(76,141,255,0.12)" },
  optionTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  duration: { fontSize: 20, fontWeight: "700" },
  meta: { fontSize: 14, fontVariant: ["tabular-nums"] },
  via: { fontSize: 13 },
  staleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  staleText: { fontSize: 13, flexShrink: 1 },
  actions: { flexDirection: "row", gap: 10, marginTop: 2 },
  handOff: { alignItems: "center", paddingVertical: 2 },
  handOffText: { fontSize: 13, fontWeight: "600" },
  start: {
    flex: 2,
    height: 52,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  startText: { fontSize: 16, fontWeight: "700", flexShrink: 1 },
  cancel: {
    flex: 1,
    height: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { fontSize: 16, fontWeight: "600" },
  notice: { fontSize: 11, lineHeight: 15, textAlign: "center", opacity: 0.85 },
});

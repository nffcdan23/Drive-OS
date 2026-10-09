/**
 * Saving a place to the user's account: where the phone is now (Save where I
 * am), or a destination they chose (a dropped pin, typed coordinates).
 * Search Box results are never offered here: Mapbox's terms allow them for
 * temporary use only (lib/navigation/places.ts refuses them).
 */
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import { GlassSurface } from "@/components/Glass";
import {
  KeyboardAwareSheet,
  SheetScrollView,
} from "@/components/KeyboardAwareSheet";
import { useColors } from "@/hooks/useColors";
import type { useApp } from "@/context/AppContext";
import type {
  LocationKind,
  SpotCategory,
  Visibility,
} from "@/lib/backend/endpoints";
import { describeError } from "@/lib/backend/http";
import { requestForegroundLocation } from "@/lib/locationPermission";
import type { Destination } from "@/lib/navigation/model";
import { placeFieldsFor } from "@/lib/navigation/places";

export const KIND_LABEL: Record<LocationKind, string> = {
  home: "Home",
  work: "Work",
  favourite_road: "Favourite road",
  meeting_point: "Meeting point",
  car_park: "Car park",
  poi: "Place",
  beauty_spot: "Beauty Spot",
};
export const KIND_ICON: Record<LocationKind, keyof typeof Ionicons.glyphMap> = {
  home: "home-outline",
  work: "briefcase-outline",
  favourite_road: "star-outline",
  meeting_point: "people-outline",
  car_park: "car-outline",
  poi: "location-outline",
  beauty_spot: "triangle-outline",
};
const SAVE_KINDS: LocationKind[] = [
  "home",
  "work",
  "favourite_road",
  "meeting_point",
  "beauty_spot",
];
// A chosen place is most often just a place
const DESTINATION_KINDS: LocationKind[] = [
  "poi",
  "home",
  "work",
  "favourite_road",
  "meeting_point",
  "beauty_spot",
];
const SPOT_CATEGORIES: Array<{ id: SpotCategory; label: string }> = [
  { id: "viewpoint", label: "Viewpoint" },
  { id: "scenic_road", label: "Scenic road" },
  { id: "mountain_pass", label: "Mountain pass" },
  { id: "coastal", label: "Coastal" },
  { id: "lake", label: "Lake" },
  { id: "forest", label: "Forest" },
  { id: "landmark", label: "Landmark" },
  { id: "photo_spot", label: "Photo spot" },
  { id: "other", label: "Other" },
];
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: "Only me",
  friends: "Friends",
  public: "Everyone",
};

export async function currentPosition(): Promise<{
  latitude: number;
  longitude: number;
}> {
  const { status } = await requestForegroundLocation();
  if (status !== "granted")
    throw new Error("Allow location access to save or find places.");
  const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
  const pos =
    last ??
    (await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    }));
  return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
}

export function SavePlaceSheet({
  visible,
  defaultKind,
  onClose,
  onSave,
  destination = null,
}: {
  visible: boolean;
  defaultKind: LocationKind;
  onClose: () => void;
  onSave: ReturnType<typeof useApp>["addPlace"];
  /** The place to save; without one, where the phone is now */
  destination?: Destination | null;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [kind, setKind] = useState<LocationKind>(defaultKind);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<SpotCategory>("viewpoint");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setKind(defaultKind);
      setName("");
      setDescription("");
      setError(null);
      setVisibility("private");
    }
  }, [visible, defaultKind]);

  const isSpot = kind === "beauty_spot";
  const s = styles(colors);
  const kinds = destination ? DESTINATION_KINDS : SAVE_KINDS;
  const suggestedName =
    destination && destination.name !== "Dropped Pin" ? destination.name : "";

  async function save() {
    const finalName =
      name.trim() ||
      (kind === "home" || kind === "work" ? KIND_LABEL[kind] : "") ||
      suggestedName;
    if (!finalName) {
      setError("Give this place a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A chosen place is saved where it is (and with its address); otherwise
      // where the phone is now
      const where = destination
        ? placeFieldsFor(destination, finalName)
        : { coordinate: await currentPosition() };
      await onSave({
        kind,
        ...where,
        name: finalName,
        description: description.trim() || undefined,
        ...(isSpot ? { category, visibility } : {}),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const Chip = ({
    label,
    active,
    onPress,
  }: {
    label: string;
    active: boolean;
    onPress: () => void;
  }) => (
    <TouchableOpacity
      onPress={onPress}
      style={[s.chip, active && s.chipActive]}
    >
      <Text style={[s.chipText, active && s.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <KeyboardAwareSheet
      visible={visible}
      onClose={onClose}
      backdropColor="rgba(0,0,0,0.5)"
      scrollable
    >
      <GlassSurface
        material="dense"
        // Bottom padding clears the home indicator, as the sheet's keyboard lift expects
        style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
      >
        <SheetScrollView contentContainerStyle={{ gap: 12 }}>
          <Text style={s.sheetTitle}>Save this place</Text>
          {destination ? (
            <Text numberOfLines={2} style={s.note}>
              {destination.subtitle ?? destination.name}
            </Text>
          ) : null}
          <View style={s.chips}>
            {kinds.map((k) => (
              <Chip
                key={k}
                label={KIND_LABEL[k]}
                active={kind === k}
                onPress={() => setKind(k)}
              />
            ))}
          </View>
          <TextInput
            style={s.input}
            placeholder={
              kind === "home" || kind === "work"
                ? KIND_LABEL[kind]
                : suggestedName || "Name"
            }
            placeholderTextColor={colors.mutedForeground}
            value={name}
            onChangeText={setName}
            maxLength={100}
          />
          {isSpot ? (
            <>
              <TextInput
                style={[
                  s.input,
                  { height: 80, textAlignVertical: "top", paddingTop: 12 },
                ]}
                placeholder="What makes it special? (optional)"
                placeholderTextColor={colors.mutedForeground}
                value={description}
                onChangeText={setDescription}
                multiline
                maxLength={2000}
              />
              <Text style={s.label}>Type</Text>
              <View style={s.chips}>
                {SPOT_CATEGORIES.map((c) => (
                  <Chip
                    key={c.id}
                    label={c.label}
                    active={category === c.id}
                    onPress={() => setCategory(c.id)}
                  />
                ))}
              </View>
              <Text style={s.label}>Who can see it</Text>
              <View style={s.chips}>
                {(["private", "friends", "public"] as const).map((v) => (
                  <Chip
                    key={v}
                    label={VISIBILITY_LABEL[v]}
                    active={visibility === v}
                    onPress={() => setVisibility(v)}
                  />
                ))}
              </View>
            </>
          ) : (
            <Text style={s.note}>
              {kind === "home" || kind === "work"
                ? "Home and Work are always private."
                : "Saved places are private to you."}
            </Text>
          )}
          {error ? (
            <Text style={{ color: colors.destructive }}>{error}</Text>
          ) : null}
          <TouchableOpacity style={s.primary} onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={s.saveText}>
                {destination ? "Save place" : "Save current location"}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onClose}
            style={{ alignItems: "center", padding: 8 }}
          >
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </SheetScrollView>
      </GlassSurface>
    </KeyboardAwareSheet>
  );
}

const styles = (c: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    cancelText: { color: c.primary, fontSize: 15, fontWeight: "600" },
    saveText: { color: c.primaryForeground, fontWeight: "600", fontSize: 16 },
    sheet: {
      padding: 20,
      paddingBottom: 36,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      // Shrinks to fit the screen above the keyboard; its fields then scroll
      flexShrink: 1,
    },
    sheetTitle: { color: c.foreground, fontWeight: "700", fontSize: 18 },
    label: { color: c.mutedForeground, fontWeight: "600", fontSize: 13 },
    note: { color: c.mutedForeground, fontSize: 13 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 14,
      backgroundColor: c.muted,
    },
    chipActive: { backgroundColor: c.primary },
    chipText: { color: c.foreground, fontWeight: "500", fontSize: 13 },
    chipTextActive: { color: c.primaryForeground },
    input: {
      height: 46,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.input,
      backgroundColor: c.card,
      color: c.foreground,
      paddingHorizontal: 14,
      fontSize: 16,
    },
    primary: {
      height: 50,
      borderRadius: 14,
      backgroundColor: c.primary,
      alignItems: "center",
      justifyContent: "center",
    },
  });

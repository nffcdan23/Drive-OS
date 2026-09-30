import React, { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Alert,
  TextInput,
  Image,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useApp, Vehicle } from "@/context/AppContext";
import { GlassSurface, GlassButton } from "@/components/Glass";
import { sectionAccent } from "@/constants/colors";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { TEST_REGISTRATIONS } from "@/constants/config";
import {
  displayRegistration,
  normaliseRegistration,
} from "@workspace/vehicle-registration";
import {
  acceptConflicts,
  demoSuggestions,
  FIELD_LABELS,
  initialSources,
  lookupErrorMessage,
  lookupInputProblem,
  markEdited,
  mergeLookup,
  type Conflict,
  type FieldSources,
  type LookupField,
  type Suggestions,
} from "@/lib/backend/vehicleLookup";
import { ApiError } from "@/lib/backend/http";

type VehicleForm = Omit<Vehicle, "id" | "isActive" | "fuelPercentage">;

type LookupState =
  | {
      kind: "found" | "demo";
      message: string;
      conflicts: Conflict[];
      suggested: Suggestions;
    }
  | { kind: "error"; message: string };

const BLANK_FORM: VehicleForm = {
  nickname: "",
  registration: "",
  make: "",
  model: "",
  year: new Date().getFullYear(),
  colour: "",
  fuelType: "petrol",
  engine: "",
  power: "",
  torque: "",
  zeroToSixty: "",
  topSpeed: "",
  mileage: 0,
  imageUri: null,
};

export default function VehicleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const colors = { ...useColors(), primary: sectionAccent.garage };
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    vehicles,
    journeys,
    activeVehicle,
    setActiveVehicle,
    addVehicle,
    updateVehicle,
    deleteVehicle,
    lookupVehicle,
    resolveId,
  } = useApp();

  const existing = isNew
    ? null
    : vehicles.find((v) => v.id === id || v.id === resolveId(id ?? ""));

  const [editing, setEditing] = useState(isNew);
  const [detailTab, setDetailTab] = useState<"overview" | "history">(
    "overview",
  );

  const [form, setForm] = useState<VehicleForm>(() => {
    if (existing) {
      const {
        id: _id,
        isActive: _isActive,
        fuelPercentage: _fuel,
        ...rest
      } = existing;
      return { ...rest, registration: displayRegistration(rest.registration) };
    }
    return BLANK_FORM;
  });

  // Where each lookup-able field's value came from: a lookup never replaces
  // what the user typed or had saved.
  const [sources, setSources] = useState<FieldSources>(() =>
    initialSources(existing ?? null),
  );
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookup, setLookup] = useState<LookupState | null>(null);
  // Latest values, so a lookup that finishes after the user kept typing
  // merges into what's on screen now, not what was there when it started.
  const formRef = useRef(form);
  formRef.current = form;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const handleChange = useCallback(
    <K extends keyof VehicleForm>(field: K, value: VehicleForm[K]) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      setSources((prev) => markEdited(prev, field));
      if (field === "registration") setLookup(null);
    },
    [],
  );

  const handleSave = useCallback(() => {
    if (!form.make.trim() || !form.model.trim()) {
      Alert.alert("Missing info", "Please enter at least Make and Model.");
      return;
    }
    if (isNew) {
      addVehicle({
        ...form,
        fuelPercentage: 0,
        isActive: vehicles.length === 0,
      });
    } else {
      updateVehicle(existing?.id ?? id!, form);
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }, [form, isNew, id, vehicles.length]);

  const handleDelete = useCallback(() => {
    if (isNew) return;
    Alert.alert(
      "Remove this vehicle?",
      `"${form.nickname || "This vehicle"}" will be removed from your garage. Saved journeys will keep a historical record — no journey data will be lost.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove Vehicle",
          style: "destructive",
          onPress: () => {
            deleteVehicle(existing?.id ?? id!);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.back();
          },
        },
      ],
    );
  }, [form.nickname, id, isNew]);

  const handlePickImage = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Please allow photo access to upload a vehicle image.",
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      handleChange("imageUri", result.assets[0].uri);
    }
  }, [handleChange]);

  const handleRemoveImage = useCallback(() => {
    handleChange("imageUri", null);
  }, [handleChange]);

  /** Applies suggestions (from DVLA or Demo Mode) without replacing the user's own values. */
  const applySuggestions = useCallback(
    (
      registration: string,
      suggested: Suggestions,
      kind: "found" | "demo",
      intro: string,
    ) => {
      const merged = mergeLookup(
        formRef.current,
        sourcesRef.current,
        registration,
        suggested,
      );
      formRef.current = merged.form;
      sourcesRef.current = merged.sources;
      setForm(merged.form);
      setSources(merged.sources);
      const filled = merged.applied.map((f) => FIELD_LABELS[f]);
      const parts = [intro];
      if (filled.length) parts.push(`Filled in ${filled.join(", ")}.`);
      if (merged.conflicts.length)
        parts.push(
          `Kept your ${merged.conflicts.map((c) => FIELD_LABELS[c.field]).join(", ")}.`,
        );
      if (kind === "found")
        parts.push("DVLA doesn't publish the model — add it below.");
      setLookup({
        kind,
        message: parts.join(" "),
        conflicts: merged.conflicts,
        suggested,
      });
    },
    [],
  );

  const handleUseSuggested = useCallback(() => {
    if (!lookup || lookup.kind === "error") return;
    const next = acceptConflicts(
      form,
      sources,
      lookup.conflicts,
      lookup.suggested,
    );
    setForm(next.form);
    setSources(next.sources);
    setLookup({
      ...lookup,
      conflicts: [],
      message: `${lookup.message} Used the ${lookup.kind === "demo" ? "Demo Mode" : "DVLA"} values instead.`,
    });
  }, [form, sources, lookup]);

  const handleLookup = useCallback(async () => {
    const problem = lookupInputProblem(form.registration);
    if (problem) {
      setLookup({ kind: "error", message: problem });
      return;
    }
    const cleaned = normaliseRegistration(form.registration);
    setLookupLoading(true);
    setLookup(null);
    // The registration was changed while the lookup ran: its answer no longer applies.
    const stale = () =>
      normaliseRegistration(formRef.current.registration) !== cleaned;
    try {
      const found = await lookupVehicle(cleaned);
      if (stale()) return;
      const v = found.suggested;
      const label = [v.year, v.make, v.colour].filter(Boolean).join(" · ");
      applySuggestions(
        found.displayRegistration,
        v,
        "found",
        `Found ${label || found.displayRegistration} (DVLA).`,
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      if (stale()) return;
      // Demo Mode (development builds only, and only when the server has no
      // DVLA key): a few test registrations fill the form, clearly labelled.
      const notConnected =
        err instanceof ApiError && err.code === "lookup_not_configured";
      const demo =
        __DEV__ && notConnected ? TEST_REGISTRATIONS[cleaned] : undefined;
      if (demo) {
        applySuggestions(
          displayRegistration(cleaned),
          demoSuggestions(demo),
          "demo",
          `Demo Mode — test data, not from DVLA: ${demo.year} ${demo.make} ${demo.model}.`,
        );
        setForm((prev) =>
          prev.model.trim() ? prev : { ...prev, model: demo.model },
        );
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        const suffix =
          __DEV__ && notConnected
            ? " (Demo Mode only knows its test registrations.)"
            : "";
        setLookup({ kind: "error", message: lookupErrorMessage(err) + suffix });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setLookupLoading(false);
    }
  }, [form, applySuggestions, lookupVehicle]);

  /** " · from DVLA" after a label whose value came from a lookup. */
  const fromLookup = (field: LookupField) =>
    sources[field] === "dvla"
      ? lookup?.kind === "demo"
        ? " · Demo Mode"
        : " · from DVLA"
      : "";

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === "web" ? 67 + insets.top : insets.top,
      paddingHorizontal: 16,
      paddingBottom: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    backBtn: { padding: 4 },
    headerTitle: {
      flex: 1,
      fontSize: 17,
      fontWeight: "600",
      color: colors.foreground,
    },
    deleteBtn: { padding: 4 },
    scroll: { flex: 1 },
    content: { padding: 20, paddingBottom: 60 },
    imagePickerArea: {
      height: 160,
      backgroundColor: colors.muted,
      borderRadius: 16,
      marginBottom: 20,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    vehicleImage: { width: "100%", height: "100%" },
    imagePickerOverlay: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: "rgba(0,0,0,0.45)",
      paddingVertical: 8,
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "center",
      gap: 6,
    },
    imagePickerText: { fontSize: 13, color: "#fff", fontWeight: "500" },
    removeImageBtn: {
      position: "absolute",
      top: 8,
      right: 8,
      backgroundColor: "rgba(0,0,0,0.55)",
      borderRadius: 14,
      padding: 6,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: "600",
      color: colors.mutedForeground,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 10,
      marginTop: 20,
    },
    lookupCard: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 14,
      marginBottom: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    lookupNote: {
      fontSize: 11,
      color: colors.mutedForeground,
      marginBottom: 8,
    },
    lookupRow: { flexDirection: "row", gap: 10, alignItems: "center" },
    lookupInput: {
      flex: 1,
      backgroundColor: colors.muted,
      borderRadius: 10,
      padding: 12,
      fontSize: 15,
      color: colors.foreground,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    lookupBtn: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    lookupBtnText: { fontSize: 14, fontWeight: "600", color: "#fff" },
    lookupResult: { marginTop: 8, fontSize: 12 },
    lookupSuccess: { color: "#22c55e" },
    lookupFail: { color: colors.mutedForeground },
    lookupUseBtn: {
      marginTop: 8,
      alignSelf: "flex-start",
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.primary,
    },
    lookupUseText: { fontSize: 12, color: colors.primary, fontWeight: "600" },
    inputLabel: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontWeight: "500",
      marginBottom: 5,
      marginTop: 12,
    },
    input: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 13,
      fontSize: 15,
      color: colors.foreground,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    row2: { flexDirection: "row", gap: 10 },
    flex1: { flex: 1 },
    fuelRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
    fuelOption: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
    },
    fuelOptionActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primary + "15",
    },
    fuelOptionText: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontWeight: "500",
    },
    fuelOptionTextActive: { color: colors.primary },
    saveBtn: {
      backgroundColor: colors.primary,
      borderRadius: 14,
      paddingVertical: 15,
      alignItems: "center",
      marginTop: 28,
    },
    saveBtnText: { fontSize: 16, fontWeight: "700", color: "#fff" },
  });

  const fuelTypes: Array<VehicleForm["fuelType"]> = [
    "petrol",
    "diesel",
    "electric",
    "hybrid",
    "other",
  ];

  if (existing && !editing) {
    const history = journeys.filter((j) => j.vehicleId === existing.id);
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
          <GlassButton
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
            }}
            onPress={() => router.back()}
            accessibilityLabel="Back to Garage"
          >
            <Ionicons name="arrow-back" size={23} color={colors.foreground} />
          </GlassButton>
          <View style={{ flex: 1 }}>
            <Text
              style={[styles.headerTitle, { flex: undefined, fontSize: 20 }]}
            >
              {existing.nickname || existing.model}
            </Text>
            <Text
              style={{
                color: colors.mutedForeground,
                fontSize: 12,
                marginTop: 3,
              }}
            >
              {existing.year} {existing.make} {existing.model}
            </Text>
          </View>
          <GlassButton
            style={{
              minHeight: 44,
              paddingHorizontal: 14,
              borderRadius: 22,
              justifyContent: "center",
            }}
            onPress={() => setEditing(true)}
          >
            <Text style={{ color: colors.foreground }}>Edit</Text>
          </GlassButton>
        </View>
        <View
          style={{
            flexDirection: "row",
            gap: 10,
            paddingHorizontal: 20,
            paddingVertical: 12,
          }}
        >
          {(["overview", "history"] as const).map((tab) => (
            <GlassButton
              key={tab}
              style={{
                minHeight: 44,
                borderRadius: 22,
                paddingHorizontal: 20,
                justifyContent: "center",
                borderColor: detailTab === tab ? colors.primary : colors.border,
              }}
              onPress={() => setDetailTab(tab)}
              accessibilityState={{ selected: detailTab === tab }}
            >
              <Text
                style={{
                  color:
                    detailTab === tab ? colors.primary : colors.mutedForeground,
                  textTransform: "capitalize",
                }}
              >
                {tab}
              </Text>
            </GlassButton>
          ))}
        </View>
        <ScrollView
          contentContainerStyle={{
            padding: 18,
            paddingBottom: insets.bottom + 30,
          }}
          showsVerticalScrollIndicator={false}
        >
          {detailTab === "overview" ? (
            <>
              <GlassSurface
                style={{
                  minHeight: 320,
                  borderRadius: 24,
                  overflow: "hidden",
                  justifyContent: "flex-end",
                  padding: 20,
                }}
              >
                {existing.imageUri ? (
                  <Image
                    source={{ uri: existing.imageUri }}
                    style={StyleSheet.absoluteFill}
                    resizeMode="cover"
                  />
                ) : (
                  <View
                    style={[
                      StyleSheet.absoluteFill,
                      { alignItems: "center", justifyContent: "center" },
                    ]}
                  >
                    <Ionicons
                      name="car-sport-outline"
                      size={110}
                      color={colors.mutedForeground}
                    />
                  </View>
                )}
                <LinearGradient
                  pointerEvents="none"
                  colors={["transparent", "rgba(0,0,0,0.85)"]}
                  style={StyleSheet.absoluteFill}
                />
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 28,
                    fontWeight: "700",
                  }}
                >
                  {existing.nickname || existing.model}
                </Text>
                <Text style={{ color: colors.mutedForeground, marginTop: 5 }}>
                  {existing.registration} · {existing.colour}
                </Text>
              </GlassSurface>
              <GlassSurface
                style={{
                  marginTop: 16,
                  padding: 18,
                  borderRadius: 22,
                  gap: 16,
                }}
              >
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 19,
                    fontWeight: "600",
                  }}
                >
                  Vehicle Details
                </Text>
                {[
                  ["Mileage", `${existing.mileage.toLocaleString()} mi`],
                  ["Engine", existing.engine || "—"],
                  ["Power", existing.power || "—"],
                  ["Fuel", existing.fuelType],
                  ["Torque", existing.torque || "—"],
                  ["0–60", existing.zeroToSixty || "—"],
                  ["Top Speed", existing.topSpeed || "—"],
                ].map(([label, value]) => (
                  <View
                    key={label}
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <Text style={{ color: colors.mutedForeground }}>
                      {label}
                    </Text>
                    <Text style={{ color: colors.foreground, flexShrink: 1 }}>
                      {value}
                    </Text>
                  </View>
                ))}
              </GlassSurface>
              <GlassButton
                style={{
                  marginTop: 16,
                  minHeight: 52,
                  borderRadius: 22,
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onPress={() => setActiveVehicle(existing.id)}
                accessibilityState={{
                  selected: activeVehicle?.id === existing.id,
                }}
              >
                <Text style={{ color: colors.primary }}>
                  {activeVehicle?.id === existing.id
                    ? "Primary Car"
                    : "Set as Primary Car"}
                </Text>
              </GlassButton>
            </>
          ) : (
            <>
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: 22,
                  fontWeight: "600",
                  marginBottom: 16,
                }}
              >
                Drive History
              </Text>
              {history.length ? (
                history.map((j) => (
                  <GlassButton
                    key={j.id}
                    onPress={() => router.push(`/journey/${j.id}`)}
                    style={{ borderRadius: 20, padding: 18, marginBottom: 12 }}
                  >
                    <Text
                      style={{
                        color: colors.foreground,
                        fontSize: 17,
                        fontWeight: "600",
                      }}
                    >
                      {j.name}
                    </Text>
                    <Text
                      style={{
                        color: colors.mutedForeground,
                        fontSize: 13,
                        marginTop: 5,
                      }}
                    >
                      {j.date} · {Math.round(j.duration / 60)} min
                    </Text>
                  </GlassButton>
                ))
              ) : (
                <Text style={{ color: colors.mutedForeground, lineHeight: 22 }}>
                  Your recorded drives with this vehicle will appear here.
                </Text>
              )}
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => (isNew ? router.back() : setEditing(false))}
        >
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {isNew ? "Add Vehicle" : "Edit Vehicle"}
        </Text>
        {!isNew && (
          <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
            <Ionicons
              name="trash-outline"
              size={20}
              color={colors.destructive}
            />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Image picker */}
        <TouchableOpacity
          style={styles.imagePickerArea}
          onPress={handlePickImage}
          activeOpacity={0.85}
        >
          {form.imageUri ? (
            <>
              <Image
                source={{ uri: form.imageUri }}
                style={styles.vehicleImage}
                resizeMode="cover"
              />
              <View style={styles.imagePickerOverlay}>
                <Ionicons name="camera-outline" size={16} color="#fff" />
                <Text style={styles.imagePickerText}>Change photo</Text>
              </View>
              <TouchableOpacity
                style={styles.removeImageBtn}
                onPress={(e) => {
                  e.stopPropagation?.();
                  handleRemoveImage();
                }}
              >
                <Ionicons name="close" size={14} color="#fff" />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Ionicons
                name="camera-outline"
                size={36}
                color={colors.mutedForeground}
              />
              <Text
                style={[
                  styles.imagePickerText,
                  { color: colors.mutedForeground, marginTop: 6 },
                ]}
              >
                Tap to add vehicle photo
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* Registration (with optional DVLA lookup) */}
        <Text style={styles.sectionTitle}>Registration</Text>
        <View style={styles.lookupCard}>
          <Text style={styles.lookupNote}>
            Look up a UK registration to fill in make, colour, fuel, year and
            engine size from DVLA. Nothing you've typed is replaced, and you can
            always enter the details yourself (including non-UK registrations).
          </Text>
          <View style={styles.lookupRow}>
            <TextInput
              style={styles.lookupInput}
              placeholder="AB12 CDE"
              placeholderTextColor={colors.mutedForeground}
              value={form.registration}
              onChangeText={(v) =>
                handleChange("registration", v.toUpperCase())
              }
              onBlur={() =>
                setForm((prev) => ({
                  ...prev,
                  registration: displayRegistration(prev.registration),
                }))
              }
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
            />
            <TouchableOpacity
              style={styles.lookupBtn}
              onPress={handleLookup}
              disabled={lookupLoading}
            >
              {lookupLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.lookupBtnText}>Look up</Text>
              )}
            </TouchableOpacity>
          </View>
          {lookup && (
            <Text
              style={[
                styles.lookupResult,
                lookup.kind === "error"
                  ? styles.lookupFail
                  : styles.lookupSuccess,
              ]}
            >
              {lookup.message}
            </Text>
          )}
          {lookup && lookup.kind !== "error" && lookup.conflicts.length > 0 && (
            <TouchableOpacity
              style={styles.lookupUseBtn}
              onPress={handleUseSuggested}
            >
              <Text style={styles.lookupUseText}>
                Use {lookup.kind === "demo" ? "Demo Mode" : "DVLA's"} values:{" "}
                {lookup.conflicts
                  .map((c) => `${FIELD_LABELS[c.field]} ${c.suggested}`)
                  .join(", ")}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Basic details */}
        <Text style={styles.sectionTitle}>Details</Text>

        <Text style={styles.inputLabel}>Nickname</Text>
        <TextInput
          style={styles.input}
          value={form.nickname}
          onChangeText={(v) => handleChange("nickname", v)}
          placeholder="e.g. The Green Monster"
          placeholderTextColor={colors.mutedForeground}
        />

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Make{fromLookup("make")}</Text>
            <TextInput
              style={styles.input}
              value={form.make}
              onChangeText={(v) => handleChange("make", v)}
              placeholder="e.g. MINI"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Model</Text>
            <TextInput
              style={styles.input}
              value={form.model}
              onChangeText={(v) => handleChange("model", v)}
              placeholder="e.g. Cooper R50"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
        </View>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Year{fromLookup("year")}</Text>
            <TextInput
              style={styles.input}
              value={form.year.toString()}
              onChangeText={(v) => handleChange("year", parseInt(v, 10) || 0)}
              placeholder="2003"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="numeric"
            />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Colour{fromLookup("colour")}</Text>
            <TextInput
              style={styles.input}
              value={form.colour}
              onChangeText={(v) => handleChange("colour", v)}
              placeholder="e.g. Racing Green"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
        </View>

        <Text style={styles.inputLabel}>Fuel Type{fromLookup("fuelType")}</Text>
        <View style={styles.fuelRow}>
          {fuelTypes.map((ft) => (
            <TouchableOpacity
              key={ft}
              style={[
                styles.fuelOption,
                form.fuelType === ft && styles.fuelOptionActive,
              ]}
              onPress={() => handleChange("fuelType", ft)}
            >
              <Text
                style={[
                  styles.fuelOptionText,
                  form.fuelType === ft && styles.fuelOptionTextActive,
                ]}
              >
                {ft.charAt(0).toUpperCase() + ft.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Performance */}
        <Text style={styles.sectionTitle}>Performance</Text>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Engine{fromLookup("engine")}</Text>
            <TextInput
              style={styles.input}
              value={form.engine}
              onChangeText={(v) => handleChange("engine", v)}
              placeholder="1.6L"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Power</Text>
            <TextInput
              style={styles.input}
              value={form.power}
              onChangeText={(v) => handleChange("power", v)}
              placeholder="115 bhp"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
        </View>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Torque</Text>
            <TextInput
              style={styles.input}
              value={form.torque}
              onChangeText={(v) => handleChange("torque", v)}
              placeholder="149 Nm"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>0–60</Text>
            <TextInput
              style={styles.input}
              value={form.zeroToSixty}
              onChangeText={(v) => handleChange("zeroToSixty", v)}
              placeholder="10.9s"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
        </View>

        <Text style={styles.inputLabel}>Top Speed</Text>
        <TextInput
          style={styles.input}
          value={form.topSpeed}
          onChangeText={(v) => handleChange("topSpeed", v)}
          placeholder="120 mph"
          placeholderTextColor={colors.mutedForeground}
        />

        {/* Odometer */}
        <Text style={styles.sectionTitle}>Odometer</Text>

        <Text style={styles.inputLabel}>Mileage</Text>
        <TextInput
          style={styles.input}
          value={form.mileage.toString()}
          onChangeText={(v) => handleChange("mileage", parseInt(v, 10) || 0)}
          placeholder="96512"
          placeholderTextColor={colors.mutedForeground}
          keyboardType="numeric"
        />

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>Save Changes</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

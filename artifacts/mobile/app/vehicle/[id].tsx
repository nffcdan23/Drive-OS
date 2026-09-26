import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform, Alert,
  TextInput, Image, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp, Vehicle } from '@/context/AppContext';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { TEST_REGISTRATIONS } from '@/constants/config';
import { displayRegistration, normaliseRegistration } from '@workspace/vehicle-registration';
import {
  acceptConflicts, demoSuggestions, FIELD_LABELS, initialSources, lookupErrorMessage, lookupInputProblem,
  markEdited, mergeLookup, type Conflict, type FieldSources, type LookupField, type Suggestions,
} from '@/lib/backend/vehicleLookup';
import { ApiError } from '@/lib/backend/http';

type VehicleForm = Omit<Vehicle, 'id' | 'isActive' | 'fuelPercentage'>;

type LookupState =
  | { kind: 'found' | 'demo'; message: string; conflicts: Conflict[]; suggested: Suggestions }
  | { kind: 'error'; message: string };

const BLANK_FORM: VehicleForm = {
  nickname: '',
  registration: '',
  make: '',
  model: '',
  year: new Date().getFullYear(),
  colour: '',
  fuelType: 'petrol',
  engine: '',
  power: '',
  torque: '',
  zeroToSixty: '',
  topSpeed: '',
  mileage: 0,
  imageUri: null,
};

export default function VehicleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { vehicles, addVehicle, updateVehicle, deleteVehicle, lookupVehicle, resolveId } = useApp();

  const existing = isNew ? null : vehicles.find((v) => v.id === id || v.id === resolveId(id ?? ''));

  const [form, setForm] = useState<VehicleForm>(() => {
    if (existing) {
      const { id: _id, isActive: _isActive, fuelPercentage: _fuel, ...rest } = existing;
      return { ...rest, registration: displayRegistration(rest.registration) };
    }
    return BLANK_FORM;
  });

  // Where each lookup-able field's value came from: a lookup never replaces
  // what the user typed or had saved.
  const [sources, setSources] = useState<FieldSources>(() => initialSources(existing ?? null));
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookup, setLookup] = useState<LookupState | null>(null);
  // Latest values, so a lookup that finishes after the user kept typing
  // merges into what's on screen now, not what was there when it started.
  const formRef = useRef(form);
  formRef.current = form;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const handleChange = useCallback(<K extends keyof VehicleForm>(field: K, value: VehicleForm[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setSources((prev) => markEdited(prev, field));
    if (field === 'registration') setLookup(null);
  }, []);

  const handleSave = useCallback(() => {
    if (!form.make.trim() || !form.model.trim()) {
      Alert.alert('Missing info', 'Please enter at least Make and Model.');
      return;
    }
    if (isNew) {
      addVehicle({ ...form, fuelPercentage: 0, isActive: vehicles.length === 0 });
    } else {
      updateVehicle(existing?.id ?? id!, form);
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }, [form, isNew, id, vehicles.length]);

  const handleDelete = useCallback(() => {
    if (isNew) return;
    Alert.alert(
      'Remove this vehicle?',
      `"${form.nickname || 'This vehicle'}" will be removed from your garage. Saved journeys will keep a historical record — no journey data will be lost.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove Vehicle', style: 'destructive', onPress: () => {
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
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo access to upload a vehicle image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      handleChange('imageUri', result.assets[0].uri);
    }
  }, [handleChange]);

  const handleRemoveImage = useCallback(() => {
    handleChange('imageUri', null);
  }, [handleChange]);

  /** Applies suggestions (from DVLA or Demo Mode) without replacing the user's own values. */
  const applySuggestions = useCallback((registration: string, suggested: Suggestions, kind: 'found' | 'demo', intro: string) => {
    const merged = mergeLookup(formRef.current, sourcesRef.current, registration, suggested);
    formRef.current = merged.form;
    sourcesRef.current = merged.sources;
    setForm(merged.form);
    setSources(merged.sources);
    const filled = merged.applied.map((f) => FIELD_LABELS[f]);
    const parts = [intro];
    if (filled.length) parts.push(`Filled in ${filled.join(', ')}.`);
    if (merged.conflicts.length) parts.push(`Kept your ${merged.conflicts.map((c) => FIELD_LABELS[c.field]).join(', ')}.`);
    if (kind === 'found') parts.push("DVLA doesn't publish the model — add it below.");
    setLookup({ kind, message: parts.join(' '), conflicts: merged.conflicts, suggested });
  }, []);

  const handleUseSuggested = useCallback(() => {
    if (!lookup || lookup.kind === 'error') return;
    const next = acceptConflicts(form, sources, lookup.conflicts, lookup.suggested);
    setForm(next.form);
    setSources(next.sources);
    setLookup({ ...lookup, conflicts: [], message: `${lookup.message} Used the ${lookup.kind === 'demo' ? 'Demo Mode' : "DVLA"} values instead.` });
  }, [form, sources, lookup]);

  const handleLookup = useCallback(async () => {
    const problem = lookupInputProblem(form.registration);
    if (problem) {
      setLookup({ kind: 'error', message: problem });
      return;
    }
    const cleaned = normaliseRegistration(form.registration);
    setLookupLoading(true);
    setLookup(null);
    // The registration was changed while the lookup ran: its answer no longer applies.
    const stale = () => normaliseRegistration(formRef.current.registration) !== cleaned;
    try {
      const found = await lookupVehicle(cleaned);
      if (stale()) return;
      const v = found.suggested;
      const label = [v.year, v.make, v.colour].filter(Boolean).join(' · ');
      applySuggestions(found.displayRegistration, v, 'found', `Found ${label || found.displayRegistration} (DVLA).`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      if (stale()) return;
      // Demo Mode (development builds only, and only when the server has no
      // DVLA key): a few test registrations fill the form, clearly labelled.
      const notConnected = err instanceof ApiError && err.code === 'lookup_not_configured';
      const demo = __DEV__ && notConnected ? TEST_REGISTRATIONS[cleaned] : undefined;
      if (demo) {
        applySuggestions(displayRegistration(cleaned), demoSuggestions(demo), 'demo', `Demo Mode — test data, not from DVLA: ${demo.year} ${demo.make} ${demo.model}.`);
        setForm((prev) => (prev.model.trim() ? prev : { ...prev, model: demo.model }));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        const suffix = __DEV__ && notConnected ? ' (Demo Mode only knows its test registrations.)' : '';
        setLookup({ kind: 'error', message: lookupErrorMessage(err) + suffix });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setLookupLoading(false);
    }
  }, [form, applySuggestions, lookupVehicle]);

  /** " · from DVLA" after a label whose value came from a lookup. */
  const fromLookup = (field: LookupField) =>
    sources[field] === 'dvla' ? (lookup?.kind === 'demo' ? ' · Demo Mode' : ' · from DVLA') : '';

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top,
      paddingHorizontal: 16, paddingBottom: 12,
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    backBtn: { padding: 4 },
    headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    deleteBtn: { padding: 4 },
    scroll: { flex: 1 },
    content: { padding: 20, paddingBottom: 60 },
    imagePickerArea: {
      height: 160, backgroundColor: colors.muted, borderRadius: 16, marginBottom: 20,
      alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    vehicleImage: { width: '100%', height: '100%' },
    imagePickerOverlay: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      backgroundColor: 'rgba(0,0,0,0.45)', paddingVertical: 8, alignItems: 'center',
      flexDirection: 'row', justifyContent: 'center', gap: 6,
    },
    imagePickerText: { fontSize: 13, color: '#fff', fontFamily: 'Inter_500Medium' },
    removeImageBtn: {
      position: 'absolute', top: 8, right: 8,
      backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, padding: 6,
    },
    sectionTitle: {
      fontSize: 14, fontWeight: '600', color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold',
      textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10, marginTop: 20,
    },
    lookupCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 4,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    lookupNote: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginBottom: 8 },
    lookupRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
    lookupInput: {
      flex: 1, backgroundColor: colors.muted, borderRadius: 10, padding: 12,
      fontSize: 15, color: colors.foreground, fontFamily: 'Inter_600SemiBold',
      textTransform: 'uppercase', letterSpacing: 1,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    lookupBtn: {
      backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12,
      flexDirection: 'row', alignItems: 'center', gap: 6,
    },
    lookupBtnText: { fontSize: 14, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    lookupResult: { marginTop: 8, fontSize: 12, fontFamily: 'Inter_400Regular' },
    lookupSuccess: { color: '#22c55e' },
    lookupFail: { color: colors.mutedForeground },
    lookupUseBtn: { marginTop: 8, alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.primary },
    lookupUseText: { fontSize: 12, color: colors.primary, fontFamily: 'Inter_600SemiBold' },
    inputLabel: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginBottom: 5, marginTop: 12 },
    input: {
      backgroundColor: colors.card, borderRadius: 12, padding: 13,
      fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular',
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    row2: { flexDirection: 'row', gap: 10 },
    flex1: { flex: 1 },
    fuelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
    fuelOption: {
      paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
      borderWidth: 1, borderColor: colors.border,
    },
    fuelOptionActive: { borderColor: colors.primary, backgroundColor: colors.primary + '15' },
    fuelOptionText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
    fuelOptionTextActive: { color: colors.primary },
    saveBtn: {
      backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 15,
      alignItems: 'center', marginTop: 28,
    },
    saveBtnText: { fontSize: 16, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold' },
  });

  const fuelTypes: Array<VehicleForm['fuelType']> = ['petrol', 'diesel', 'electric', 'hybrid', 'other'];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isNew ? 'Add Vehicle' : 'Edit Vehicle'}</Text>
        {!isNew && (
          <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
            <Ionicons name="trash-outline" size={20} color={colors.destructive} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* Image picker */}
        <TouchableOpacity style={styles.imagePickerArea} onPress={handlePickImage} activeOpacity={0.85}>
          {form.imageUri ? (
            <>
              <Image source={{ uri: form.imageUri }} style={styles.vehicleImage} resizeMode="cover" />
              <View style={styles.imagePickerOverlay}>
                <Ionicons name="camera-outline" size={16} color="#fff" />
                <Text style={styles.imagePickerText}>Change photo</Text>
              </View>
              <TouchableOpacity style={styles.removeImageBtn} onPress={(e) => { e.stopPropagation?.(); handleRemoveImage(); }}>
                <Ionicons name="close" size={14} color="#fff" />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Ionicons name="camera-outline" size={36} color={colors.mutedForeground} />
              <Text style={[styles.imagePickerText, { color: colors.mutedForeground, marginTop: 6 }]}>
                Tap to add vehicle photo
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* Registration (with optional DVLA lookup) */}
        <Text style={styles.sectionTitle}>Registration</Text>
        <View style={styles.lookupCard}>
          <Text style={styles.lookupNote}>
            Look up a UK registration to fill in make, colour, fuel, year and engine size from DVLA.
            Nothing you've typed is replaced, and you can always enter the details yourself
            (including non-UK registrations).
          </Text>
          <View style={styles.lookupRow}>
            <TextInput
              style={styles.lookupInput}
              placeholder="AB12 CDE"
              placeholderTextColor={colors.mutedForeground}
              value={form.registration}
              onChangeText={(v) => handleChange('registration', v.toUpperCase())}
              onBlur={() => setForm((prev) => ({ ...prev, registration: displayRegistration(prev.registration) }))}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
            />
            <TouchableOpacity style={styles.lookupBtn} onPress={handleLookup} disabled={lookupLoading}>
              {lookupLoading
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.lookupBtnText}>Look up</Text>}
            </TouchableOpacity>
          </View>
          {lookup && (
            <Text style={[styles.lookupResult, lookup.kind === 'error' ? styles.lookupFail : styles.lookupSuccess]}>
              {lookup.message}
            </Text>
          )}
          {lookup && lookup.kind !== 'error' && lookup.conflicts.length > 0 && (
            <TouchableOpacity style={styles.lookupUseBtn} onPress={handleUseSuggested}>
              <Text style={styles.lookupUseText}>
                Use {lookup.kind === 'demo' ? 'Demo Mode' : "DVLA's"} values: {lookup.conflicts.map((c) => `${FIELD_LABELS[c.field]} ${c.suggested}`).join(', ')}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Basic details */}
        <Text style={styles.sectionTitle}>Details</Text>

        <Text style={styles.inputLabel}>Nickname</Text>
        <TextInput style={styles.input} value={form.nickname} onChangeText={(v) => handleChange('nickname', v)}
          placeholder="e.g. The Green Monster" placeholderTextColor={colors.mutedForeground} />

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Make{fromLookup('make')}</Text>
            <TextInput style={styles.input} value={form.make} onChangeText={(v) => handleChange('make', v)}
              placeholder="e.g. MINI" placeholderTextColor={colors.mutedForeground} />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Model</Text>
            <TextInput style={styles.input} value={form.model} onChangeText={(v) => handleChange('model', v)}
              placeholder="e.g. Cooper R50" placeholderTextColor={colors.mutedForeground} />
          </View>
        </View>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Year{fromLookup('year')}</Text>
            <TextInput style={styles.input} value={form.year.toString()}
              onChangeText={(v) => handleChange('year', parseInt(v, 10) || 0)}
              placeholder="2003" placeholderTextColor={colors.mutedForeground} keyboardType="numeric" />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Colour{fromLookup('colour')}</Text>
            <TextInput style={styles.input} value={form.colour} onChangeText={(v) => handleChange('colour', v)}
              placeholder="e.g. Racing Green" placeholderTextColor={colors.mutedForeground} />
          </View>
        </View>

        <Text style={styles.inputLabel}>Fuel Type{fromLookup('fuelType')}</Text>
        <View style={styles.fuelRow}>
          {fuelTypes.map((ft) => (
            <TouchableOpacity key={ft}
              style={[styles.fuelOption, form.fuelType === ft && styles.fuelOptionActive]}
              onPress={() => handleChange('fuelType', ft)}>
              <Text style={[styles.fuelOptionText, form.fuelType === ft && styles.fuelOptionTextActive]}>
                {ft.charAt(0).toUpperCase() + ft.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Performance */}
        <Text style={styles.sectionTitle}>Performance</Text>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Engine{fromLookup('engine')}</Text>
            <TextInput style={styles.input} value={form.engine} onChangeText={(v) => handleChange('engine', v)}
              placeholder="1.6L" placeholderTextColor={colors.mutedForeground} />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Power</Text>
            <TextInput style={styles.input} value={form.power} onChangeText={(v) => handleChange('power', v)}
              placeholder="115 bhp" placeholderTextColor={colors.mutedForeground} />
          </View>
        </View>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Torque</Text>
            <TextInput style={styles.input} value={form.torque} onChangeText={(v) => handleChange('torque', v)}
              placeholder="149 Nm" placeholderTextColor={colors.mutedForeground} />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>0–60</Text>
            <TextInput style={styles.input} value={form.zeroToSixty} onChangeText={(v) => handleChange('zeroToSixty', v)}
              placeholder="10.9s" placeholderTextColor={colors.mutedForeground} />
          </View>
        </View>

        <Text style={styles.inputLabel}>Top Speed</Text>
        <TextInput style={styles.input} value={form.topSpeed} onChangeText={(v) => handleChange('topSpeed', v)}
          placeholder="120 mph" placeholderTextColor={colors.mutedForeground} />

        {/* Odometer */}
        <Text style={styles.sectionTitle}>Odometer</Text>

        <Text style={styles.inputLabel}>Mileage</Text>
        <TextInput style={styles.input} value={form.mileage.toString()}
          onChangeText={(v) => handleChange('mileage', parseInt(v, 10) || 0)}
          placeholder="96512" placeholderTextColor={colors.mutedForeground} keyboardType="numeric" />

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>Save Changes</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

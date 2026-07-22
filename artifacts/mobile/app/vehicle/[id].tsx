import React, { useState, useCallback } from 'react';
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

type VehicleForm = Omit<Vehicle, 'id' | 'isActive' | 'fuelPercentage'>;

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

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
  const { vehicles, addVehicle, updateVehicle, deleteVehicle } = useApp();

  const existing = isNew ? null : vehicles.find((v) => v.id === id);

  const [form, setForm] = useState<VehicleForm>(() => {
    if (existing) {
      const { id: _id, isActive: _isActive, fuelPercentage: _fuel, ...rest } = existing;
      return rest;
    }
    return BLANK_FORM;
  });

  const [lookupReg, setLookupReg] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<string | null>(null);

  const handleChange = useCallback(<K extends keyof VehicleForm>(field: K, value: VehicleForm[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleSave = useCallback(() => {
    if (!form.make.trim() || !form.model.trim()) {
      Alert.alert('Missing info', 'Please enter at least Make and Model.');
      return;
    }
    if (isNew) {
      addVehicle({ ...form, fuelPercentage: 0, isActive: vehicles.length === 0 });
    } else {
      updateVehicle(id!, form);
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
            deleteVehicle(id!);
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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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

  const handleLookup = useCallback(() => {
    const cleaned = lookupReg.replace(/\s+/g, '').toUpperCase();
    if (!cleaned) {
      Alert.alert('Enter registration', 'Type a registration number to look up.');
      return;
    }
    setLookupLoading(true);
    setLookupResult(null);
    setTimeout(() => {
      const found = TEST_REGISTRATIONS[cleaned];
      if (found) {
        setForm((prev) => ({
          ...prev,
          registration: cleaned,
          make: found.make,
          model: found.model,
          year: found.year,
          colour: found.colour,
          fuelType: found.fuelType as VehicleForm['fuelType'],
          engine: found.engine,
        }));
        setLookupResult(`Found: ${found.year} ${found.make} ${found.model}`);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        setLookupResult('Live vehicle lookup is not connected. Unknown registration — please enter details manually.');
      }
      setLookupLoading(false);
    }, 900);
  }, [lookupReg]);

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

  const fuelTypes: Array<VehicleForm['fuelType']> = ['petrol', 'diesel', 'electric', 'hybrid'];

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

        {/* Registration lookup */}
        <Text style={styles.sectionTitle}>Registration Lookup</Text>
        <View style={styles.lookupCard}>
          <Text style={styles.lookupNote}>
            Demo mode — uses test registrations only. Real DVLA lookup not yet connected.
          </Text>
          <View style={styles.lookupRow}>
            <TextInput
              style={styles.lookupInput}
              placeholder="AB12 CDE"
              placeholderTextColor={colors.mutedForeground}
              value={lookupReg}
              onChangeText={setLookupReg}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={8}
            />
            <TouchableOpacity style={styles.lookupBtn} onPress={handleLookup} disabled={lookupLoading}>
              {lookupLoading
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.lookupBtnText}>Look up</Text>}
            </TouchableOpacity>
          </View>
          {lookupResult && (
            <Text style={[styles.lookupResult, lookupResult.startsWith('Found') ? styles.lookupSuccess : styles.lookupFail]}>
              {lookupResult}
            </Text>
          )}
        </View>

        {/* Basic details */}
        <Text style={styles.sectionTitle}>Details</Text>

        <Text style={styles.inputLabel}>Nickname</Text>
        <TextInput style={styles.input} value={form.nickname} onChangeText={(v) => handleChange('nickname', v)}
          placeholder="e.g. The Green Monster" placeholderTextColor={colors.mutedForeground} />

        <Text style={styles.inputLabel}>Registration</Text>
        <TextInput style={styles.input} value={form.registration}
          onChangeText={(v) => handleChange('registration', v.toUpperCase())}
          placeholder="AB12 CDE" placeholderTextColor={colors.mutedForeground}
          autoCapitalize="characters" autoCorrect={false} />

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Make</Text>
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
            <Text style={styles.inputLabel}>Year</Text>
            <TextInput style={styles.input} value={form.year.toString()}
              onChangeText={(v) => handleChange('year', parseInt(v, 10) || 0)}
              placeholder="2003" placeholderTextColor={colors.mutedForeground} keyboardType="numeric" />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.inputLabel}>Colour</Text>
            <TextInput style={styles.input} value={form.colour} onChangeText={(v) => handleChange('colour', v)}
              placeholder="e.g. Racing Green" placeholderTextColor={colors.mutedForeground} />
          </View>
        </View>

        <Text style={styles.inputLabel}>Fuel Type</Text>
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
            <Text style={styles.inputLabel}>Engine</Text>
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

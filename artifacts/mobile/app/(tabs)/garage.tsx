import React, { useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Platform, Image, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp, Vehicle } from '@/context/AppContext';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import * as Haptics from 'expo-haptics';

const MINI_IMAGE = require('@/assets/images/mini-cooper.png');

function VehicleIcon({ vehicle, size = 60 }: { vehicle: Vehicle; size?: number }) {
  const colors = useColors();
  if (vehicle.imageUri) {
    return <Image source={{ uri: vehicle.imageUri }} style={{ width: size, height: size, borderRadius: 10 }} resizeMode="cover" />;
  }
  if (vehicle.id === 'mock-vehicle-1') {
    return <Image source={MINI_IMAGE} style={{ width: size, height: size }} resizeMode="contain" />;
  }
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.muted, borderRadius: 10 }}>
      <Ionicons name="car" size={size * 0.55} color={colors.mutedForeground} />
    </View>
  );
}

export default function GarageScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { vehicles, setActiveVehicle, deleteVehicle, isLoading } = useApp();

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top + 16,
      paddingHorizontal: 20, paddingBottom: 16,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
      flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    },
    headerTitle: { fontSize: 28, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    addBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: colors.primary, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8,
    },
    addBtnText: { fontSize: 14, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    vehicleCard: {
      marginHorizontal: 20, marginBottom: 12, backgroundColor: colors.card,
      borderRadius: 18, padding: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    vehicleCardActive: { borderColor: colors.primary, borderWidth: 2 },
    activeBadge: {
      position: 'absolute', top: 12, right: 12,
      backgroundColor: colors.primary, borderRadius: 10,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    activeBadgeText: { fontSize: 10, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    cardRow: { flexDirection: 'row', gap: 14 },
    cardInfo: { flex: 1 },
    cardNickname: { fontSize: 17, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold' },
    cardSubtitle: { fontSize: 13, color: colors.mutedForeground, marginTop: 2, fontFamily: 'Inter_400Regular' },
    cardDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 12 },
    statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
    statItem: { alignItems: 'center' },
    statValue: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    statLabel: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 1 },
    cardActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
    actionBtn: {
      flex: 1, paddingVertical: 8, borderRadius: 10, borderWidth: 1,
      borderColor: colors.border, alignItems: 'center',
    },
    actionBtnText: { fontSize: 13, color: colors.foreground, fontFamily: 'Inter_500Medium' },
    setActiveBtn: { borderColor: colors.primary, backgroundColor: colors.primary + '10' },
    setActiveBtnText: { color: colors.primary },
    listContent: { paddingTop: 16, paddingBottom: (Platform.OS === 'web' ? 84 : insets.bottom + 50) + 16 },
    noActiveNote: {
      margin: 20, marginBottom: 0, padding: 14, backgroundColor: colors.muted, borderRadius: 12,
      borderWidth: 1, borderColor: colors.border,
    },
    noActiveText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
  });

  function handleDelete(v: Vehicle) {
    Alert.alert(
      'Remove this vehicle?',
      `"${v.nickname}" will be removed from your garage. Saved journeys will keep a historical record of this vehicle.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove Vehicle',
          style: 'destructive',
          onPress: () => {
            deleteVehicle(v.id);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          },
        },
      ],
    );
  }

  const activeVehicle = vehicles.find((v) => v.isActive) ?? null;
  const showNoActiveNote = vehicles.length > 0 && !activeVehicle;

  function VehicleCard({ vehicle }: { vehicle: Vehicle }) {
    const isActive = vehicle.isActive;
    return (
      <View style={[styles.vehicleCard, isActive && styles.vehicleCardActive]}>
        {isActive && <View style={styles.activeBadge}><Text style={styles.activeBadgeText}>ACTIVE</Text></View>}
        <TouchableOpacity onPress={() => router.push(`/vehicle/${vehicle.id}`)} activeOpacity={0.7}>
          <View style={styles.cardRow}>
            <VehicleIcon vehicle={vehicle} size={70} />
            <View style={styles.cardInfo}>
              <Text style={styles.cardNickname}>{vehicle.nickname}</Text>
              <Text style={styles.cardSubtitle}>{vehicle.year} {vehicle.make} {vehicle.model}</Text>
              <Text style={styles.cardSubtitle}>{vehicle.registration} · {vehicle.colour}</Text>
            </View>
          </View>
        </TouchableOpacity>
        <View style={styles.cardDivider} />
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{vehicle.mileage.toLocaleString()}</Text>
            <Text style={styles.statLabel}>Miles</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{vehicle.power || '—'}</Text>
            <Text style={styles.statLabel}>Power</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{vehicle.zeroToSixty || '—'}</Text>
            <Text style={styles.statLabel}>0–60</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{vehicle.fuelType.charAt(0).toUpperCase() + vehicle.fuelType.slice(1)}</Text>
            <Text style={styles.statLabel}>Fuel</Text>
          </View>
        </View>
        <View style={styles.cardActions}>
          {!isActive && (
            <TouchableOpacity
              style={[styles.actionBtn, styles.setActiveBtn]}
              onPress={() => { setActiveVehicle(vehicle.id); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            >
              <Text style={[styles.actionBtnText, styles.setActiveBtnText]}>Set Active</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.actionBtn} onPress={() => router.push(`/vehicle/${vehicle.id}`)}>
            <Text style={styles.actionBtnText}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => handleDelete(vehicle)}>
            <Text style={[styles.actionBtnText, { color: colors.destructive }]}>Remove</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Garage</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => router.push('/vehicle/new')}>
          <Ionicons name="add" size={16} color="#fff" />
          <Text style={styles.addBtnText}>Add Vehicle</Text>
        </TouchableOpacity>
      </View>

      {showNoActiveNote && (
        <View style={styles.noActiveNote}>
          <Text style={styles.noActiveText}>No active vehicle. Tap "Set Active" on a vehicle to select it.</Text>
        </View>
      )}

      {/* Loading skeleton */}
      {isLoading && vehicles.length === 0 ? (
        <LoadingState rows={3} style={{ paddingTop: 16 }} />
      ) : (
        <FlatList
          data={vehicles}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <VehicleCard vehicle={item} />}
          ListEmptyComponent={
            <EmptyState
              icon="car-outline"
              title="Empty Garage"
              subtitle="Add your first vehicle to get started with journey tracking."
            />
          }
        />
      )}
    </View>
  );
}

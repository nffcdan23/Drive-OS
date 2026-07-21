import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isPassengerMode, togglePassengerMode } = useApp();

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
    scroll: { flex: 1 },
    content: { padding: 20, paddingBottom: 40 },
    sectionTitle: {
      fontSize: 13, fontWeight: '600', color: colors.mutedForeground,
      fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 0.5,
      marginBottom: 8, marginTop: 20,
    },
    card: {
      backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    rowLast: { borderBottomWidth: 0 },
    rowIcon: {
      width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    },
    rowLabel: { flex: 1, fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular' },
    rowSub: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 1 },
    // Passenger mode toggle card
    passengerCard: {
      backgroundColor: isPassengerMode ? colors.primary + '15' : colors.card,
      borderRadius: 16, padding: 16,
      borderWidth: isPassengerMode ? 2 : StyleSheet.hairlineWidth,
      borderColor: isPassengerMode ? colors.primary : colors.border,
    },
    passengerCardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    passengerIconWrap: {
      width: 48, height: 48, borderRadius: 24,
      backgroundColor: isPassengerMode ? colors.primary : colors.muted,
      alignItems: 'center', justifyContent: 'center',
    },
    passengerTitle: { fontSize: 17, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', flex: 1 },
    passengerToggle: {
      width: 52, height: 30, borderRadius: 15, borderWidth: 1,
      borderColor: isPassengerMode ? colors.primary : colors.border,
      backgroundColor: isPassengerMode ? colors.primary : colors.muted,
      padding: 2, justifyContent: 'center',
    },
    passengerThumb: {
      width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff',
      alignSelf: isPassengerMode ? 'flex-end' : 'flex-start',
    },
    passengerDesc: {
      fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular',
      lineHeight: 19, marginTop: 12,
    },
    passengerBullet: {
      fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular',
      marginTop: 4, paddingLeft: 8,
    },
    activeIndicator: {
      marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
      alignSelf: 'flex-start',
    },
    activeIndicatorText: { fontSize: 12, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold' },
    futureNote: {
      backgroundColor: colors.muted, borderRadius: 12, padding: 14, marginTop: 8,
    },
    futureNoteTitle: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    futureNoteText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 4, lineHeight: 19 },
  });

  function handleTogglePassenger() {
    togglePassengerMode();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }

  const settingsRows: Array<{ icon: string; iconBg: string; label: string; sub?: string; onPress: () => void; last?: boolean }> = [
    { icon: 'location-outline', iconBg: '#3b82f6', label: 'Location Sharing', sub: 'Allow friends to see your location', onPress: () => {} },
    { icon: 'shield-checkmark-outline', iconBg: '#22c55e', label: 'Privacy', sub: 'Manage what friends can see', onPress: () => {} },
    { icon: 'notifications-outline', iconBg: '#f59e0b', label: 'Notifications', sub: 'Convoy invites, journey reminders', onPress: () => {} },
    { icon: 'bluetooth-outline', iconBg: '#8b5cf6', label: 'OBD2 Dongle', sub: 'Connect a diagnostics dongle', onPress: () => {} },
    { icon: 'tablet-landscape-outline', iconBg: '#06b6d4', label: 'HUD Display', sub: 'Connect a heads-up display device', onPress: () => {}, last: true },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        <Text style={styles.sectionTitle}>Passenger Mode</Text>
        <TouchableOpacity style={styles.passengerCard} onPress={handleTogglePassenger} activeOpacity={0.85}>
          <View style={styles.passengerCardTop}>
            <View style={styles.passengerIconWrap}>
              <Ionicons name="walk-outline" size={22} color={isPassengerMode ? '#fff' : colors.mutedForeground} />
            </View>
            <Text style={styles.passengerTitle}>Passenger Mode</Text>
            <View style={styles.passengerToggle}>
              <View style={styles.passengerThumb} />
            </View>
          </View>
          <Text style={styles.passengerDesc}>
            When active, location may continue updating but:
          </Text>
          <Text style={styles.passengerBullet}>· Journey data is not recorded</Text>
          <Text style={styles.passengerBullet}>· Speed is not attributed to your vehicle</Text>
          <Text style={styles.passengerBullet}>· Top-speed records are not updated</Text>
          <Text style={styles.passengerBullet}>· XP and achievements are not awarded</Text>
          {isPassengerMode && (
            <View style={styles.activeIndicator}>
              <Ionicons name="checkmark-circle" size={14} color="#fff" />
              <Text style={styles.activeIndicatorText}>Passenger Mode Active</Text>
            </View>
          )}
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>App Settings</Text>
        <View style={styles.card}>
          {settingsRows.map((item, i) => (
            <TouchableOpacity
              key={i}
              style={[styles.row, item.last && styles.rowLast]}
              onPress={item.onPress}
            >
              <View style={[styles.rowIcon, { backgroundColor: item.iconBg + '20' }]}>
                <Ionicons name={item.icon as any} size={18} color={item.iconBg} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>{item.label}</Text>
                {item.sub && <Text style={styles.rowSub}>{item.sub}</Text>}
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Future Features</Text>
        <View style={styles.futureNote}>
          <Text style={styles.futureNoteTitle}>OBD2 &amp; HUD Integration</Text>
          <Text style={styles.futureNoteText}>
            Real-time diagnostics via OBD2 dongle and heads-up display support are planned for a future update.
            Vehicle health data, live stats overlay, and more.
          </Text>
        </View>

        <View style={[styles.futureNote, { marginTop: 10 }]}>
          <Text style={styles.futureNoteTitle}>DVLA Vehicle Lookup</Text>
          <Text style={styles.futureNoteText}>
            Automatic vehicle details from registration plate. Requires backend API key
            (DVLA_API_KEY — never stored in the frontend). Set EXPO_PUBLIC_DVLA_PROXY_URL to connect.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

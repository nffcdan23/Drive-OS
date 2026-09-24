import React, { useState } from 'react';
import { APP_NAME } from '@/constants/brand';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Platform, Alert, Modal, ActivityIndicator, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { describeError } from '@/lib/backend/http';
import { UnitSystem, UNIT_SYSTEM_OPTIONS } from '@/lib/units';
import * as Haptics from 'expo-haptics';

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isPassengerMode, togglePassengerMode, unitSystem, setUnitSystem, hasUnsyncedWork, clearLocalData, deleteAccount, retrySync, sync } = useApp();
  const { email, signOut } = useAuth();
  const [showDelete, setShowDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function doSignOut() {
    await clearLocalData();
    await signOut();
  }

  function handleSignOut() {
    if (hasUnsyncedWork()) {
      Alert.alert(
        'Changes not uploaded yet',
        'Some changes or drives are still on this phone and haven\'t reached your account. Signing out now will lose them.',
        [
          { text: 'Try to upload', onPress: () => { void retrySync(); } },
          { text: 'Sign out anyway', style: 'destructive', onPress: () => { void doSignOut(); } },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }
    Alert.alert('Sign out?', 'Your data stays in your account. Sign in again on any phone to get it back.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', onPress: () => { void doSignOut(); } },
    ]);
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    try {
      await deleteAccount();
      setShowDelete(false);
      await signOut().catch(() => {});
    } catch (err) {
      Alert.alert('Account not deleted', describeError(err));
    } finally {
      setDeleting(false);
    }
  }

  const [showUnitsPicker, setShowUnitsPicker] = useState(false);

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
    // Modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalContent: {
      backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
      padding: 24, paddingBottom: Math.max(insets.bottom, 16) + 16,
    },
    modalHandle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    modalTitle: { fontSize: 18, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginBottom: 4 },
    modalSub: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginBottom: 20 },
    modalRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    modalRowLast: { borderBottomWidth: 0 },
    modalOptionIcon: {
      width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    },
    modalRowLabel: { flex: 1, fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular' },
    modalRowLabelActive: { color: colors.primary, fontFamily: 'Inter_600SemiBold' },
    modalRowSub: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 1 },
  });

  function handleTogglePassenger() {
    togglePassengerMode();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }

  function handleSelectUnit(s: UnitSystem) {
    setUnitSystem(s);
    Haptics.selectionAsync();
    setShowUnitsPicker(false);
  }

  const currentUnitLabel = UNIT_SYSTEM_OPTIONS.find((o) => o.value === unitSystem)?.label ?? 'Automatic';

  const UNIT_ICONS: Record<UnitSystem, string> = {
    auto:     'globe-outline',
    imperial: 'flag-outline',
    metric:   'calculator-outline',
  };

  const settingsRows: Array<{
    icon: string; iconBg: string; label: string; sub?: string; onPress: () => void; last?: boolean;
  }> = [
    { icon: 'speedometer-outline', iconBg: '#F4631A', label: 'Units of measurement', sub: currentUnitLabel, onPress: () => { setShowUnitsPicker(true); Haptics.selectionAsync(); } },
    { icon: 'location-outline',    iconBg: '#3b82f6', label: 'Location Sharing',     sub: 'Allow friends to see your location', onPress: () => {} },
    { icon: 'shield-checkmark-outline', iconBg: '#22c55e', label: 'Privacy',          sub: 'Manage what friends can see', onPress: () => {} },
    { icon: 'notifications-outline',    iconBg: '#f59e0b', label: 'Notifications',    sub: 'Convoy invites, journey reminders', onPress: () => {} },
    { icon: 'bluetooth-outline',   iconBg: '#8b5cf6', label: 'OBD2 Dongle',          sub: 'Connect a diagnostics dongle', onPress: () => {} },
    { icon: 'tablet-landscape-outline', iconBg: '#06b6d4', label: 'HUD Display',     sub: 'Connect a heads-up display device', onPress: () => {}, last: true },
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

        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.rowIcon, { backgroundColor: colors.primary + '20' }]}>
              <Ionicons name="person-circle-outline" size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>Signed in</Text>
              <Text style={styles.rowSub}>{email ?? 'Apple ID / Google account'}</Text>
              <Text style={styles.rowSub}>
                {sync.lastSyncedAt ? `Last synced ${new Date(sync.lastSyncedAt).toLocaleString('en-GB')}` : 'Not synced yet'}
              </Text>
            </View>
          </View>
          <TouchableOpacity style={styles.row} onPress={handleSignOut} accessibilityRole="button">
            <View style={[styles.rowIcon, { backgroundColor: colors.mutedForeground + '20' }]}>
              <Ionicons name="log-out-outline" size={18} color={colors.foreground} />
            </View>
            <Text style={styles.rowLabel}>Sign out</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.row, styles.rowLast]} onPress={() => { setDeleteText(''); setShowDelete(true); }} accessibilityRole="button">
            <View style={[styles.rowIcon, { backgroundColor: colors.destructive + '20' }]}>
              <Ionicons name="trash-outline" size={18} color={colors.destructive} />
            </View>
            <Text style={[styles.rowLabel, { color: colors.destructive }]}>Delete account</Text>
          </TouchableOpacity>
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
            Automatic vehicle details from the registration plate, looked up by the {APP_NAME} server
            (the DVLA key never ships in the app). Available when the server has it configured.
          </Text>
        </View>
      </ScrollView>

      {/* Delete account confirmation */}
      <Modal visible={showDelete} transparent animationType="fade" onRequestClose={() => setShowDelete(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: colors.card, borderRadius: 20, padding: 20, gap: 12 }}>
            <Text style={{ color: colors.foreground, fontSize: 18, fontFamily: 'Inter_700Bold' }}>Delete your account?</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 }}>
              This permanently deletes your profile, vehicles, photos, documents, journeys, saved places, Beauty Spots,
              friends and memberships from {APP_NAME} on every device. It can't be undone.
            </Text>
            <Text style={{ color: colors.foreground, fontSize: 14, fontFamily: 'Inter_600SemiBold' }}>Type DELETE to confirm</Text>
            <TextInput
              value={deleteText} onChangeText={setDeleteText} autoCapitalize="characters" autoCorrect={false}
              style={{ height: 46, borderRadius: 12, borderWidth: 1, borderColor: colors.input, color: colors.foreground, paddingHorizontal: 14, fontSize: 16 }}
            />
            <TouchableOpacity
              disabled={deleteText !== 'DELETE' || deleting}
              onPress={handleDeleteAccount}
              style={{ height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: deleteText === 'DELETE' ? colors.destructive : colors.muted }}
            >
              {deleting ? <ActivityIndicator color={colors.destructiveForeground} /> : (
                <Text style={{ color: deleteText === 'DELETE' ? colors.destructiveForeground : colors.mutedForeground, fontFamily: 'Inter_600SemiBold', fontSize: 16 }}>Delete permanently</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowDelete(false)} style={{ alignItems: 'center', padding: 8 }}>
              <Text style={{ color: colors.primary, fontFamily: 'Inter_600SemiBold', fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Units of measurement picker */}
      <Modal
        visible={showUnitsPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowUnitsPicker(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowUnitsPicker(false)}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View style={styles.modalContent}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Units of measurement</Text>
              <Text style={styles.modalSub}>
                Choose how distances and speeds are displayed across the app.
              </Text>
              {UNIT_SYSTEM_OPTIONS.map((opt, i) => {
                const isActive = unitSystem === opt.value;
                const isLast = i === UNIT_SYSTEM_OPTIONS.length - 1;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.modalRow, isLast && styles.modalRowLast]}
                    onPress={() => handleSelectUnit(opt.value)}
                  >
                    <View style={[
                      styles.modalOptionIcon,
                      { backgroundColor: isActive ? colors.primary + '20' : colors.muted },
                    ]}>
                      <Ionicons
                        name={UNIT_ICONS[opt.value] as any}
                        size={18}
                        color={isActive ? colors.primary : colors.mutedForeground}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.modalRowLabel, isActive && styles.modalRowLabelActive]}>
                        {opt.label}
                      </Text>
                      <Text style={styles.modalRowSub}>{opt.sub}</Text>
                    </View>
                    {isActive && (
                      <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

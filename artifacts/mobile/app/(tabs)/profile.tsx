import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { userProfile, vehicles, journeys } = useApp();

  const xpProgress = userProfile.xp / userProfile.xpToNextLevel;
  const unlockedAchievements = userProfile.achievements.filter((a) => a.unlockedAt !== null);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { flex: 1 },
    content: {
      paddingBottom: (Platform.OS === 'web' ? 84 : insets.bottom + 50) + 16,
    },
    heroSection: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top + 24,
      paddingHorizontal: 20, paddingBottom: 24,
      backgroundColor: colors.card,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
      alignItems: 'center',
    },
    avatar: {
      width: 80, height: 80, borderRadius: 40,
      backgroundColor: colors.primary + '20', alignItems: 'center', justifyContent: 'center',
      borderWidth: 3, borderColor: colors.primary,
    },
    avatarText: { fontSize: 28, fontWeight: '700', color: colors.primary, fontFamily: 'Inter_700Bold' },
    driverName: { fontSize: 22, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginTop: 12 },
    levelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
    levelBadge: {
      backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3,
    },
    levelBadgeText: { fontSize: 12, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold' },
    levelLabel: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    xpRow: { width: '100%', marginTop: 14 },
    xpLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
    xpLabel: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    xpBar: { height: 6, backgroundColor: colors.muted, borderRadius: 3 },
    xpFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
    settingsBtn: { position: 'absolute', top: Platform.OS === 'web' ? 67 + insets.top : insets.top + 16, right: 20 },
    statsSection: { padding: 20 },
    sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', marginBottom: 12 },
    statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    statCard: {
      flex: 1, minWidth: '45%', backgroundColor: colors.card, borderRadius: 14, padding: 14,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center',
    },
    statValue: { fontSize: 20, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginTop: 6 },
    statLabel: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2, textAlign: 'center' },
    achievementsSection: { paddingHorizontal: 20, paddingBottom: 12 },
    achievementRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    achievementCard: {
      width: '30%', alignItems: 'center', padding: 10, borderRadius: 14,
      backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    achievementLocked: { opacity: 0.35 },
    achievementTitle: { fontSize: 10, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', textAlign: 'center', marginTop: 6 },
    settingsSection: { paddingHorizontal: 20 },
    settingsCard: {
      backgroundColor: colors.card, borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: 'hidden',
    },
    settingsRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    settingsLabel: { flex: 1, fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular' },
  });

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Hero */}
        <View style={styles.heroSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{userProfile.name.charAt(0)}</Text>
          </View>
          <Text style={styles.driverName}>{userProfile.name}</Text>
          <View style={styles.levelRow}>
            <View style={styles.levelBadge}>
              <Text style={styles.levelBadgeText}>LVL {userProfile.level}</Text>
            </View>
            <Text style={styles.levelLabel}>Driver</Text>
          </View>
          <View style={styles.xpRow}>
            <View style={styles.xpLabelRow}>
              <Text style={styles.xpLabel}>{userProfile.xp.toLocaleString()} XP</Text>
              <Text style={styles.xpLabel}>{userProfile.xpToNextLevel.toLocaleString()} XP to Level {userProfile.level + 1}</Text>
            </View>
            <View style={styles.xpBar}>
              <View style={[styles.xpFill, { width: `${Math.min(100, xpProgress * 100)}%` as any }]} />
            </View>
          </View>
        </View>

        <TouchableOpacity style={styles.settingsBtn} onPress={() => router.push('/settings')}>
          <Ionicons name="settings-outline" size={24} color={colors.foreground} />
        </TouchableOpacity>

        {/* Stats */}
        <View style={styles.statsSection}>
          <Text style={styles.sectionTitle}>Stats</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Ionicons name="navigate-outline" size={20} color={colors.primary} />
              <Text style={styles.statValue}>{userProfile.totalDistance.toLocaleString()}</Text>
              <Text style={styles.statLabel}>Total km</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="flag-outline" size={20} color={colors.primary} />
              <Text style={styles.statValue}>{userProfile.totalJourneys}</Text>
              <Text style={styles.statLabel}>Journeys</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="car-outline" size={20} color={colors.primary} />
              <Text style={styles.statValue}>{vehicles.length}</Text>
              <Text style={styles.statLabel}>Vehicles</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="people-outline" size={20} color={colors.primary} />
              <Text style={styles.statValue}>5</Text>
              <Text style={styles.statLabel}>Friends</Text>
            </View>
          </View>
        </View>

        {/* Achievements */}
        <View style={styles.achievementsSection}>
          <Text style={styles.sectionTitle}>
            Achievements · {unlockedAchievements.length}/{userProfile.achievements.length}
          </Text>
          <View style={styles.achievementRow}>
            {userProfile.achievements.map((ach) => (
              <View key={ach.id} style={[styles.achievementCard, !ach.unlockedAt && styles.achievementLocked]}>
                <Ionicons name={ach.icon as any} size={24} color={ach.unlockedAt ? colors.primary : colors.mutedForeground} />
                <Text style={styles.achievementTitle}>{ach.title}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Settings shortcuts */}
        <View style={styles.settingsSection}>
          <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Settings</Text>
          <View style={styles.settingsCard}>
            {[
              { icon: 'person-outline', label: 'Edit Profile', onPress: () => {} },
              { icon: 'shield-checkmark-outline', label: 'Privacy & Location Sharing', onPress: () => {} },
              { icon: 'walk-outline', label: 'Passenger Mode', onPress: () => router.push('/settings') },
              { icon: 'car-outline', label: 'Connected Devices (OBD / HUD)', onPress: () => {} },
              { icon: 'information-circle-outline', label: 'About DriveOS', onPress: () => {} },
            ].map((item, i) => (
              <TouchableOpacity key={i} style={[styles.settingsRow, i === 4 && { borderBottomWidth: 0 }]} onPress={item.onPress}>
                <Ionicons name={item.icon as any} size={20} color={colors.mutedForeground} />
                <Text style={styles.settingsLabel}>{item.label}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

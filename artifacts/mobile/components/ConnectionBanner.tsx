/**
 * Always-visible status for the connection to DriveOS's servers. Hidden
 * when everything is synced; otherwise it says what's wrong and what's
 * waiting on this phone, so failures are never silent.
 */
import React from 'react';
import { APP_NAME } from '@/constants/brand';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { cockpit } from '@/constants/colors';

type Tone = 'warn' | 'error' | 'info';

export function ConnectionBanner() {
  const insets = useSafeAreaInsets();
  const { sync, retrySync, dismissRejections } = useApp();
  const { signOut } = useAuth();

  const waiting = [
    sync.pendingChanges ? `${sync.pendingChanges} change${sync.pendingChanges === 1 ? '' : 's'}` : null,
    sync.pendingJourneys ? `${sync.pendingJourneys} drive${sync.pendingJourneys === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' and ');

  let tone: Tone = 'info';
  let icon: keyof typeof Ionicons.glyphMap = 'cloud-upload-outline';
  let text: string | null = null;
  let action: { label: string; onPress: () => void } | null = null;

  if (sync.connection === 'signed_out') {
    tone = 'error'; icon = 'log-in-outline';
    text = 'Your session has ended. Sign in again to keep syncing.';
    action = { label: 'Sign in', onPress: () => void signOut() };
  } else if (sync.connection === 'offline') {
    tone = 'warn'; icon = 'cloud-offline-outline';
    text = waiting ? `Offline — ${waiting} saved on this phone, will upload when back online.` : "Offline — showing data saved on this phone.";
    action = { label: 'Retry', onPress: () => void retrySync() };
  } else if (sync.connection === 'server_error') {
    tone = 'error'; icon = 'warning-outline';
    text = `${APP_NAME} server problem${waiting ? ` — ${waiting} saved on this phone` : ''}. ${sync.lastError ?? ''}`.trim();
    action = { label: 'Retry', onPress: () => void retrySync() };
  } else if (sync.rejected.length) {
    tone = 'error'; icon = 'alert-circle-outline';
    text = `${sync.rejected.length === 1 ? 'A change was' : `${sync.rejected.length} changes were`} not saved: ${sync.rejected[0]!.message}`;
    action = { label: 'Dismiss', onPress: () => void dismissRejections() };
  } else if (waiting) {
    tone = 'info';
    text = `Uploading ${waiting}…`;
    action = sync.lastError ? { label: 'Retry', onPress: () => void retrySync() } : null;
  } else if (sync.lastError && sync.connection !== 'unknown') {
    tone = 'warn'; icon = 'alert-circle-outline';
    text = `Some data couldn't be refreshed: ${sync.lastError}`;
    action = { label: 'Retry', onPress: () => void retrySync() };
  }

  if (!text) return null;
  const bg = tone === 'error' ? '#3A1618' : tone === 'warn' ? '#3A2A12' : '#16283A';
  const fg = tone === 'error' ? '#F7B4B4' : tone === 'warn' ? '#F3D29B' : '#B9D7F5';

  return (
    // In the layout flow (not floating), so it never covers a screen's header or back button.
    <View style={[styles.wrap, { paddingTop: insets.top + 4 }]}>
      <View style={[styles.pill, { backgroundColor: bg }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
        <Ionicons name={icon} size={16} color={fg} />
        <Text style={[styles.text, { color: fg }]} numberOfLines={2}>{text}</Text>
        {action ? (
          <TouchableOpacity onPress={action.onPress} style={styles.action} hitSlop={8}>
            <Text style={[styles.actionText, { color: fg }]}>{action.label}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 4, alignItems: 'center', backgroundColor: '#0A0D10' },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: cockpit.radius.control, maxWidth: 560, width: '100%',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 6,
  },
  text: { flex: 1, fontFamily: cockpit.type.body, fontSize: 13, lineHeight: 17 },
  action: { paddingHorizontal: 8, paddingVertical: 4 },
  actionText: { fontFamily: cockpit.type.label, fontSize: 13, textDecorationLine: 'underline' },
});

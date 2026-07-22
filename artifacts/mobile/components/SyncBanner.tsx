import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface SyncBannerProps {
  /** Whether the banner is visible */
  visible: boolean;
  /** Called when the user taps the retry button */
  onRetry: () => void;
  /** Status of the current sync attempt */
  status: 'waiting' | 'syncing' | 'error';
}

export function SyncBanner({ visible, onRetry, status }: SyncBannerProps) {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(100)).current;
  const pulseOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue:         visible ? 0 : 100,
      useNativeDriver: true,
      tension:         80,
      friction:        12,
    }).start();
  }, [visible, translateY]);

  useEffect(() => {
    if (status !== 'syncing') {
      pulseOpacity.stopAnimation();
      pulseOpacity.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseOpacity, { toValue: 0.4, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseOpacity, { toValue: 1,   duration: 600, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [status, pulseOpacity]);

  const label =
    status === 'syncing' ? 'Syncing journey…' :
    status === 'error'   ? 'Sync failed — tap to retry' :
                           'Journey saved on device — waiting to sync';

  return (
    <Animated.View
      style={[
        styles.banner,
        { paddingBottom: insets.bottom + 12, transform: [{ translateY }] },
      ]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <Animated.View style={[styles.icon, { opacity: pulseOpacity }]}>
        <MaterialCommunityIcons
          name={status === 'error' ? 'alert-circle' : 'cloud-upload-outline'}
          size={18}
          color={status === 'error' ? '#FF6B6B' : '#FFD700'}
        />
      </Animated.View>

      <Text style={styles.label} numberOfLines={1}>{label}</Text>

      {status !== 'syncing' && (
        <TouchableOpacity onPress={onRetry} style={styles.retryBtn} activeOpacity={0.7}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position:        'absolute',
    bottom:          0,
    left:            0,
    right:           0,
    backgroundColor: '#1A1A2E',
    borderTopWidth:  1,
    borderTopColor:  '#2A2A4A',
    flexDirection:   'row',
    alignItems:      'center',
    paddingTop:      14,
    paddingHorizontal: 16,
    gap:             10,
    zIndex:          999,
  },
  icon:      { width: 24, alignItems: 'center' },
  label:     { flex: 1, fontSize: 13, color: '#C0C0D0', fontFamily: 'Inter_400Regular' },
  retryBtn:  { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#2A2A4A', borderRadius: 8 },
  retryText: { fontSize: 13, color: '#4B9EFF', fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
});

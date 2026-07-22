import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, ViewStyle } from 'react-native';

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
}

export function Skeleton({ width = '100%', height = 16, borderRadius = 8, style }: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        { width: width as number, height, borderRadius, backgroundColor: '#2A2A3A', opacity },
        style,
      ]}
    />
  );
}

interface LoadingStateProps {
  rows?: number;
  style?: ViewStyle;
}

export function LoadingState({ rows = 3, style }: LoadingStateProps) {
  return (
    <View style={[styles.container, style]}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={styles.card}>
          <View style={styles.row}>
            <Skeleton width={48} height={48} borderRadius={12} />
            <View style={styles.textGroup}>
              <Skeleton width={120} height={14} />
              <Skeleton width={80} height={11} style={{ marginTop: 6 }} />
            </View>
          </View>
          <Skeleton height={1} style={{ marginTop: 12, opacity: 0.5 }} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingTop: 8 },
  card:      { marginBottom: 4, paddingVertical: 12 },
  row:       { flexDirection: 'row', alignItems: 'center', gap: 12 },
  textGroup: { flex: 1, gap: 0 },
});

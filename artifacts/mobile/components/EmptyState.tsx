import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface EmptyStateProps {
  icon: IconName;
  title: string;
  subtitle?: string;
  style?: ViewStyle;
  children?: React.ReactNode;
}

export function EmptyState({ icon, title, subtitle, style, children }: EmptyStateProps) {
  return (
    <View style={[styles.container, style]}>
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={48} color="#4B9EFF" />
      </View>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex:              1,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: 32,
    paddingVertical:   48,
  },
  iconWrap: {
    width:           88,
    height:          88,
    borderRadius:    44,
    backgroundColor: 'rgba(75,158,255,0.12)',
    alignItems:      'center',
    justifyContent:  'center',
    marginBottom:    20,
  },
  title: {
    fontSize:    18,
    fontWeight:  '600',
    color:       '#FFFFFF',
    textAlign:   'center',
    marginBottom: 8,
    fontFamily:  'Inter_600SemiBold',
  },
  subtitle: {
    fontSize:   14,
    color:      '#8E8EA0',
    textAlign:  'center',
    lineHeight: 20,
    fontFamily: 'Inter_400Regular',
  },
});

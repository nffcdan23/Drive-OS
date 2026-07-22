import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  style?: ViewStyle;
}

export function ErrorState({
  message = 'Something went wrong. Please try again.',
  onRetry,
  style,
}: ErrorStateProps) {
  return (
    <View style={[styles.container, style]}>
      <View style={styles.iconWrap}>
        <Ionicons name="alert-circle-outline" size={48} color="#FF6B6B" />
      </View>
      <Text style={styles.title}>Couldn't load data</Text>
      <Text style={styles.message}>{message}</Text>
      {onRetry ? (
        <TouchableOpacity style={styles.button} onPress={onRetry} activeOpacity={0.8}>
          <Ionicons name="refresh-outline" size={16} color="#FFFFFF" />
          <Text style={styles.buttonText}>Try again</Text>
        </TouchableOpacity>
      ) : null}
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
    backgroundColor: 'rgba(255,107,107,0.12)',
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
  message: {
    fontSize:    14,
    color:       '#8E8EA0',
    textAlign:   'center',
    lineHeight:  20,
    marginBottom: 24,
    fontFamily:  'Inter_400Regular',
  },
  button: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               8,
    backgroundColor:   '#4B9EFF',
    paddingVertical:   12,
    paddingHorizontal: 24,
    borderRadius:      12,
  },
  buttonText: {
    color:      '#FFFFFF',
    fontSize:   15,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
});

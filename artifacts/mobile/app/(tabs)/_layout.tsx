import React from 'react';
import { Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { useApp } from '@/context/AppContext';
import { useColors } from '@/hooks/useColors';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Tabs } from 'expo-router';
import { Icon, Label, NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function NativeTabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: 'map', selected: 'map.fill' }} />
        <Label>Map</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="journeys">
        <Icon sf={{ default: 'location.circle', selected: 'location.circle.fill' }} />
        <Label>Journeys</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="garage">
        <Icon sf={{ default: 'car', selected: 'car.fill' }} />
        <Label>Garage</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="community">
        <Icon sf={{ default: 'person.2', selected: 'person.2.fill' }} />
        <Label>Community</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <Icon sf={{ default: 'person.circle', selected: 'person.circle.fill' }} />
        <Label>Profile</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';
  const insets = useSafeAreaInsets();
  const { isDriving } = useApp();

  // Floating pill dimensions
  const TAB_H = 66;
  const TAB_BOTTOM = isWeb ? 16 : Math.max(insets.bottom, 16);
  const TAB_RADIUS = 26;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.tabInactive ?? colors.mutedForeground,
        tabBarStyle: isDriving
          ? { display: 'none' }
          : {
              position: 'absolute',
              left: 16,
              right: 16,
              bottom: TAB_BOTTOM,
              height: TAB_H,
              borderRadius: TAB_RADIUS,
              backgroundColor: isIOS ? 'transparent' : colors.tabBarBg ?? colors.background,
              borderTopWidth: 0,
              elevation: 0,
              // Warm shadow
              shadowColor: '#2E2414',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.18,
              shadowRadius: 24,
              // Border
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.surfaceBorder ?? colors.border,
              paddingBottom: 0,
              overflow: isIOS ? 'hidden' : 'visible',
            },
        tabBarBackground: () =>
          isIOS && !isDriving ? (
            <BlurView
              intensity={80}
              tint={isDark ? 'dark' : 'light'}
              style={[StyleSheet.absoluteFill, { borderRadius: TAB_RADIUS, overflow: 'hidden' }]}
            />
          ) : isWeb && !isDriving ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.tabBarBg ?? colors.background, borderRadius: TAB_RADIUS },
              ]}
            />
          ) : null,
        tabBarLabelStyle: {
          fontSize: 11,
          fontFamily: 'Inter_500Medium',
          marginBottom: 4,
        },
        tabBarItemStyle: {
          paddingTop: 10,
          paddingBottom: 6,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Map',
          tabBarIcon: ({ color }) =>
            Platform.OS === 'ios' ? (
              <SymbolView name="map" tintColor={color} size={22} />
            ) : (
              <Ionicons name="map-outline" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="journeys"
        options={{
          title: 'Journeys',
          tabBarIcon: ({ color }) =>
            Platform.OS === 'ios' ? (
              <SymbolView name="location.circle" tintColor={color} size={22} />
            ) : (
              <Ionicons name="navigate-outline" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="garage"
        options={{
          title: 'Garage',
          tabBarIcon: ({ color }) =>
            Platform.OS === 'ios' ? (
              <SymbolView name="car" tintColor={color} size={22} />
            ) : (
              <Ionicons name="car-outline" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="community"
        options={{
          title: 'Community',
          tabBarIcon: ({ color }) =>
            Platform.OS === 'ios' ? (
              <SymbolView name="person.2" tintColor={color} size={22} />
            ) : (
              <Ionicons name="people-outline" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) =>
            Platform.OS === 'ios' ? (
              <SymbolView name="person.circle" tintColor={color} size={22} />
            ) : (
              <Ionicons name="person-outline" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}

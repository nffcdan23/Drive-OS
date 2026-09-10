import React from 'react';
import { Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { useApp } from '@/context/AppContext';
import { useColors } from '@/hooks/useColors';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Tabs } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function NativeTabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: 'map', selected: 'map.fill' }} />
        <NativeTabs.Trigger.Label>Map</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="journeys">
        <NativeTabs.Trigger.Icon sf={{ default: 'location.circle', selected: 'location.circle.fill' }} />
        <NativeTabs.Trigger.Label>Journeys</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="garage">
        <NativeTabs.Trigger.Icon sf={{ default: 'car', selected: 'car.fill' }} />
        <NativeTabs.Trigger.Label>Garage</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="community">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.2', selected: 'person.2.fill' }} />
        <NativeTabs.Trigger.Label>Community</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.circle', selected: 'person.circle.fill' }} />
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
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
  // iOS 26 exposes the real liquid glass material, so the pill uses it directly
  // rather than a blur approximation.  Older iOS falls back to BlurView.
  const liquidGlass = isIOS && isLiquidGlassAvailable();

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
              borderWidth: liquidGlass ? 0 : StyleSheet.hairlineWidth,
              borderColor: colors.surfaceBorder ?? colors.border,
              paddingBottom: 0,
              overflow: isIOS ? 'hidden' : 'visible',
            },
        tabBarBackground: () =>
          liquidGlass && !isDriving ? (
            <GlassView
              glassEffectStyle="regular"
              style={[StyleSheet.absoluteFill, { borderRadius: TAB_RADIUS, overflow: 'hidden' }]}
            />
          ) : isIOS && !isDriving ? (
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
  // Apple's own tab bar is the only thing that renders true liquid glass, so
  // iOS 26 uses it.  The trade-off is that expo-router 6 cannot hide a native
  // tab bar — only individual triggers — so it stays visible during a drive.
  // Hiding it properly means presenting the drive UI as a route outside this
  // navigator, which is the intended fix; the classic layout's display:'none'
  // trick cannot reach the native bar.
  //
  // Everything else (Android, web, pre-26 iOS) uses the classic pill, which
  // does hide during a drive and approximates glass with GlassView/BlurView.
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}

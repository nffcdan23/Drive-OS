import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Ionicons } from "@expo/vector-icons";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassSurface } from "@/components/Glass";
import { sectionAccent } from "@/constants/colors";
import { useApp } from "@/context/AppContext";

const destinations = [
  {
    name: "(drive)",
    title: "Drive",
    icon: "navigate-outline",
    symbol: "road.lanes",
    accent: sectionAccent.drive,
  },
  {
    name: "journeys",
    title: "Drives",
    icon: "time-outline",
    symbol: "clock",
    accent: sectionAccent.drives,
  },
  {
    name: "garage",
    title: "Garage",
    icon: "car-outline",
    symbol: "car",
    accent: sectionAccent.garage,
  },
  {
    name: "community",
    title: "Social",
    icon: "people-outline",
    symbol: "person.2",
    accent: sectionAccent.social,
  },
  {
    name: "profile",
    title: "Profile",
    icon: "person-outline",
    symbol: "person.crop.circle",
    accent: sectionAccent.profile,
  },
] as const;

// Selected-state SF Symbols for the native iOS tab bar.
const selectedSymbol: Record<string, SFSymbol> = {
  "(drive)": "road.lanes",
  journeys: "clock.fill",
  garage: "car.fill",
  community: "person.2.fill",
  profile: "person.crop.circle.fill",
};

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { isDriving } = useApp();

  // iOS: the system tab bar (a real UITabBarController). Built with the
  // iOS 26 SDK it is Liquid Glass; the system handles material, selection,
  // motion and Reduce Transparency. Screens already keep their own top and
  // bottom spacing, so automatic content insets are off.
  if (Platform.OS === "ios") {
    return (
      <NativeTabs hidden={isDriving} tintColor={sectionAccent.drive}>
        {destinations.map(({ name, title, symbol }) => (
          <NativeTabs.Trigger
            key={name}
            name={name}
            disableAutomaticContentInsets
          >
            <NativeTabs.Trigger.Label>{title}</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: symbol, selected: selectedSymbol[name] }}
            />
          </NativeTabs.Trigger>
        ))}
      </NativeTabs>
    );
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: isDriving
          ? { display: "none" }
          : {
              position: "absolute",
              bottom: Math.max(insets.bottom, 12),
              marginHorizontal: 12,
              height: 72,
              borderRadius: 32,
              paddingTop: 5,
              paddingBottom: 5,
              backgroundColor: "transparent",
              borderTopWidth: 0,
              elevation: 0,
            },
        tabBarBackground: () => (
          <GlassSurface
            style={[StyleSheet.absoluteFill, { borderRadius: 32 }]}
          />
        ),
        tabBarItemStyle: { borderRadius: 26 },
      }}
    >
      {destinations.map(({ name, title, icon, symbol, accent }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarAccessibilityLabel: title,
            tabBarIcon: ({ focused }) => (
              <View
                style={[
                  styles.item,
                  focused && {
                    backgroundColor: accent + "22",
                    borderColor: accent + "55",
                  },
                ]}
              >
                {Platform.OS === "ios" ? (
                  <SymbolView
                    name={symbol}
                    tintColor={focused ? accent : "#A9B3BE"}
                    style={{ width: 24, height: 24 }}
                  />
                ) : (
                  <Ionicons
                    name={icon}
                    size={23}
                    color={focused ? accent : "#A9B3BE"}
                  />
                )}
                <Text
                  maxFontSizeMultiplier={1.3}
                  numberOfLines={1}
                  style={[
                    styles.label,
                    {
                      color: focused ? accent : "#A9B3BE",
                      fontWeight: focused ? "600" : "400",
                    },
                  ]}
                >
                  {title}
                </Text>
              </View>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
const styles = StyleSheet.create({
  item: {
    minWidth: 52,
    height: 60,
    paddingHorizontal: 5,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  label: { fontSize: 10 },
});

import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";

export default function TabLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { isDriving } = useApp();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarStyle: isDriving
          ? { display: "none" }
          : {
              position: "absolute",
              bottom: 0,
              height: 70 + Math.max(insets.bottom, 12),
              paddingTop: 8,
              paddingBottom: Math.max(insets.bottom, 12),
              backgroundColor: colors.tabBarBg,
              borderTopColor: colors.border,
              borderTopWidth: 1,
              elevation: 0,
            },
        tabBarLabelStyle: {
          fontFamily: "Inter_600SemiBold",
          fontSize: 10,
          marginTop: 3,
        },
      }}
    >
      {(
        [
          ["index", "Map", "navigate-outline"],
          ["journeys", "Journeys", "git-merge-outline"],
          ["garage", "Garage", "car-sport-outline"],
          ["community", "Community", "people-outline"],
          ["profile", "Profile", "person-circle-outline"],
        ] as const
      ).map(([name, title, icon]) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={icon} size={focused ? 25 : 23} color={color} />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}

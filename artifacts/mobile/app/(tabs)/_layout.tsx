import { StyleSheet, View } from "react-native";
import { GlassSurface } from "@/components/Glass";
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
              bottom: Math.max(insets.bottom, 12),
              marginHorizontal: 8,
              borderRadius: 30,
              height: 72,
              paddingTop: 8,
              paddingBottom: 7,
              backgroundColor: "transparent",
              borderTopColor: colors.border,
              borderTopWidth: 0,
              shadowColor: "#000",
              shadowOpacity: 0.3,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 8 },
              elevation: 0,
            },
        tabBarBackground: () => (
          <GlassSurface
            style={[StyleSheet.absoluteFill, { borderRadius: 30 }]}
          />
        ),
        tabBarItemStyle: { borderRadius: 22, marginHorizontal: 0 },
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
              <View
                style={{
                  width: 48,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: focused
                    ? "rgba(196,130,53,0.18)"
                    : "transparent",
                }}
              >
                <Ionicons name={icon} size={23} color={color} />
              </View>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}

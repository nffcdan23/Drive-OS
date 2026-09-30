import React from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Image,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { ScreenTitle } from "@/components/Cockpit";
import { LoadingState } from "@/components/LoadingState";
import { EmptyState } from "@/components/EmptyState";
import { useApp } from "@/context/AppContext";
import colors, { sectionAccent } from "@/constants/colors";
import * as Haptics from "expo-haptics";

const c = colors.dark;
const accent = sectionAccent.garage;
export default function GarageScreen() {
  const { vehicles, activeVehicle, setActiveVehicle, isLoading } = useApp();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const router = useRouter();
  const add = () => router.push("/vehicle/new");
  return (
    <View style={s.page}>
      <View style={[s.header, { paddingTop: insets.top + 18 }]}>
        <ScreenTitle
          title="Garage"
          eyebrow="Your car, ready for the next drive."
        />
        <GlassButton
          style={s.add}
          onPress={add}
          accessibilityLabel="Add Vehicle"
        >
          <Ionicons name="add" size={28} color={c.foreground} />
        </GlassButton>
      </View>
      {isLoading && !vehicles.length ? (
        <LoadingState rows={3} />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: Math.max(insets.bottom, 12) + 100,
          }}
        >
          {activeVehicle ? (
            <GlassButton
              onPress={() => router.push(`/vehicle/${activeVehicle.id}`)}
              accessibilityLabel={`Open ${activeVehicle.nickname || activeVehicle.model}`}
              style={[
                s.hero,
                {
                  minHeight: Math.max(
                    420,
                    height - insets.top - Math.max(insets.bottom, 12) - 210,
                  ),
                  ...(vehicles.length > 1 ? { minHeight: 370 } : {}),
                },
              ]}
            >
              {activeVehicle.imageUri ? (
                <Image
                  source={{ uri: activeVehicle.imageUri }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                />
              ) : (
                <View style={s.placeholder}>
                  <Ionicons
                    name="car-sport-outline"
                    size={140}
                    color={c.mutedForeground}
                  />
                  <Text style={s.muted}>Add a photo in Vehicle Details</Text>
                </View>
              )}
              <LinearGradient
                pointerEvents="none"
                colors={["rgba(0,0,0,0.7)", "transparent", "rgba(0,0,0,0.8)"]}
                locations={[0, 0.45, 1]}
                style={StyleSheet.absoluteFill}
              />
              <View style={s.heroHeading}>
                <View style={s.row}>
                  <Ionicons name="star" size={16} color={accent} />
                  <Text style={s.primary}>Primary Car</Text>
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color="white"
                    style={{ marginLeft: "auto" }}
                  />
                </View>
                <Text style={s.name}>
                  {activeVehicle.nickname ||
                    `${activeVehicle.make} ${activeVehicle.model}`}
                </Text>
                <Text style={s.description}>
                  {activeVehicle.year} {activeVehicle.make}{" "}
                  {activeVehicle.model}
                </Text>
              </View>
              <GlassSurface material="dense" style={s.stats}>
                {(
                  [
                    [
                      "speedometer-outline",
                      activeVehicle.mileage.toLocaleString(),
                      "Total Miles",
                    ],
                    ["flash-outline", activeVehicle.power || "—", "Power"],
                    ["water-outline", activeVehicle.fuelType, "Fuel"],
                  ] as const
                ).map(([icon, value, label]) => (
                  <View key={label} style={s.stat}>
                    <Ionicons name={icon} size={23} color={c.foreground} />
                    <Text numberOfLines={1} style={s.value}>
                      {value}
                    </Text>
                    <Text style={s.muted}>{label}</Text>
                  </View>
                ))}
              </GlassSurface>
            </GlassButton>
          ) : (
            <EmptyState
              icon="car-outline"
              title="Your garage starts here"
              subtitle="Add your first vehicle to make it yours."
            >
              <GlassButton
                style={[s.select, { paddingHorizontal: 24, marginTop: 20 }]}
                onPress={add}
              >
                <Text style={s.description}>Add Vehicle</Text>
              </GlassButton>
            </EmptyState>
          )}
          {vehicles.length > 1 && (
            <>
              <View style={[s.row, { marginTop: 24, marginBottom: 12 }]}>
                <Text style={s.section}>My Vehicles</Text>
                <Text style={[s.muted, { marginLeft: "auto" }]}>
                  {vehicles.length} vehicles
                </Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 12 }}
              >
                {vehicles.map((v) => (
                  <GlassSurface
                    key={v.id}
                    style={[
                      s.vehicle,
                      v.id === activeVehicle?.id && { borderColor: accent },
                    ]}
                  >
                    <GlassButton
                      style={s.thumbnail}
                      onPress={() => router.push(`/vehicle/${v.id}`)}
                      accessibilityLabel={`Open ${v.nickname || v.model}`}
                    >
                      {v.imageUri ? (
                        <Image
                          source={{ uri: v.imageUri }}
                          style={StyleSheet.absoluteFill}
                          resizeMode="cover"
                        />
                      ) : (
                        <Ionicons
                          name="car-sport-outline"
                          size={42}
                          color={c.mutedForeground}
                        />
                      )}
                    </GlassButton>
                    <Text numberOfLines={1} style={s.smallName}>
                      {v.nickname || v.model}
                    </Text>
                    <Text style={s.muted}>
                      {v.year} {v.make}
                    </Text>
                    <GlassButton
                      style={s.select}
                      onPress={() => {
                        setActiveVehicle(v.id);
                        void Haptics.selectionAsync();
                      }}
                      accessibilityLabel={`Make ${v.nickname || v.model} your primary car`}
                      accessibilityState={{
                        selected: v.id === activeVehicle?.id,
                      }}
                    >
                      <Text
                        style={{
                          color:
                            v.id === activeVehicle?.id ? accent : c.foreground,
                          fontSize: 12,
                        }}
                      >
                        {v.id === activeVehicle?.id
                          ? "Primary Car"
                          : "Set Primary"}
                      </Text>
                    </GlassButton>
                  </GlassSurface>
                ))}
                <GlassButton style={[s.vehicle, s.addCard]} onPress={add}>
                  <Ionicons
                    name="add-circle-outline"
                    size={36}
                    color={c.foreground}
                  />
                  <Text style={s.description}>Add Vehicle</Text>
                </GlassButton>
              </ScrollView>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  add: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
  },
  hero: { borderRadius: 26, justifyContent: "space-between", padding: 18 },
  placeholder: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    backgroundColor: c.card,
  },
  heroHeading: { gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  primary: { color: accent, fontSize: 14, fontWeight: "600" },
  name: {
    color: "white",
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: -0.8,
  },
  description: { color: c.foreground, fontSize: 14 },
  stats: { borderRadius: 22, paddingVertical: 18, flexDirection: "row" },
  stat: { flex: 1, alignItems: "center", gap: 6, paddingHorizontal: 4 },
  value: {
    color: c.foreground,
    fontSize: 17,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  muted: { color: c.mutedForeground, fontSize: 12 },
  section: { color: c.foreground, fontSize: 20, fontWeight: "600" },
  vehicle: { width: 160, padding: 10, borderRadius: 18, gap: 6 },
  thumbnail: {
    height: 100,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  smallName: { color: c.foreground, fontWeight: "600", fontSize: 14 },
  select: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    marginTop: 4,
  },
  addCard: { alignItems: "center", justifyContent: "center", gap: 12 },
});

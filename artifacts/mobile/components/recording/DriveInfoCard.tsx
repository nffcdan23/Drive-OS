import React, { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { GlassSurface } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import { CONFIG } from "@/constants/config";
import { rec } from "./shared";

function startedAt(startTime: number) {
  try {
    return new Date(startTime).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

/**
 * What this drive is: the vehicle it is being recorded against and when it
 * started. Drives have no name or destination until they are saved, so none
 * is shown here. Weather appears only in demo builds, like the Drive screen.
 */
function DriveInfoCard({
  vehicleName,
  vehicleImageUri,
  startTime,
  isPassengerMode,
}: {
  vehicleName: string | null;
  vehicleImageUri: string | null;
  startTime: number | null;
  isPassengerMode: boolean;
}) {
  const time = startTime != null ? startedAt(startTime) : null;
  const title = vehicleName ?? "Drive in progress";
  const subtitle = isPassengerMode
    ? "Passenger Mode · not recording"
    : time
      ? `Started ${time}`
      : "Recording your route";

  return (
    <GlassSurface
      accessible
      accessibilityLabel={`${title}. ${subtitle}`}
      style={styles.card}
    >
      <View style={styles.thumb}>
        {vehicleImageUri ? (
          <Image
            source={{ uri: vehicleImageUri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
          />
        ) : (
          <Glyph
            sf={vehicleName ? "car.fill" : "road.lanes"}
            ion={vehicleName ? "car-sport" : "navigate"}
            size={22}
            color={rec.cyan}
          />
        )}
      </View>
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.title} maxFontSizeMultiplier={1.2}>
          {title}
        </Text>
        <Text
          numberOfLines={1}
          style={styles.subtitle}
          maxFontSizeMultiplier={1.2}
        >
          {subtitle}
        </Text>
      </View>
      {CONFIG.DEMO_MODE && (
        <View
          style={styles.weather}
          accessibilityLabel={`Demo weather: ${CONFIG.DEMO_WEATHER.temperature} degrees, ${CONFIG.DEMO_WEATHER.condition}`}
        >
          <Glyph sf="cloud.fill" ion="cloud" size={24} color="#EEF2F6" />
          <View>
            <Text style={styles.temp} maxFontSizeMultiplier={1.2}>
              {CONFIG.DEMO_WEATHER.temperature}°C
            </Text>
            <Text
              numberOfLines={1}
              style={styles.condition}
              maxFontSizeMultiplier={1.2}
            >
              {CONFIG.DEMO_WEATHER.condition}
            </Text>
          </View>
        </View>
      )}
    </GlassSurface>
  );
}

export default memo(DriveInfoCard);

const styles = StyleSheet.create({
  card: {
    height: 64,
    borderRadius: 20,
    paddingLeft: 8,
    paddingRight: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 13,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,207,232,0.12)",
  },
  text: { flex: 1, minWidth: 0 },
  title: { color: rec.text, fontSize: 16, fontWeight: "600" },
  subtitle: { color: rec.textMuted, fontSize: 13, marginTop: 2 },
  weather: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: rec.hairline,
    height: 40,
    maxWidth: 130,
  },
  temp: { color: rec.text, fontSize: 15, fontWeight: "600" },
  condition: { color: rec.textMuted, fontSize: 11.5, marginTop: 1 },
});

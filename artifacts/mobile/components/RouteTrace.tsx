import React, { useMemo } from "react";
import { View, Text } from "react-native";
import Svg, { Polyline, Circle, Path } from "react-native-svg";
import colors from "@/constants/colors";
export function RouteTrace({
  coordinates,
}: {
  coordinates: { latitude: number; longitude: number }[];
}) {
  const points = useMemo(() => {
    const valid = coordinates.filter(
      (p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude),
    );
    if (valid.length < 2) return [];
    const step = Math.max(1, Math.ceil(valid.length / 200));
    const sampled = valid.filter(
      (_, i) => i % step === 0 || i === valid.length - 1,
    );
    const lat = sampled.map((p) => p.latitude),
      lon = sampled.map((p) => p.longitude);
    const minLat = Math.min(...lat),
      maxLat = Math.max(...lat),
      minLon = Math.min(...lon),
      maxLon = Math.max(...lon);
    const correction = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const width = (maxLon - minLon) * correction,
      height = maxLat - minLat;
    const scale = Math.min(
      272 / Math.max(width, 0.00001),
      80 / Math.max(height, 0.00001),
    );
    return sampled.map((p) => ({
      x: 160 + ((p.longitude - minLon) * correction - width / 2) * scale,
      y: 56 - (p.latitude - minLat - height / 2) * scale,
    }));
  }, [coordinates]);
  return (
    <View
      style={{
        height: 112,
        backgroundColor: "#10161C",
        borderRadius: 12,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      {points.length > 1 ? (
        <Svg
          width="100%"
          height={112}
          viewBox="0 0 320 112"
          accessibilityLabel="Recorded route trace"
        >
          <Path
            d="M0 28H320 M0 56H320 M0 84H320 M80 0V112 M160 0V112 M240 0V112"
            stroke="#202831"
            strokeWidth={1}
          />
          <Polyline
            points={points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={colors.dark.primary}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <Circle cx={points[0].x} cy={points[0].y} r={4} fill="#F3F5F7" />
          <Circle
            cx={points[points.length - 1].x}
            cy={points[points.length - 1].y}
            r={5}
            fill={colors.dark.primary}
          />
        </Svg>
      ) : (
        <Text
          style={{
            color: colors.dark.mutedForeground,
            padding: 24,
            fontFamily: "Inter_400Regular",
          }}
        >
          No route trace recorded
        </Text>
      )}
    </View>
  );
}

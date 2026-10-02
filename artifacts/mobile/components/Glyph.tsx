import React from "react";
import { Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SymbolView, type SFSymbol } from "expo-symbols";

/** SF Symbols on iOS, Ionicons elsewhere. */
export function Glyph({
  sf,
  ion,
  size,
  color,
}: {
  sf: SFSymbol;
  ion: React.ComponentProps<typeof Ionicons>["name"];
  size: number;
  color: string;
}) {
  if (Platform.OS !== "ios")
    return <Ionicons name={ion} size={size} color={color} />;
  return (
    <SymbolView
      name={sf}
      tintColor={color}
      style={{ width: size, height: size }}
      fallback={<Ionicons name={ion} size={size} color={color} />}
    />
  );
}

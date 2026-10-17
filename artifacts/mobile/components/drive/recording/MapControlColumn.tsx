// The recording screen's map buttons, down the right: map style, recenter
// (lit while the camera follows the car), and "…" for Pause/Resume and zoom.
// Each menu opens beside the column and closes on a choice or a second tap.
import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";

const TEXT = "#F3F5F7";
const ACTIVE = "#3FD6F5";

export interface MapLayerOption<T extends string> {
  type: T;
  label: string;
  icon: string;
}

interface Props<T extends string> {
  followMode: "following" | "free";
  mapType: T;
  mapLayers: ReadonlyArray<MapLayerOption<T>>;
  onSelectMapType: (type: T) => void;
  onLocateButton: () => void;
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

type Menu = "layers" | "more" | null;

export default function MapControlColumn<T extends string>({
  followMode,
  mapType,
  mapLayers,
  onSelectMapType,
  onLocateButton,
  isPaused,
  onPause,
  onResume,
  onZoomIn,
  onZoomOut,
}: Props<T>) {
  const [menu, setMenu] = useState<Menu>(null);
  const toggle = (m: Exclude<Menu, null>) => {
    Haptics.selectionAsync();
    setMenu((cur) => (cur === m ? null : m));
  };
  const following = followMode === "following";

  return (
    <View style={styles.column} pointerEvents="box-none">
      <GlassButton
        accessibilityRole="button"
        accessibilityLabel="Map style"
        accessibilityState={{ expanded: menu === "layers" }}
        style={styles.button}
        onPress={() => toggle("layers")}
      >
        <Glyph sf="square.3.layers.3d" ion="layers-outline" size={21} color={menu === "layers" ? ACTIVE : TEXT} />
      </GlassButton>
      <GlassButton
        accessibilityRole="button"
        accessibilityLabel={following ? "Following your position" : "Recenter on your position"}
        accessibilityState={{ selected: following }}
        style={styles.button}
        onPress={() => {
          setMenu(null);
          onLocateButton();
        }}
      >
        <Glyph
          sf={following ? "location.fill" : "location"}
          ion={following ? "navigate" : "navigate-outline"}
          size={20}
          color={following ? ACTIVE : TEXT}
        />
      </GlassButton>
      <GlassButton
        accessibilityRole="button"
        accessibilityLabel="More drive controls"
        accessibilityState={{ expanded: menu === "more" }}
        style={styles.button}
        onPress={() => toggle("more")}
      >
        <Glyph sf="ellipsis" ion="ellipsis-horizontal" size={20} color={menu === "more" ? ACTIVE : TEXT} />
      </GlassButton>

      {menu === "layers" && (
        <GlassSurface material="dense" style={[styles.menu, { top: 0 }]}>
          {mapLayers.map((layer) => {
            const selected = layer.type === mapType;
            return (
              <TouchableOpacity
                key={layer.type}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={styles.row}
                onPress={() => {
                  Haptics.selectionAsync();
                  onSelectMapType(layer.type);
                  setMenu(null);
                }}
              >
                <Ionicons name={layer.icon as any} size={18} color={selected ? ACTIVE : TEXT} />
                <Text style={[styles.rowText, selected && { color: ACTIVE }]}>{layer.label}</Text>
                {selected ? <Ionicons name="checkmark" size={16} color={ACTIVE} /> : null}
              </TouchableOpacity>
            );
          })}
        </GlassSurface>
      )}

      {menu === "more" && (
        <GlassSurface material="dense" style={[styles.menu, { bottom: 0 }]}>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.row}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              if (isPaused) onResume();
              else onPause();
              setMenu(null);
            }}
          >
            <Ionicons name={isPaused ? "play" : "pause"} size={18} color={isPaused ? "#34D399" : TEXT} />
            <Text style={styles.rowText}>{isPaused ? "Resume drive" : "Pause drive"}</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity accessibilityRole="button" style={styles.row} onPress={onZoomIn}>
            <Ionicons name="add" size={19} color={TEXT} />
            <Text style={styles.rowText}>Zoom in</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" style={styles.row} onPress={onZoomOut}>
            <Ionicons name="remove" size={19} color={TEXT} />
            <Text style={styles.rowText}>Zoom out</Text>
          </TouchableOpacity>
        </GlassSurface>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { gap: 10, alignItems: "flex-end" },
  button: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  menu: {
    position: "absolute",
    right: 56,
    minWidth: 176,
    borderRadius: 16,
    paddingVertical: 6,
  },
  row: {
    minHeight: 44,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  rowText: { flex: 1, color: TEXT, fontSize: 15, fontWeight: "500" },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: "rgba(214,224,234,0.18)", marginHorizontal: 14 },
});

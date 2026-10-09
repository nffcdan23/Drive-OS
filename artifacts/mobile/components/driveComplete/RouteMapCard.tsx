// The completed route in a rounded card, with a full-screen view.  On Mapbox
// (lib/mapProvider.ts) it's the real map; without it (Expo Go, web, a build
// without Mapbox) the same recorded points are traced on a plain dark card,
// never a picture of a map.

import React, { useMemo, useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import { GlassButton } from "@/components/Glass";
import { Glyph } from "@/components/Glyph";
import type { Coordinate } from "@/context/AppContext";
import { DRIVE_MAPBOX } from "@/lib/mapProvider";
import { FinishMarker, StartMarker, ROUTE_COLOR, ROUTE_GLOW } from "./routeMarkers";

const RouteMapMapbox: typeof import("./RouteMapMapbox").default | null =
  DRIVE_MAPBOX ? require("./RouteMapMapbox").default : null;

/** The recorded points traced to fit a box (no map behind them). */
function RouteTrace({ coordinates, width, height }: { coordinates: Coordinate[]; width: number; height: number }) {
  const geo = useMemo(() => {
    if (coordinates.length < 2 || width <= 0) return null;
    const pad = 28;
    const lats = coordinates.map((c) => c.latitude);
    const lngs = coordinates.map((c) => c.longitude);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    // Longitude degrees shrink towards the poles; scale them to match latitude.
    const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const spanX = Math.max((maxLng - minLng) * k, 1e-6);
    const spanY = Math.max(maxLat - minLat, 1e-6);
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const offX = (width - spanX * scale) / 2;
    const offY = (height - spanY * scale) / 2;
    const x = (c: Coordinate) => offX + (c.longitude - minLng) * k * scale;
    const y = (c: Coordinate) => height - offY - (c.latitude - minLat) * scale;
    const d = coordinates.map((c, i) => `${i ? "L" : "M"}${x(c).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
    const first = coordinates[0]!, last = coordinates[coordinates.length - 1]!;
    return { d, start: { x: x(first), y: y(first) }, end: { x: x(last), y: y(last) } };
  }, [coordinates, width, height]);
  if (!geo) return null;
  return (
    <>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Path d={geo.d} stroke={ROUTE_GLOW} strokeWidth={12} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <Path d={geo.d} stroke={ROUTE_COLOR} strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
      <View style={[styles.pin, { left: geo.start.x - 11, top: geo.start.y - 11 }]}>
        <StartMarker />
      </View>
      <View style={[styles.pin, { left: geo.end.x - 15, top: geo.end.y - 15 }]}>
        <FinishMarker />
      </View>
    </>
  );
}

function RouteMap({ coordinates, interactive, padding }: { coordinates: Coordinate[]; interactive: boolean; padding: number }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) =>
    setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  if (RouteMapMapbox && DRIVE_MAPBOX) {
    return <RouteMapMapbox coordinates={coordinates} settings={DRIVE_MAPBOX} interactive={interactive} padding={padding} />;
  }
  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout}>
      <RouteTrace coordinates={coordinates} width={size.width} height={size.height} />
    </View>
  );
}

export default function RouteMapCard({ coordinates }: { coordinates: Coordinate[] }) {
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const hasRoute = coordinates.length > 1;

  return (
    <View style={styles.card}>
      {hasRoute ? (
        <>
          <RouteMap coordinates={coordinates} interactive={false} padding={36} />
          <GlassButton
            accessibilityLabel="Show the route full screen"
            onPress={() => setExpanded(true)}
            style={styles.expand}
          >
            <Glyph sf="arrow.up.left.and.arrow.down.right" ion="expand-outline" size={18} color="#FFFFFF" />
          </GlassButton>
        </>
      ) : (
        <View style={styles.empty}>
          <Ionicons name="map-outline" size={28} color="rgba(226,232,238,0.6)" />
          <Text style={styles.emptyText}>No route was recorded for this drive.</Text>
        </View>
      )}

      <Modal
        visible={expanded}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => setExpanded(false)}
      >
        <View style={styles.full}>
          {expanded && <RouteMap coordinates={coordinates} interactive padding={64} />}
          <GlassButton
            accessibilityLabel="Close full-screen route"
            onPress={() => setExpanded(false)}
            style={[styles.closeFull, { top: insets.top + 8 }]}
          >
            <Glyph sf="xmark" ion="close" size={20} color="#FFFFFF" />
          </GlassButton>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    height: 190,
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: "#0F1820",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(220,232,244,0.22)",
  },
  pin: { position: "absolute" },
  expand: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  emptyText: { color: "rgba(226,232,238,0.7)", fontSize: 14 },
  full: { flex: 1, backgroundColor: "#0B0F14" },
  closeFull: {
    position: "absolute",
    left: 16,
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
});

// The completed drive on the Derwent Mapbox style: the recorded route as the
// Drive map's cyan trail (glow + line), fitted to the camera, with start and
// finish markers.  Loaded only when lib/mapProvider.ts selects Mapbox, so a
// binary without the Mapbox native module never imports @rnmapbox/maps.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Mapbox, {
  Camera,
  LineLayer,
  MapView,
  MarkerView,
  ShapeSource,
} from "@rnmapbox/maps";
import type { Coordinate } from "@/context/AppContext";
import {
  displayTrail,
  routeBounds,
  trailFeatureCollection,
  type MapboxSettings,
} from "@/lib/mapbox";
import { FinishMarker, StartMarker, ROUTE_COLOR, ROUTE_GLOW } from "./routeMarkers";

let tokenSet: string | null = null;

export default function RouteMapMapbox({
  coordinates,
  settings,
  interactive,
  padding,
}: {
  coordinates: Coordinate[];
  settings: MapboxSettings;
  interactive: boolean;
  padding: number;
}) {
  if (tokenSet !== settings.token) {
    tokenSet = settings.token;
    void Mapbox.setAccessToken(settings.token);
  }
  const shape = useMemo(
    () => trailFeatureCollection(displayTrail(coordinates)),
    [coordinates],
  );
  const bounds = useMemo(() => routeBounds(coordinates), [coordinates]);
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={interactive ? "auto" : "none"}>
      <MapView
        style={StyleSheet.absoluteFill}
        styleURL={settings.styleUrl}
        compassEnabled={false}
        scaleBarEnabled={false}
        logoPosition={{ bottom: 6, left: 8 }}
        attributionPosition={{ bottom: 6, right: 8 }}
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        rotateEnabled={interactive}
        pitchEnabled={false}
      >
        {bounds && (
          <Camera
            defaultSettings={{
              bounds,
              padding: {
                paddingTop: padding,
                paddingBottom: padding,
                paddingLeft: padding,
                paddingRight: padding,
              },
              animationDuration: 0,
            }}
          />
        )}
        <ShapeSource id="derwent-completed-route" shape={shape}>
          <LineLayer
            id="derwent-completed-route-glow"
            style={{
              lineColor: ROUTE_GLOW,
              lineWidth: 12,
              lineCap: "round",
              lineJoin: "round",
              lineEmissiveStrength: 1,
            }}
          />
          <LineLayer
            id="derwent-completed-route-line"
            style={{
              lineColor: ROUTE_COLOR,
              lineWidth: 4,
              lineCap: "round",
              lineJoin: "round",
              lineEmissiveStrength: 1,
            }}
          />
        </ShapeSource>
        {start && (
          <MarkerView coordinate={[start.longitude, start.latitude]} allowOverlap>
            <StartMarker />
          </MarkerView>
        )}
        {end && coordinates.length > 1 && (
          <MarkerView coordinate={[end.longitude, end.latitude]} allowOverlap>
            <FinishMarker />
          </MarkerView>
        )}
      </MapView>
    </View>
  );
}

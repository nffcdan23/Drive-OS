// The Drive screen's map on Mapbox: the published Derwent style, the follow
// camera written by the Drive screen's frame loop, Mapbox's own location
// puck (fed Derwent's smoothed position and heading), and the recorded drive
// trail as line layers.
//
// Loaded only when lib/mapProvider.ts selects Mapbox, so a binary without the
// Mapbox native module never imports @rnmapbox/maps.

import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Mapbox, {
  Camera,
  CustomLocationProvider,
  Images,
  LineLayer,
  LocationPuck,
  MapView,
  ShapeSource,
  type MapState,
} from "@rnmapbox/maps";
import type {
  FollowCameraPose,
  LatLng,
  ReportedPose,
} from "@/lib/locationSmoothing";
import {
  clampMapboxZoom,
  mapboxFollowCamera,
  reportedPoseFromMapbox,
  trailFeatureCollection,
} from "@/lib/mapbox";

export interface MapboxDriveMapHandle {
  /** Writes the follow camera at once (the motion comes from the frame loop) */
  setFollowCamera(pose: FollowCameraPose): void;
  /** The camera Mapbox last reported, to ease follow mode in from */
  getCamera(): Promise<ReportedPose>;
  /** The map's current zoom */
  getZoom(): Promise<number>;
  /** Animates to a zoom the user picked (outside follow mode) */
  easeToZoom(zoom: number): void;
  /** Moves the location puck to the smoothed position and heading */
  setPuck(position: LatLng, heading: number): void;
}

export interface MapboxDriveMapProps {
  accessToken: string;
  styleURL: string;
  initialCenter: LatLng;
  /** Shows the location puck (once there is a position) */
  showPuck: boolean;
  /** The recorded drive, drawn as the cyan trail; null when not driving */
  trail: readonly LatLng[] | null;
  trailColor: string;
  /** Logo and attribution sit this far above the bottom edge */
  ornamentBottom: number;
  ornamentLeft: number;
  /** The user moved the map with a gesture (pan, pinch, rotate or tilt) */
  onUserGesture: () => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  style?: StyleProp<ViewStyle>;
}

const PUCK_IMAGES = {
  "derwent-puck": require("@/assets/images/map/puck-arrow.png"),
  "derwent-puck-shadow": require("@/assets/images/map/puck-shadow.png"),
};

// The recorded drive: a soft glow under the cyan line, as on the old map
const TRAIL_GLOW = "rgba(0,207,232,0.28)";

let tokenSet: string | null = null;
function useAccessToken(token: string) {
  if (tokenSet !== token) {
    tokenSet = token;
    void Mapbox.setAccessToken(token);
  }
}

/**
 * Feeds the puck.  Its own small component, so moving the puck every frame
 * re-renders only this and never the map or its layers.
 */
interface PuckFeederHandle {
  set(position: LatLng, heading: number): void;
}
type PuckState = { position: LatLng; heading: number };
const toState = (p: PuckState) => ({
  coordinate: [p.position.longitude, p.position.latitude] as [number, number],
  heading: p.heading,
});
const PuckFeeder = memo(
  forwardRef<
    PuckFeederHandle,
    { latest: React.RefObject<PuckState | null>; fallback: LatLng }
  >(function PuckFeeder({ latest, fallback }, ref) {
    const [puck, setPuckState] = useState(() =>
      toState(latest.current ?? { position: fallback, heading: 0 }),
    );
    const set = useCallback((position: LatLng, heading: number) => {
      setPuckState((prev) =>
        prev.coordinate[0] === position.longitude &&
        prev.coordinate[1] === position.latitude &&
        prev.heading === heading
          ? prev
          : toState({ position, heading }),
      );
    }, []);
    useImperativeHandle(ref, () => ({ set }), [set]);
    // A position pushed between this render and mounting is picked up here
    useEffect(() => {
      if (latest.current) set(latest.current.position, latest.current.heading);
    }, [latest, set]);
    return (
      <CustomLocationProvider
        coordinate={puck.coordinate}
        heading={puck.heading}
      />
    );
  }),
);

const MapboxDriveMap = forwardRef<MapboxDriveMapHandle, MapboxDriveMapProps>(
  function MapboxDriveMap(
    {
      accessToken,
      styleURL,
      initialCenter,
      showPuck,
      trail,
      trailColor,
      ornamentBottom,
      ornamentLeft,
      onUserGesture,
      onTouchStart,
      onTouchEnd,
      style,
    },
    ref,
  ) {
    useAccessToken(accessToken);
    const mapRef = useRef<MapView>(null);
    const cameraRef = useRef<Camera>(null);
    const puckRef = useRef<PuckFeederHandle>(null);
    const lastCameraRef = useRef<ReportedPose | null>(null);
    const lastPuckRef = useRef<PuckState | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        setFollowCamera(pose) {
          cameraRef.current?.setCamera(mapboxFollowCamera(pose));
        },
        getCamera() {
          const cam = lastCameraRef.current;
          return cam ? Promise.resolve(cam) : Promise.reject(new Error("no camera yet"));
        },
        getZoom() {
          return mapRef.current
            ? mapRef.current.getZoom()
            : Promise.reject(new Error("no map"));
        },
        easeToZoom(zoom) {
          cameraRef.current?.setCamera({
            zoomLevel: clampMapboxZoom(zoom),
            animationDuration: 200,
            animationMode: "easeTo",
          });
        },
        setPuck(position, heading) {
          lastPuckRef.current = { position, heading };
          puckRef.current?.set(position, heading);
        },
      }),
      [],
    );

    // Mapbox says whether a gesture moved the camera, so the app's own
    // camera writes (every frame while following) are never mistaken for the
    // user's.  The reported camera is kept only as the place to ease from
    // when follow mode is next entered; it is never fed back while following.
    const handleCameraChanged = useCallback(
      (state: MapState) => {
        lastCameraRef.current = reportedPoseFromMapbox(state.properties);
        if (state.gestures?.isGestureActive) onUserGesture();
      },
      [onUserGesture],
    );

    const trailShape = useMemo(() => trailFeatureCollection(trail), [trail]);

    const initialCamera = useMemo(
      () => ({
        centerCoordinate: [initialCenter.longitude, initialCenter.latitude] as [
          number,
          number,
        ],
        zoomLevel: 15,
      }),
      // The starting view only; the frame loop moves the camera from here
      [],
    );

    return (
      <View
        style={style}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          styleURL={styleURL}
          compassEnabled={false}
          scaleBarEnabled={false}
          logoPosition={{ bottom: ornamentBottom, left: ornamentLeft }}
          attributionPosition={{ bottom: ornamentBottom, right: 8 }}
          rotateEnabled
          scrollEnabled
          zoomEnabled
          pitchEnabled
          onCameraChanged={handleCameraChanged}
        >
          <Camera ref={cameraRef} defaultSettings={initialCamera} />
          <Images images={PUCK_IMAGES} />
          {/* Mounted before the puck so the trail always draws beneath it */}
          <ShapeSource id="derwent-drive-trail" shape={trailShape}>
            <LineLayer
              id="derwent-drive-trail-glow"
              style={{
                lineColor: TRAIL_GLOW,
                lineWidth: 12,
                lineCap: "round",
                lineJoin: "round",
                lineEmissiveStrength: 1,
              }}
            />
            <LineLayer
              id="derwent-drive-trail-line"
              style={{
                lineColor: trailColor,
                lineWidth: 4,
                lineCap: "round",
                lineJoin: "round",
                lineEmissiveStrength: 1,
              }}
            />
          </ShapeSource>
          {showPuck && (
            <PuckFeeder
              ref={puckRef}
              latest={lastPuckRef}
              fallback={initialCenter}
            />
          )}
          {showPuck && (
            // Keyed on the style so a style change re-adds it above the trail
            <LocationPuck
              key={styleURL}
              topImage="derwent-puck"
              shadowImage="derwent-puck-shadow"
              puckBearing="heading"
              puckBearingEnabled
              pulsing={{ isEnabled: false }}
            />
          )}
        </MapView>
      </View>
    );
  },
);

export default MapboxDriveMap;

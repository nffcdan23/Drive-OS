// The Drive screen's map on Mapbox: the published Derwent style, the follow
// camera written by the Drive screen's frame loop, Derwent's location arrow
// (the same one the Apple map draws) at the smoothed position, and the
// recorded drive trail as line layers, continued to the arrow by the live
// trail head (lib/liveTrail.ts) drawn from the same smoothed position.
//
// The arrow is a view annotation (MarkerView), not Mapbox's location puck.
// The puck re-animates every update it's given, heading over 0.3 s and
// position over 1.1 s (LocationManager's ValueInterpolators in the Mapbox iOS
// SDK); fed a new value every frame, that made it a lag filter on top of
// Derwent's own smoothing, so it turned visibly behind the map and sat behind
// where the camera and trail put the user.  The arrow is turned by the Drive
// screen from the heading and the camera bearing it writes in the same frame,
// so in heading-up follow it stays still on screen as the map turns.
//
// Loaded only when lib/mapProvider.ts selects Mapbox, so a binary without the
// Mapbox native module never imports @rnmapbox/maps.

import React, {
  type ReactElement,
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
  LineLayer,
  MapView,
  MarkerView,
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
  /** Moves the location arrow to the smoothed position */
  setMarker(position: LatLng): void;
}

/** Hands the map a function that draws the live trail head (null: none) */
export type TrailHeadSubscribe = (
  draw: (head: LatLng[] | null) => void,
) => () => void;

export interface MapboxDriveMapProps {
  accessToken: string;
  styleURL: string;
  initialCenter: LatLng;
  /** Shows the location arrow (once there is a position) */
  showMarker: boolean;
  /** The location arrow; the Drive screen turns and tilts it */
  marker: ReactElement;
  /** The recorded drive, drawn as the cyan trail; null when not driving */
  trail: readonly LatLng[] | null;
  trailColor: string;
  /**
   * The trail's live end, from its last recorded point to the puck: drawn
   * whenever the Drive screen's frame loop says, without re-rendering the map
   */
  trailHead?: TrailHeadSubscribe;
  /**
   * Friends' live positions (FriendMarkersMapbox): drawn beneath the user's
   * own arrow, and never touching the camera
   */
  friendLayer?: ReactElement | null;
  /** Logo and attribution sit this far above the bottom edge */
  ornamentBottom: number;
  ornamentLeft: number;
  /** The user moved the map with a gesture (pan, pinch, rotate or tilt) */
  onUserGesture: () => void;
  /** The camera changed, for any reason (the arrow turns against it) */
  onCameraChange?: () => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  style?: StyleProp<ViewStyle>;
}

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
 * Places the location arrow.  Its own small component, so moving it every
 * frame re-renders only this and never the map or its layers.  Mapbox moves a
 * view annotation with the map in the same frame it draws the map; the arrow
 * is turned (and tilted) by the Drive screen.
 */
interface MarkerFeederHandle {
  set(position: LatLng): void;
}
const toLngLat = (p: LatLng): [number, number] => [p.longitude, p.latitude];
const MarkerFeeder = memo(
  forwardRef<
    MarkerFeederHandle,
    {
      latest: React.RefObject<LatLng | null>;
      fallback: LatLng;
      children: ReactElement;
    }
  >(function MarkerFeeder({ latest, fallback, children }, ref) {
    const [coordinate, setCoordinate] = useState(() =>
      toLngLat(latest.current ?? fallback),
    );
    const set = useCallback((position: LatLng) => {
      setCoordinate((prev) =>
        prev[0] === position.longitude && prev[1] === position.latitude
          ? prev
          : toLngLat(position),
      );
    }, []);
    useImperativeHandle(ref, () => ({ set }), [set]);
    // A position pushed between this render and mounting is picked up here
    useEffect(() => {
      if (latest.current) set(latest.current);
    }, [latest, set]);
    return (
      <MarkerView
        coordinate={coordinate}
        anchor={{ x: 0.5, y: 0.5 }}
        allowOverlap
      >
        {children}
      </MarkerView>
    );
  }),
);

/**
 * The live trail head.  Its own small component with its own state, so a
 * redraw (many times a second while driving) re-renders only this source and
 * replaces its few points, never the recorded trail or the map.  Always
 * mounted, empty when there's no head, so its layers keep their place in the
 * stack.  Styled to match the recorded trail it continues.
 */
const TrailHeadLayers = memo(function TrailHeadLayers({
  subscribe,
  color,
}: {
  subscribe: TrailHeadSubscribe;
  color: string;
}) {
  const [head, setHead] = useState<LatLng[] | null>(null);
  useEffect(() => subscribe(setHead), [subscribe]);
  const shape = useMemo(() => trailFeatureCollection(head), [head]);
  return (
    <ShapeSource id="derwent-drive-trail-head" shape={shape}>
      <LineLayer
        id="derwent-drive-trail-head-glow"
        style={{
          lineColor: TRAIL_GLOW,
          lineWidth: 12,
          lineCap: "round",
          lineJoin: "round",
          lineEmissiveStrength: 1,
        }}
      />
      <LineLayer
        id="derwent-drive-trail-head-line"
        style={{
          lineColor: color,
          lineWidth: 4,
          lineCap: "round",
          lineJoin: "round",
          lineEmissiveStrength: 1,
        }}
      />
    </ShapeSource>
  );
});

const MapboxDriveMap = forwardRef<MapboxDriveMapHandle, MapboxDriveMapProps>(
  function MapboxDriveMap(
    {
      accessToken,
      styleURL,
      initialCenter,
      showMarker,
      marker,
      trail,
      trailColor,
      trailHead,
      friendLayer,
      ornamentBottom,
      ornamentLeft,
      onUserGesture,
      onCameraChange,
      onTouchStart,
      onTouchEnd,
      style,
    },
    ref,
  ) {
    useAccessToken(accessToken);
    const mapRef = useRef<MapView>(null);
    const cameraRef = useRef<Camera>(null);
    const markerRef = useRef<MarkerFeederHandle>(null);
    const lastCameraRef = useRef<ReportedPose | null>(null);
    const lastMarkerRef = useRef<LatLng | null>(null);

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
        setMarker(position) {
          lastMarkerRef.current = position;
          markerRef.current?.set(position);
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
        onCameraChange?.();
      },
      [onUserGesture, onCameraChange],
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
          {/* Mounted before the trail: the head draws beneath it (and the
              arrow, a view annotation, sits above every layer) */}
          {trailHead && (
            <TrailHeadLayers subscribe={trailHead} color={trailColor} />
          )}
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
          {friendLayer}
          {showMarker && (
            <MarkerFeeder
              ref={markerRef}
              latest={lastMarkerRef}
              fallback={initialCenter}
            >
              {marker}
            </MarkerFeeder>
          )}
        </MapView>
      </View>
    );
  },
);

export default MapboxDriveMap;

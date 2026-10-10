// The Drive screen's map on Mapbox: the published Derwent style, the follow
// camera written by the Drive screen's frame loop, Derwent's location arrow
// at the smoothed position and heading, and the recorded drive trail as line
// layers, continued to the arrow by the live trail head (lib/liveTrail.ts)
// drawn from the same smoothed position.
//
// The arrow is a symbol layer lying flat on the map (LOCATION_ARROW_SYMBOL in
// lib/mapbox.ts): the Derwent arrow artwork, pitched and turned with the map,
// so it sits on the road at any tilt.  It is not a view annotation: those are
// screen-upright views, which is why the arrow used to look stood up on the
// tilted map.  Nor is it Mapbox's location puck, for two reasons:
//  - the puck re-animates every update it's given, heading over 0.3 s and
//    position over 1.1 s (LocationManager's ValueInterpolators in the Mapbox
//    iOS SDK); fed a new value every frame, that made it a lag filter on top
//    of Derwent's own smoothing;
//  - until its custom image has been fetched the puck draws Mapbox's default
//    blue puck (RNMBXNativeUserLocation: no images → Puck2DConfiguration
//    .makeDefault), on first mount and after a style change.
// Nothing on this map turns on Mapbox's location component (no LocationPuck,
// UserLocation or followUserLocation), so the blue puck can never show.
//
// The follow camera is written as the Camera's own props (its `stop`), not
// with Camera.setCamera(): setCamera is a promise-returning native command
// run on the main thread, and one a frame queued up faster than the main
// thread resolved them (the watchdog kills and multi-gigabyte memory in the
// device logs).  Props go through React Native's renderer, which hands the
// map only the newest value however many were set; on top of that the
// LatestPoseWriter (lib/cameraWriter.ts) keeps at most one write in flight,
// replaces a waiting pose with the newest, skips unchanged poses, caps the
// rate, and writes nothing while the app isn't on screen.
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Mapbox, {
  Camera,
  CircleLayer,
  Images,
  LineLayer,
  MapView,
  ShapeSource,
  SymbolLayer,
  type MapState,
} from "@rnmapbox/maps";
import type {
  FollowCameraPose,
  LatLng,
  ReportedPose,
} from "@/lib/locationSmoothing";
import {
  clampMapboxZoom,
  displayTrail,
  LOCATION_ARROW_SYMBOL,
  locationArrowFeature,
  mapboxFollowCamera,
  reportedPoseFromMapbox,
  trailFeatureCollection,
} from "@/lib/mapbox";
import { LatestPoseWriter, sameFollowPose } from "@/lib/cameraWriter";
import type { RoutePreviewStore } from "@/lib/navigation/previewStore";
import type { NavigationSession } from "@/lib/navigation/session";
import { useOnScreenSnapshot } from "@/hooks/useOnScreenSnapshot";
import {
  ROUTE_COLORS,
  routePreviewFeatures,
  tappedRouteIndex,
} from "@/lib/navigation/routeLayers";

export interface MapboxDriveMapHandle {
  /** Writes the follow camera at once (the motion comes from the frame loop) */
  setFollowCamera(pose: FollowCameraPose): void;
  /** The camera Mapbox last reported, to ease follow mode in from */
  getCamera(): Promise<ReportedPose>;
  /** The map's current zoom */
  getZoom(): Promise<number>;
  /** Animates to a zoom the user picked (outside follow mode) */
  easeToZoom(zoom: number): void;
  /** Moves the location arrow to the smoothed position and heading */
  setMarker(position: LatLng, heading: number): void;
  /**
   * The app is on screen (true) or not (false).  Off screen nothing is
   * written to the map: no camera, no arrow; the waiting camera pose is
   * dropped, not replayed later.
   */
  setVisualsLive(live: boolean): void;
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
  /** The recorded drive, drawn as the cyan trail; null when not driving */
  trail: readonly LatLng[] | null;
  trailColor: string;
  /**
   * The trail's live end, from its last recorded point to the puck: drawn
   * whenever the Drive screen's frame loop says, without re-rendering the map
   */
  trailHead?: TrailHeadSubscribe;
  /**
   * Friends' live positions (FriendMarkersMapbox), never touching the
   * camera.  View annotations, so they sit above the map's layers
   */
  friendLayer?: ReactElement | null;
  /**
   * The route preview, drawn by RouteLayers from the store itself (so a
   * preview update never re-renders the map).  Never touches the camera.
   */
  routePreview?: RoutePreviewStore | null;
  /**
   * The route being navigated (Phase 3), drawn by NavigationRouteLayers from
   * the session itself: only the part still to drive, redrawn when the
   * route changes (a reroute) or every 15 m or so of progress, never per GPS
   * fix or frame. Never touches the camera.
   */
  navigation?: NavigationSession | null;
  /** Logo and attribution sit this far above the bottom edge */
  ornamentBottom: number;
  ornamentLeft: number;
  /** The user moved the map with a gesture (pan, pinch, rotate or tilt) */
  onUserGesture: () => void;
  /** The camera changed, for any reason */
  onCameraChange?: () => void;
  /** A long press on the map, where it was (drop a pin). Never moves the camera */
  onLongPress?: (coordinate: { latitude: number; longitude: number }) => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  style?: StyleProp<ViewStyle>;
}

// The recorded drive: a soft glow under the cyan line, as on the old map
const TRAIL_GLOW = "rgba(0,207,232,0.28)";

// The arrow's artwork, the same images the first Mapbox build's arrow used
const ARROW_IMAGES = {
  "derwent-location-arrow": require("@/assets/images/map/puck-arrow.png"),
  "derwent-location-arrow-shadow": require("@/assets/images/map/puck-shadow.png"),
};

let tokenSet: string | null = null;
function useAccessToken(token: string) {
  if (tokenSet !== token) {
    tokenSet = token;
    void Mapbox.setAccessToken(token);
  }
}

/**
 * The location arrow, flat on the map.  Its own small component with its own
 * state, so moving or turning it every frame re-renders only this source and
 * replaces its one point, never the map or its other layers.  The shadow is
 * drawn first, beneath the arrow.
 */
type ArrowPose = { position: LatLng; heading: number };
interface MarkerFeederHandle {
  set(pose: ArrowPose): void;
}
const MarkerFeeder = memo(
  forwardRef<
    MarkerFeederHandle,
    { latest: React.RefObject<ArrowPose | null>; fallback: LatLng }
  >(function MarkerFeeder({ latest, fallback }, ref) {
    const [pose, setPose] = useState<ArrowPose>(
      () => latest.current ?? { position: fallback, heading: 0 },
    );
    const set = useCallback((next: ArrowPose) => {
      setPose((prev) =>
        prev.position.latitude === next.position.latitude &&
        prev.position.longitude === next.position.longitude &&
        prev.heading === next.heading
          ? prev
          : next,
      );
    }, []);
    useImperativeHandle(ref, () => ({ set }), [set]);
    // A pose pushed between this render and mounting is picked up here
    useEffect(() => {
      if (latest.current) set(latest.current);
    }, [latest, set]);
    const shape = useMemo(
      () => locationArrowFeature(pose.position, pose.heading),
      [pose],
    );
    return (
      <ShapeSource id="derwent-location-arrow" shape={shape}>
        <SymbolLayer
          id="derwent-location-arrow-shadow"
          style={{
            ...LOCATION_ARROW_SYMBOL,
            iconImage: "derwent-location-arrow-shadow",
          }}
        />
        <SymbolLayer
          id="derwent-location-arrow"
          style={{ ...LOCATION_ARROW_SYMBOL, iconImage: "derwent-location-arrow" }}
        />
      </ShapeSource>
    );
  }),
);

/**
 * The follow camera, as the Camera's props.  Its own small component, so a
 * new pose re-renders only the Camera, never the map or its layers.  Each
 * write reports `applied` once React has committed it; React Native's
 * renderer then hands the map the newest committed pose (never a backlog).
 */
interface FollowCameraHandle {
  write(pose: FollowCameraPose, applied: () => void): void;
}
type CameraDefaults = { centerCoordinate: [number, number]; zoomLevel: number };
const FollowCamera = memo(
  forwardRef<
    FollowCameraHandle,
    { cameraRef: React.RefObject<Camera | null>; defaultSettings: CameraDefaults }
  >(function FollowCamera({ cameraRef, defaultSettings }, ref) {
    const [pose, setPose] = useState<FollowCameraPose | null>(null);
    const appliedRef = useRef<(() => void) | null>(null);
    useImperativeHandle(
      ref,
      () => ({
        write(next, applied) {
          appliedRef.current = applied;
          setPose((prev) =>
            // The map applies a changed value only: the same pose again (to
            // bring the camera back after the user moved the map) is nudged
            // far below anything visible
            prev && sameValues(prev, next)
              ? { ...next, heading: next.heading + 1e-7 }
              : next,
          );
        },
      }),
      [],
    );
    useLayoutEffect(() => {
      const applied = appliedRef.current;
      appliedRef.current = null;
      applied?.();
    }, [pose]);
    const stop = pose ? mapboxFollowCamera(pose) : null;
    return <Camera ref={cameraRef} defaultSettings={defaultSettings} {...stop} />;
  }),
);
const sameValues = (a: FollowCameraPose, b: FollowCameraPose) =>
  a.center.latitude === b.center.latitude && a.center.longitude === b.center.longitude &&
  a.heading === b.heading && a.pitch === b.pitch && a.zoom === b.zoom;

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

/**
 * The route preview: alternatives (muted, tap to choose), the selected route
 * (bold) and the destination.  Its own small component reading the preview
 * store, so choosing a route re-renders only these sources.  Always mounted,
 * empty with no preview, so its layers keep their place beneath the trail and
 * the arrow.  It draws only: no camera, no location component.
 */
const RouteLayers = memo(function RouteLayers({ store }: { store: RoutePreviewStore }) {
  const state = useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribe(fn), [store]),
    () => store.state,
  );
  const features = useMemo(() => routePreviewFeatures(state), [state]);
  const choose = useCallback(
    (e: { features?: ReadonlyArray<{ properties?: Record<string, unknown> | null }> }) => {
      const index = tappedRouteIndex(e.features);
      if (index != null) store.select(index);
    },
    [store],
  );
  const line = { lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 } as const;
  return (
    <>
      <ShapeSource
        id="derwent-route-alternatives"
        shape={features.alternatives}
        onPress={choose}
        hitbox={{ width: 24, height: 24 }}
      >
        <LineLayer
          id="derwent-route-alternatives-casing"
          style={{ ...line, lineColor: ROUTE_COLORS.alternativeCasing, lineWidth: 9 }}
        />
        <LineLayer
          id="derwent-route-alternatives-line"
          style={{ ...line, lineColor: ROUTE_COLORS.alternative, lineWidth: 5 }}
        />
      </ShapeSource>
      <ShapeSource id="derwent-route-selected" shape={features.selected}>
        <LineLayer
          id="derwent-route-selected-casing"
          style={{ ...line, lineColor: ROUTE_COLORS.selectedCasing, lineWidth: 12 }}
        />
        <LineLayer
          id="derwent-route-selected-line"
          style={{ ...line, lineColor: ROUTE_COLORS.selected, lineWidth: 7 }}
        />
      </ShapeSource>
      <ShapeSource id="derwent-route-destination" shape={features.destination}>
        <CircleLayer
          id="derwent-route-destination-dot"
          style={{
            circleRadius: 8,
            circleColor: ROUTE_COLORS.destination,
            circleStrokeColor: ROUTE_COLORS.destinationRing,
            circleStrokeWidth: 4,
            circlePitchAlignment: "map",
            circleEmissiveStrength: 1,
          }}
        />
      </ShapeSource>
    </>
  );
});

/**
 * The route being navigated (the part still ahead: the line behind the car
 * is gone), and its destination. Reads the session's map view, which changes
 * only with the route, the destination, or each REMAINING_LINE.redrawEveryM
 * of progress: not every fix, never every frame. Draws only: no camera, no
 * location component.
 */
const NavigationRouteLayers = memo(function NavigationRouteLayers({ session }: { session: NavigationSession }) {
  // Held still in the background (background guidance keeps the session
  // current); the line as it is now arrives in one update on return
  const view = useOnScreenSnapshot(
    useCallback((fn: () => void) => session.subscribe(fn), [session]),
    useCallback(() => session.map, [session]),
  );
  const line = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: view.route
        ? [{
            type: "Feature" as const,
            properties: {},
            geometry: {
              type: "LineString" as const,
              // Only the part still to drive (derived; the route is never changed)
              coordinates: (view.remaining ?? view.route.geometry.map((p): [number, number] => [p.longitude, p.latitude])) as [number, number][],
            },
          }]
        : [],
    }),
    [view.route, view.remaining],
  );
  const point = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: view.destination
        ? [{
            type: "Feature" as const,
            properties: {},
            geometry: {
              type: "Point" as const,
              coordinates: [view.destination.coordinate.longitude, view.destination.coordinate.latitude] as [number, number],
            },
          }]
        : [],
    }),
    [view.destination],
  );
  const style = { lineCap: "round", lineJoin: "round", lineEmissiveStrength: 1 } as const;
  return (
    <>
      <ShapeSource id="derwent-nav-route" shape={line}>
        <LineLayer
          id="derwent-nav-route-casing"
          style={{ ...style, lineColor: ROUTE_COLORS.selectedCasing, lineWidth: 13 }}
        />
        <LineLayer
          id="derwent-nav-route-line"
          style={{ ...style, lineColor: ROUTE_COLORS.selected, lineWidth: 8 }}
        />
      </ShapeSource>
      <ShapeSource id="derwent-nav-destination" shape={point}>
        <CircleLayer
          id="derwent-nav-destination-dot"
          style={{
            circleRadius: 9,
            circleColor: ROUTE_COLORS.destination,
            circleStrokeColor: ROUTE_COLORS.destinationRing,
            circleStrokeWidth: 4,
            circlePitchAlignment: "map",
            circleEmissiveStrength: 1,
          }}
        />
      </ShapeSource>
    </>
  );
});

const MapboxDriveMap = forwardRef<MapboxDriveMapHandle, MapboxDriveMapProps>(
  function MapboxDriveMap(
    {
      accessToken,
      styleURL,
      initialCenter,
      showMarker,
      trail,
      trailColor,
      trailHead,
      friendLayer,
      routePreview,
      navigation,
      ornamentBottom,
      ornamentLeft,
      onUserGesture,
      onCameraChange,
      onLongPress,
      onTouchStart,
      onTouchEnd,
      style,
    },
    ref,
  ) {
    useAccessToken(accessToken);
    const mapRef = useRef<MapView>(null);
    const cameraRef = useRef<Camera>(null);
    const followCameraRef = useRef<FollowCameraHandle>(null);
    const markerRef = useRef<MarkerFeederHandle>(null);
    const lastCameraRef = useRef<ReportedPose | null>(null);
    const lastMarkerRef = useRef<ArrowPose | null>(null);
    const liveRef = useRef(true);
    // One camera write in flight at most, only the newest pose waiting
    const [cameraWriter] = useState(
      () =>
        new LatestPoseWriter<FollowCameraPose>({
          write: (pose, applied) => {
            // Not mounted yet: the write times out and the next pose tries again
            followCameraRef.current?.write(pose, applied);
          },
          same: sameFollowPose,
          now: Date.now,
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        }),
    );
    useEffect(() => () => cameraWriter.pause(), [cameraWriter]);

    useImperativeHandle(
      ref,
      () => ({
        setFollowCamera(pose) {
          cameraWriter.submit(pose);
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
        setMarker(position, heading) {
          const pose = { position, heading };
          lastMarkerRef.current = pose;
          if (liveRef.current) markerRef.current?.set(pose);
        },
        setVisualsLive(live) {
          liveRef.current = live;
          if (live) cameraWriter.resume();
          else cameraWriter.pause();
        },
      }),
      [cameraWriter],
    );

    // Mapbox says whether a gesture moved the camera, so the app's own
    // camera writes (every frame while following) are never mistaken for the
    // user's.  The reported camera is kept only as the place to ease from
    // when follow mode is next entered; it is never fed back while following.
    const handleCameraChanged = useCallback(
      (state: MapState) => {
        lastCameraRef.current = reportedPoseFromMapbox(state.properties);
        if (state.gestures?.isGestureActive) {
          // The map is no longer where the last pose put it: the next pose is
          // written even if it's the same one
          cameraWriter.invalidate();
          onUserGesture();
        }
        onCameraChange?.();
      },
      [onUserGesture, onCameraChange, cameraWriter],
    );

    // A long press reports where it was; what to do with it is the screen's
    const handleLongPress = useCallback(
      (feature: { geometry?: { coordinates?: number[] } }) => {
        const [longitude, latitude] = feature.geometry?.coordinates ?? [];
        if (
          typeof latitude === "number" && typeof longitude === "number" &&
          Number.isFinite(latitude) && Number.isFinite(longitude)
        ) {
          onLongPress?.({ latitude, longitude });
        }
      },
      [onLongPress],
    );

    // Bounded: a long drive's trail is thinned for drawing (lib/mapbox)
    const trailShape = useMemo(() => trailFeatureCollection(displayTrail(trail)), [trail]);

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
          onLongPress={onLongPress ? handleLongPress : undefined}
        >
          <FollowCamera
            ref={followCameraRef}
            cameraRef={cameraRef}
            defaultSettings={initialCamera}
          />
          <Images images={ARROW_IMAGES} />
          {/* Mounted first: the route preview draws beneath the trail and
              the arrow */}
          {routePreview && <RouteLayers store={routePreview} />}
          {navigation && <NavigationRouteLayers session={navigation} />}
          {/* Mounted before the trail: the head draws beneath it (and the
              arrow, mounted last, draws above both) */}
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
            />
          )}
        </MapView>
      </View>
    );
  },
);

export default MapboxDriveMap;

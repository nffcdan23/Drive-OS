// Friends' live positions on the react-native-maps Drive map (Apple Maps on
// iOS when Mapbox isn't in the build). Rendered inside <MapView> by the Drive
// screen; it subscribes to the shared positions itself, so a live update
// re-renders this layer and the marker that moved, never the screen or the
// map. Markers never move the camera; tapping one opens its card.

import React, { memo, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Marker } from "react-native-maps";
import { friendMapSelection, sameMarker, type FriendMarkerModel } from "@/lib/liveMap";
import { FriendMarkerFace } from "./FriendMarkerFace";
import { useFriendMarkerModels, useGlidedPosition } from "./useFriendMarkers";

/** Apple Maps draws a marker from a snapshot; re-take it for this long after the look changes. */
const RESNAPSHOT_MS = 400;

const FriendMarker = memo(function FriendMarker({
  model,
  selected,
}: {
  model: FriendMarkerModel;
  selected: boolean;
}) {
  const coordinate = useGlidedPosition(model);
  // Headings rounded to 10°: a tiny change isn't worth a new snapshot
  const heading = model.headingDeg == null ? null : Math.round(model.headingDeg / 10) * 10;
  const look = `${model.mode}|${heading}|${model.stale}|${selected}|${model.avatarUrl}|${model.initials}`;
  const [tracking, setTracking] = useState(true);
  useEffect(() => {
    setTracking(true);
    const t = setTimeout(() => setTracking(false), RESNAPSHOT_MS);
    return () => clearTimeout(t);
  }, [look]);
  const onImageSettled = useCallback(() => {
    setTracking(true);
    setTimeout(() => setTracking(false), RESNAPSHOT_MS);
  }, []);
  return (
    <Marker
      identifier={`friend-${model.userId}`}
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracking}
      // No zIndex: drawn before, and so beneath, the user's own arrow
      // Apple Maps keeps annotations upright; the notch turns inside the view
      flat={Platform.OS === "android"}
      onPress={(e) => {
        e.stopPropagation?.();
        friendMapSelection.select(model.userId);
      }}
      accessibilityLabel={`${model.name}, ${model.mode === "driving" ? "driving" : "stationary"}`}
    >
      <FriendMarkerFace
        initials={model.initials}
        avatarUrl={model.avatarUrl}
        driving={model.mode === "driving"}
        headingDeg={heading}
        stale={model.stale}
        selected={selected}
        onImageSettled={onImageSettled}
      />
    </Marker>
  );
},
(prev, next) => prev.selected === next.selected && sameMarker(prev.model, next.model));

export const FriendMarkersNative = memo(function FriendMarkersNative() {
  const models = useFriendMarkerModels();
  const selected = useSyncExternalStore(
    useCallback((fn: () => void) => friendMapSelection.subscribe(fn), []),
    () => friendMapSelection.current,
  );
  return (
    <>
      {models.map((m) => (
        <FriendMarker key={m.userId} model={m} selected={selected === m.userId} />
      ))}
    </>
  );
});

// Friends' live positions on the Mapbox Drive map, as view annotations
// (MarkerView) rendered inside the map by MapboxDriveMap. Loaded only when
// Mapbox is in the build (it imports @rnmapbox/maps). Same data and behaviour
// as the react-native-maps layer: subscribes to the shared positions itself,
// never moves the camera, and a tap opens the friend's card.

import React, { memo, useCallback, useSyncExternalStore } from "react";
import { Pressable } from "react-native";
import { MarkerView } from "@rnmapbox/maps";
import { friendMapSelection, sameMarker, type FriendMarkerModel } from "@/lib/liveMap";
import { FriendMarkerFace } from "./FriendMarkerFace";
import { useFriendMarkerModels, useGlidedPosition } from "./useFriendMarkers";

const FriendMarker = memo(function FriendMarker({
  model,
  selected,
}: {
  model: FriendMarkerModel;
  selected: boolean;
}) {
  const p = useGlidedPosition(model);
  const heading = model.headingDeg == null ? null : Math.round(model.headingDeg / 5) * 5;
  return (
    <MarkerView coordinate={[p.longitude, p.latitude]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
      <Pressable
        onPress={() => friendMapSelection.select(model.userId)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${model.name}, ${model.mode === "driving" ? "driving" : "stationary"}`}
      >
        <FriendMarkerFace
          initials={model.initials}
          avatarUrl={model.avatarUrl}
          driving={model.mode === "driving"}
          headingDeg={heading}
          stale={model.stale}
          selected={selected}
        />
      </Pressable>
    </MarkerView>
  );
},
(prev, next) => prev.selected === next.selected && sameMarker(prev.model, next.model));

export const FriendMarkersMapbox = memo(function FriendMarkersMapbox() {
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

export default FriendMarkersMapbox;

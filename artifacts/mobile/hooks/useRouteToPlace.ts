/**
 * Choosing a saved place or Beauty Spot to drive to (Navigation Phase 2A).
 *
 * With the Mapbox Drive map and no drive being recorded, it opens a route
 * preview on the Drive screen; otherwise the place opens in the phone's maps
 * app, exactly as before.
 */
import { useCallback } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { useApp } from "@/context/AppContext";
import { canPreviewRoutes, useOpenRoutePreview } from "@/context/NavigationContext";
import { openDirections } from "@/lib/directions";
import { describeError } from "@/lib/backend/http";
import type { NearbySpot, SavedPlace } from "@/lib/backend/model";
import type { Destination } from "@/lib/navigation/model";

/** A saved place (the user's own, Beauty Spots included) as a destination */
export function placeDestination(p: SavedPlace): Destination {
  const spot = p.kind === "beauty_spot";
  return {
    id: `place:${p.id}`,
    name: p.name,
    subtitle: spot ? "Beauty Spot" : "Saved place",
    coordinate: { latitude: p.coordinate.latitude, longitude: p.coordinate.longitude },
    source: spot ? "spot" : "saved",
  };
}

/** A Beauty Spot someone shared nearby as a destination */
export function spotDestination(n: NearbySpot): Destination {
  return {
    id: `spot:${n.id}`,
    name: n.name,
    subtitle: n.isOwn ? "Beauty Spot" : "Shared Beauty Spot",
    coordinate: { latitude: n.coordinate.latitude, longitude: n.coordinate.longitude },
    source: "spot",
  };
}

export function useRouteToPlace() {
  const { isDriving } = useApp();
  const openPreview = useOpenRoutePreview();
  const router = useRouter();
  return useCallback(
    async (destination: Destination) => {
      if (!canPreviewRoutes(isDriving)) {
        await openDirections(destination.coordinate);
        return;
      }
      try {
        await openPreview(destination);
      } catch (err) {
        Alert.alert("Couldn't preview a route", describeError(err));
        return;
      }
      router.dismissTo("/(tabs)/(drive)");
    },
    [isDriving, openPreview, router],
  );
}

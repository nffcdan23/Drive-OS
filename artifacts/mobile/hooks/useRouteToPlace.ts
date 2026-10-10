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
import { placeToDestination } from "@/lib/navigation/localResults";

/** A saved place (the user's own, Beauty Spots included) as a destination */
export function placeDestination(p: SavedPlace): Destination {
  return placeToDestination(p);
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
        // A Search Box result is only ever shown on the Mapbox map (Mapbox's
        // terms); search is offered only where it can be, so this is a drive
        // that started meanwhile
        if (destination.source === "search") {
          Alert.alert("Finish your drive first", "Places from search open as a route preview once you've stopped recording.");
          return;
        }
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

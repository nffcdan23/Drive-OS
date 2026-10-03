// Which map the Drive screen draws.  Mapbox when it's configured (public
// token + style URL) and the app binary includes its native module; the
// react-native-maps map otherwise, so a build without Mapbox, Expo Go or web
// keeps working.  Removing the two Mapbox settings switches back.

import { NativeModules, Platform } from "react-native";
import { CONFIG } from "@/constants/config";
import { mapboxSettings, type MapboxSettings } from "./mapbox";

// The same check @rnmapbox/maps makes on import (it throws without it), so
// the Mapbox map is only ever loaded into a binary that can run it
function mapboxNativeModuleAvailable(): boolean {
  try {
    return NativeModules.RNMBXModule != null;
  } catch {
    return false;
  }
}

const settings =
  Platform.OS === "web"
    ? null
    : mapboxSettings(CONFIG.MAPBOX_TOKEN, CONFIG.MAPBOX_STYLE_URL);

const nativeAvailable = mapboxNativeModuleAvailable();

/** Mapbox settings when the Drive map runs on Mapbox, else null */
export const DRIVE_MAPBOX: MapboxSettings | null =
  settings && nativeAvailable ? settings : null;

/**
 * TEMPORARY (development builds only): why the Drive map chose its provider.
 * Never contains the token itself.
 */
export const MAP_PROVIDER_DIAGNOSTICS = {
  platform: Platform.OS,
  tokenPresent: !!(CONFIG.MAPBOX_TOKEN ?? "").trim(),
  tokenIsPublic: (CONFIG.MAPBOX_TOKEN ?? "").trim().startsWith("pk."),
  styleUrlPresent: !!(CONFIG.MAPBOX_STYLE_URL ?? "").trim(),
  styleUrlAccepted: settings != null,
  mapboxNativeModulePresent: nativeAvailable,
  selectedMapProvider: DRIVE_MAPBOX ? "mapbox" : "react-native-maps",
} as const;

if (__DEV__ && Platform.OS !== "web") {
  console.log("[Drive map]", JSON.stringify(MAP_PROVIDER_DIAGNOSTICS));
  if (settings && !nativeAvailable) {
    console.warn(
      "Mapbox is configured but this app build doesn't include it; the Drive map is using react-native-maps. Make a new development build.",
    );
  }
}

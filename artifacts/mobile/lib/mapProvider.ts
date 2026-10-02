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

const nativeAvailable = settings != null && mapboxNativeModuleAvailable();

if (__DEV__ && settings && !nativeAvailable) {
  console.warn(
    "Mapbox is configured but this app build doesn't include it; the Drive map is using react-native-maps. Make a new development build.",
  );
}

/** Mapbox settings when the Drive map runs on Mapbox, else null */
export const DRIVE_MAPBOX: MapboxSettings | null = nativeAvailable
  ? settings
  : null;

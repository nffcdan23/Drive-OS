// Web never uses the Mapbox Drive map (lib/mapProvider.ts selects it only on
// iOS and Android); this keeps @rnmapbox/maps' native code out of the web
// bundle.
import { forwardRef } from "react";
import type {
  MapboxDriveMapHandle,
  MapboxDriveMapProps,
} from "./MapboxDriveMap";

const MapboxDriveMap = forwardRef<MapboxDriveMapHandle, MapboxDriveMapProps>(
  function MapboxDriveMap() {
    return null;
  },
);

export type { MapboxDriveMapHandle, MapboxDriveMapProps };
export default MapboxDriveMap;

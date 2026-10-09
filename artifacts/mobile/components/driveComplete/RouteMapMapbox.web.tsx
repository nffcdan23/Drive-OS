// Web never uses Mapbox (lib/mapProvider.ts), so the web bundle gets this
// instead of @rnmapbox/maps, which doesn't build for the web.
export default function RouteMapMapbox(_props: {
  coordinates: unknown;
  settings: unknown;
  interactive: boolean;
  padding: number;
}) {
  return null;
}

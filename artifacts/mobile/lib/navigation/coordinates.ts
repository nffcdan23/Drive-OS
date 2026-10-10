// Coordinates typed or pasted into search: "53.1234, -1.2345" or
// "53.1234 -1.2345" (latitude first). Parsed on the phone and turned straight
// into a destination: no search request is made for them.
//
// No React Native imports, so it is unit-tested under node.

import type { Destination, LatLng } from './model';

// Two signed decimals separated by a comma and/or spaces. At least one of
// them must have a decimal point, so "12 34" (a house number and a street,
// say) is never taken for a position.
const PAIR = /^\s*([+-]?\d{1,3}(?:\.\d+)?)\s*(?:,\s*|\s+)([+-]?\d{1,3}(?:\.\d+)?)\s*$/;

/** The position in `text`, or null when it isn't a valid latitude, longitude pair */
export function parseCoordinates(text: string): LatLng | null {
  const m = PAIR.exec(text);
  if (!m) return null;
  const [, a, b] = m as unknown as [string, string, string];
  if (!a.includes('.') && !b.includes('.')) return null;
  const latitude = Number(a);
  const longitude = Number(b);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

/** "53.12340, -1.23450" */
export function formatCoordinates(p: LatLng): string {
  return `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
}

/** A typed position as a destination ("Dropped Pin" until it has a name) */
export function coordinateDestination(p: LatLng, source: 'coordinates' | 'pin' = 'coordinates'): Destination {
  const text = formatCoordinates(p);
  return {
    id: `coord:${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`,
    name: 'Dropped Pin',
    subtitle: text,
    coordinate: { latitude: p.latitude, longitude: p.longitude },
    source,
  };
}

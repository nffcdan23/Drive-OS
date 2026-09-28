/**
 * Route geometry helpers: distance, simplification, trimming and Google
 * encoded polylines (precision 5, ~1 m).
 */
export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6_371_008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLengthMetres(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMetres(points[i - 1]!, points[i]!);
  return total;
}

/** Perpendicular distance (metres) from p to segment a–b, on a local plane. */
function segmentDistance(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos(rad(a.lat));
  const ax = a.lng * k, ay = a.lat, bx = b.lng * k, by = b.lat, px = p.lng * k, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy) * (Math.PI / 180) * R;
}

/** Douglas–Peucker simplification (iterative), tolerance in metres. */
export function simplify(points: LatLng[], toleranceMetres = 5): LatLng[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i]!, points[first]!, points[last]!);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (index !== -1 && maxDist > toleranceMetres) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Removes the first and last `metres` of a route so a shared route does not
 * reveal where it starts and ends. Returns [] if the route is too short.
 */
export function trimEnds(points: LatLng[], metres = 400): LatLng[] {
  if (points.length < 2 || pathLengthMetres(points) < metres * 2 + 100) return [];
  const start = points[0]!, end = points[points.length - 1]!;
  let from = 0;
  while (from < points.length && haversineMetres(start, points[from]!) < metres) from++;
  let to = points.length - 1;
  while (to >= 0 && haversineMetres(end, points[to]!) < metres) to--;
  return from < to ? points.slice(from, to + 1) : [];
}

export function encodePolyline(points: LatLng[], precision = 5): string {
  const factor = 10 ** precision;
  let prevLat = 0, prevLng = 0, out = "";
  const enc = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = "";
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    out += enc(lat - prevLat) + enc(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

export function decodePolyline(str: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const out: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  const next = () => {
    let result = 0, shift = 0, b: number;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < str.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

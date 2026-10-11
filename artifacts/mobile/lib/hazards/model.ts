// Live road hazards (migration 0020): what a report is on the phone, and how
// it is drawn. Reports are anonymous: nothing here ever holds who made one.
// The driver's own relation to a hazard (they reported it, or said "Still
// there" / "Not there") is all they learn, and only about themselves.
//
// The server owns every rule (lifetimes, merging, votes, removal, limits).
// The app only parses what it is sent, drops what has expired by the
// server's clock, and draws the rest.
//
// No React Native imports, so it is unit-tested under node.

export type HazardKind = 'accident' | 'hazard' | 'broken_down' | 'roadworks' | 'flooding' | 'police';

export interface HazardKindInfo {
  kind: HazardKind;
  /** On the report sheet and the detail card */
  label: string;
  /** Ionicons name (the map marker artwork uses the same glyph) */
  icon: string;
  color: string;
  /** The map marker image (registered with the map by name) */
  markerImage: string;
}

/** The report sheet's order. Keep colours and icons in step with scripts/generate-hazard-icons.mjs. */
export const HAZARD_KINDS: readonly HazardKindInfo[] = [
  { kind: 'accident', label: 'Accident', icon: 'car-sport', color: '#E5484D', markerImage: 'derwent-hazard-accident' },
  { kind: 'hazard', label: 'Hazard', icon: 'warning', color: '#F59E0B', markerImage: 'derwent-hazard-hazard' },
  { kind: 'broken_down', label: 'Broken-down vehicle', icon: 'build', color: '#F97316', markerImage: 'derwent-hazard-broken-down' },
  { kind: 'roadworks', label: 'Roadworks', icon: 'construct', color: '#D9A50B', markerImage: 'derwent-hazard-roadworks' },
  { kind: 'flooding', label: 'Flooding', icon: 'water', color: '#3B82F6', markerImage: 'derwent-hazard-flooding' },
  { kind: 'police', label: 'Police', icon: 'shield', color: '#7C5CFA', markerImage: 'derwent-hazard-police' },
];

const BY_KIND = new Map(HAZARD_KINDS.map((k) => [k.kind, k]));
/** A kind this version doesn't know (a newer server) is shown as a generic hazard. */
export const kindInfo = (kind: string): HazardKindInfo => BY_KIND.get(kind as HazardKind) ?? BY_KIND.get('hazard')!;

export type MyHazardVote = 'reported' | 'still_there' | 'not_there' | null;

export interface RoadHazard {
  id: string;
  /** As sent (an unknown one still draws, as a generic hazard) */
  kind: string;
  latitude: number;
  longitude: number;
  /** The reporter's direction of travel (10° buckets), when it was reliable; null otherwise (0021) */
  travelHeadingDeg: number | null;
  reportedAt: number;
  lastConfirmedAt: number;
  /** When it disappears, on this phone's clock (from the server's remaining lifetime) */
  expiresAt: number;
  confirmations: number;
  myVote: MyHazardVote;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const time = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * A hazard from the API or a Realtime broadcast, or null if it isn't one.
 * Its expiry is taken from the server's remaining lifetime (expiresInMs) on
 * receipt, so a phone whose clock is wrong still drops it on time.
 */
export function parseHazard(raw: unknown, receivedAt: number, myVote?: MyHazardVote): RoadHazard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.kind !== 'string' || !r.kind) return null;
  if (!finite(r.latitude) || !finite(r.longitude) || Math.abs(r.latitude) > 90 || Math.abs(r.longitude) > 180) return null;
  const reportedAt = time(r.reportedAt);
  if (reportedAt == null) return null;
  const expiresAt = finite(r.expiresInMs) ? receivedAt + Math.max(0, r.expiresInMs) : time(r.expiresAt);
  if (expiresAt == null) return null;
  const vote = myVote !== undefined ? myVote : r.myVote;
  const heading = r.travelHeadingDeg;
  return {
    id: r.id,
    kind: r.kind,
    latitude: r.latitude,
    longitude: r.longitude,
    travelHeadingDeg: finite(heading) && heading >= 0 && heading < 360 ? heading : null,
    reportedAt,
    lastConfirmedAt: time(r.lastConfirmedAt) ?? reportedAt,
    expiresAt,
    confirmations: finite(r.confirmations) && r.confirmations > 0 ? Math.floor(r.confirmations) : 0,
    myVote: vote === 'reported' || vote === 'still_there' || vote === 'not_there' ? vote : null,
  };
}

/** A Realtime message on a hazard area topic */
export type HazardEvent = { type: 'hazard'; hazard: RoadHazard } | { type: 'hazard_removed'; id: string };

export function parseHazardEvent(raw: unknown, receivedAt: number): HazardEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type === 'hazard_removed') return typeof r.id === 'string' && r.id ? { type: 'hazard_removed', id: r.id } : null;
  if (r.type !== 'hazard') return null;
  // A broadcast never says how this driver voted: that is kept from what they already know
  const hazard = parseHazard(r, receivedAt, null);
  return hazard ? { type: 'hazard', hazard } : null;
}

// ─── Areas ───────────────────────────────────────────────────────────────────

export interface Area {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

const KM_PER_DEG_LAT = 111.32;

/** The area within `radiusKm` of a point (clamped to the globe) */
export function areaAround(lat: number, lng: number, radiusKm: number): Area {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    minLat: Math.max(-90, lat - dLat),
    maxLat: Math.min(90, lat + dLat),
    minLng: Math.max(-180, lng - dLng),
    maxLng: Math.min(180, lng + dLng),
  };
}

export const inArea = (a: Area, lat: number, lng: number) =>
  lat >= a.minLat && lat <= a.maxLat && lng >= a.minLng && lng <= a.maxLng;

/** The server's Realtime area for a position: private.hazard_topic (0.5° cells) */
export const hazardTopic = (lat: number, lng: number) => `hazards:${Math.floor(lat * 2)}:${Math.floor(lng * 2)}`;

/** Every area topic an area touches (at most four for the areas the app loads) */
export function hazardTopicsFor(a: Area): string[] {
  const topics: string[] = [];
  for (let la = Math.floor(a.minLat * 2); la <= Math.floor(a.maxLat * 2); la++) {
    for (let lo = Math.floor(a.minLng * 2); lo <= Math.floor(a.maxLng * 2); lo++) topics.push(`hazards:${la}:${lo}`);
  }
  return topics;
}

/** Great-circle distance in metres */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ─── The map ─────────────────────────────────────────────────────────────────

export interface HazardFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { id: string; image: string };
}

export interface HazardFeatureCollection {
  type: 'FeatureCollection';
  features: HazardFeature[];
}

/** Markers for the map: active hazards only, one per hazard, nothing about anyone. */
export function hazardFeatures(hazards: readonly RoadHazard[], now: number): HazardFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: hazards
      .filter((h) => h.expiresAt > now)
      .map((h) => ({
        type: 'Feature' as const,
        id: h.id,
        geometry: { type: 'Point' as const, coordinates: [h.longitude, h.latitude] as [number, number] },
        properties: { id: h.id, image: kindInfo(h.kind).markerImage },
      })),
  };
}

/** "Reported just now", "Reported 12 min ago", "Reported 2 h ago" */
export function reportedAgo(reportedAt: number, now: number): string {
  const min = Math.floor(Math.max(0, now - reportedAt) / 60_000);
  if (min < 1) return 'Reported just now';
  if (min < 60) return `Reported ${min} min ago`;
  const h = Math.floor(min / 60);
  return `Reported ${h} h ago`;
}

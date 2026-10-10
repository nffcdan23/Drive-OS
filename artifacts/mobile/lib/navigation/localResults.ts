// The instant, on-device half of destination search: the user's saved
// places, Beauty Spots, recent destinations and nearby shared spots that
// match what they typed. Works offline; shown above the Search Box results.
//
// No React Native imports, so it is unit-tested under node.

import type { Destination, LatLng } from './model';

export interface LocalPlace {
  id: string;
  kind: string;
  name: string;
  address?: string;
  coordinate: LatLng;
}

export interface LocalSpot {
  id: string;
  name: string;
  coordinate: LatLng;
  isOwn: boolean;
}

export interface LocalMatch {
  destination: Destination;
  /** What the row shows under the name */
  detail: string;
  icon: 'saved' | 'spot' | 'recent' | 'home' | 'work';
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Every word typed starts a word of the text ("lake rd" matches "Lake Road") */
export function matchesQuery(text: string, query: string): boolean {
  const words = norm(text).split(' ');
  const typed = norm(query).split(' ').filter(Boolean);
  return typed.length > 0 && typed.every((t) => words.some((w) => w.startsWith(t)));
}

export function placeToDestination(p: LocalPlace): Destination {
  const spot = p.kind === 'beauty_spot';
  return {
    id: `place:${p.id}`,
    name: p.name,
    subtitle: p.address?.trim() || (spot ? 'Beauty Spot' : 'Saved place'),
    coordinate: { latitude: p.coordinate.latitude, longitude: p.coordinate.longitude },
    source: spot ? 'spot' : 'saved',
  };
}

/** The user's own matches for `query`, best first, at most `limit` */
export function localMatches(
  query: string,
  data: { places: readonly LocalPlace[]; recents: readonly Destination[]; nearby: readonly LocalSpot[] },
  limit = 8,
): LocalMatch[] {
  if (!norm(query)) return [];
  const out: LocalMatch[] = [];
  const seen = new Set<string>();
  const add = (m: LocalMatch) => {
    if (seen.has(m.destination.id) || out.length >= limit) return;
    seen.add(m.destination.id);
    out.push(m);
  };
  // Names first, then addresses
  const places = [...data.places].sort((a, b) => Number(!matchesQuery(a.name, query)) - Number(!matchesQuery(b.name, query)));
  for (const p of places) {
    if (!matchesQuery(p.name, query) && !(p.address && matchesQuery(p.address, query))) continue;
    const d = placeToDestination(p);
    add({
      destination: d,
      detail: d.subtitle ?? '',
      icon: p.kind === 'home' ? 'home' : p.kind === 'work' ? 'work' : p.kind === 'beauty_spot' ? 'spot' : 'saved',
    });
  }
  for (const r of data.recents) {
    if (matchesQuery(r.name, query) || (r.subtitle && matchesQuery(r.subtitle, query))) {
      add({ destination: r, detail: r.subtitle ?? 'Recent', icon: 'recent' });
    }
  }
  for (const n of data.nearby) {
    if (n.isOwn || !matchesQuery(n.name, query)) continue;
    add({
      destination: {
        id: `spot:${n.id}`, name: n.name, subtitle: 'Shared Beauty Spot',
        coordinate: { latitude: n.coordinate.latitude, longitude: n.coordinate.longitude }, source: 'spot',
      },
      detail: 'Shared Beauty Spot',
      icon: 'spot',
    });
  }
  return out;
}

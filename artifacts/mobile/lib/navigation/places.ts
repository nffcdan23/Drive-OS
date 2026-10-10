// Saving a destination as one of the user's places, without saving the same
// place twice.
//
// No React Native imports, so it is unit-tested under node.

import { distanceM } from '../backend/geo';
import { canStoreDestination, type Destination, type LatLng } from './model';

export const DUPLICATES = {
  /** A saved place this close is the same spot, whatever it's called (m) */
  sameSpotM: 15,
  /** ...and one with the same name this close is the same place (m) */
  sameNameM: 150,
} as const;

export interface PlaceLike {
  id: string;
  name: string;
  address?: string;
  coordinate: LatLng;
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The saved place `d` already is, if any: the place itself, one on the same
 * spot, or one of the same name or address close by. Different places a
 * street apart are not merged.
 */
export function findSavedMatch<P extends PlaceLike>(places: readonly P[], d: Destination): P | null {
  if (d.source === 'saved' || d.source === 'spot') {
    const own = places.find((p) => d.id === `place:${p.id}` || d.id === `spot:${p.id}`);
    if (own) return own;
  }
  let best: { p: P; m: number } | null = null;
  const name = norm(d.name);
  const sub = norm(d.subtitle);
  for (const p of places) {
    const m = distanceM(p.coordinate, d.coordinate);
    const sameName = !!name && name !== 'dropped pin' && norm(p.name) === name;
    const sameAddress = !!sub && !!p.address && norm(p.address) === sub;
    if (m <= DUPLICATES.sameSpotM || ((sameName || sameAddress) && m <= DUPLICATES.sameNameM)) {
      if (!best || m < best.m) best = { p, m };
    }
  }
  return best?.p ?? null;
}

/** What a destination can be saved as, or why it can't be */
export function saveability(places: readonly PlaceLike[], d: Destination):
  | { kind: 'saved'; placeId: string }
  | { kind: 'can_save' }
  | { kind: 'not_storable' } {
  const match = findSavedMatch(places, d);
  if (match) return { kind: 'saved', placeId: match.id };
  return canStoreDestination(d) ? { kind: 'can_save' } : { kind: 'not_storable' };
}

/** The fields saved for a destination: the user's name for it, where it is, its address */
export function placeFieldsFor(d: Destination, name: string): { name: string; coordinate: LatLng; address?: string } {
  if (!canStoreDestination(d)) throw new Error('This place came from search and cannot be saved.');
  const address = d.subtitle?.trim();
  return {
    name: name.trim().slice(0, 100),
    coordinate: { latitude: d.coordinate.latitude, longitude: d.coordinate.longitude },
    ...(address ? { address: address.slice(0, 300) } : {}),
  };
}

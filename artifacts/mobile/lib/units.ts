/**
 * Units of measurement utilities for DriveOS.
 *
 * Raw values are always stored in their original form (km for distances from
 * the API, km/h for speeds). Conversion happens only at display time via
 * the functions in this module.
 */

export type UnitSystem = 'auto' | 'imperial' | 'metric';
export type ResolvedUnitSystem = 'imperial' | 'metric';

export interface UnitOption {
  value: UnitSystem;
  label: string;
  sub: string;
}

export const UNIT_SYSTEM_OPTIONS: UnitOption[] = [
  { value: 'auto',     label: 'Automatic',  sub: 'Based on your device region' },
  { value: 'imperial', label: 'Imperial',   sub: 'Miles, mph, yards & feet' },
  { value: 'metric',   label: 'Metric',     sub: 'Kilometres, km/h & metres' },
];

/**
 * Regions whose roads are signed in miles and mph: the UK and the Crown
 * dependencies, the US and its territories, and the other countries and
 * territories that still use mph.  Everywhere else uses km/h.
 */
export const MPH_REGIONS: ReadonlySet<string> = new Set([
  'GB', 'IM', 'JE', 'GG',
  'US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM',
  'AG', 'AI', 'BS', 'BZ', 'DM', 'FK', 'GD', 'KN', 'KY', 'LC', 'LR', 'MS', 'SH', 'TC', 'VC', 'VG', 'WS',
]);

/** The region (e.g. "GB") a locale tag such as "en-GB" or "en_GB" names, if any */
export function localeRegion(locale: string): string | null {
  const m = /^[a-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2})(?:$|[-_@])/i.exec(locale);
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Resolves the effective unit system from the user's stored preference.
 *
 * 'auto' follows the device's region (Settings → General → Language & Region
 * → Region), passed in as `deviceRegion`: imperial where roads are signed in
 * mph (the UK, the US, ...), metric elsewhere.  The region is what decides
 * it, not the language: a phone in English (US) with its region set to the
 * UK still shows mph, and one in English (UK) set to France shows km/h.
 * Without a region it falls back to the region in the locale's tag, then to
 * metric.
 */
export function resolveUnitSystem(pref: UnitSystem, deviceRegion?: string | null): ResolvedUnitSystem {
  if (pref === 'imperial') return 'imperial';
  if (pref === 'metric')   return 'metric';

  let region = deviceRegion ? deviceRegion.toUpperCase() : null;
  if (!region) {
    try {
      region = localeRegion(Intl.DateTimeFormat().resolvedOptions().locale ?? '');
    } catch {
      // Intl unavailable — default to metric
    }
  }
  return region && MPH_REGIONS.has(region) ? 'imperial' : 'metric';
}

// ─── Conversion ───────────────────────────────────────────────────────────────
//
// The only place speeds and distances change unit.  GPS (Expo Location and
// the browser alike) reports speed in metres per second; the app converts it
// to km/h once, as each fix comes in (msToKmh), and keeps km/h from then on:
// the live drive, recorded points, saved journeys and the server all hold
// km/h.  mph exists only on screen, converted from km/h by convertSpeed and
// labelled by speedUnit.

/** km/h in 1 m/s (3600 s/h ÷ 1000 m/km) */
export const KMH_PER_MS = 3.6;
/** Kilometres in an international mile (exact) */
export const KM_PER_MILE = 1.609344;
const METRES_PER_YARD = 0.9144;

/** A GPS speed (m/s) in km/h.  Unknown or invalid (iOS reports -1) is 0. */
export function msToKmh(ms: number | null | undefined): number {
  return ms != null && ms > 0 ? ms * KMH_PER_MS : 0;
}

/** km/h in mph */
export function kmhToMph(kmh: number): number {
  return kmh / KM_PER_MILE;
}

/** A GPS speed (m/s) in mph */
export function msToMph(ms: number | null | undefined): number {
  return kmhToMph(msToKmh(ms));
}

/** A speed (km/h, the app's unit) in the unit `system` shows: mph or km/h */
export function convertSpeed(kmh: number, system: ResolvedUnitSystem): number {
  return system === 'imperial' ? kmhToMph(kmh) : kmh;
}

// ─── Distance ─────────────────────────────────────────────────────────────────

/**
 * Format a distance for display. Input is kilometres (Journey.distance storage unit).
 * Returns e.g. "12.3 mi" or "12.3 km".
 */
export function formatDistance(km: number, system: ResolvedUnitSystem): string {
  if (system === 'imperial') {
    return `${(km / KM_PER_MILE).toFixed(1)} mi`;
  }
  return `${km.toFixed(1)} km`;
}

/**
 * Format a short navigation distance. Input is metres.
 * Imperial: yards < 880 yd → miles. Metric: metres < 1 km → km.
 */
export function formatShortDistance(metres: number, system: ResolvedUnitSystem): string {
  if (system === 'imperial') {
    const yards = metres / METRES_PER_YARD;
    if (yards < 880) return `${Math.round(yards)} yd`;
    const miles = metres / (KM_PER_MILE * 1000);
    return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
  }
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** Unit label for distances — "mi" or "km". */
export function distanceUnit(system: ResolvedUnitSystem): string {
  return system === 'imperial' ? 'mi' : 'km';
}

// ─── Speed ────────────────────────────────────────────────────────────────────

/**
 * Format a speed for display. Input is km/h (Journey.topSpeed storage unit).
 * Returns e.g. "62 mph" or "100 km/h".
 */
export function formatSpeed(kmh: number, system: ResolvedUnitSystem): string {
  return `${Math.round(convertSpeed(kmh, system))} ${speedUnit(system)}`;
}

/** Unit label for speeds — "mph" or "km/h". */
export function speedUnit(system: ResolvedUnitSystem): string {
  return system === 'imperial' ? 'mph' : 'km/h';
}

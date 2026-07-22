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
 * Resolves the effective unit system from the user's stored preference.
 *
 * 'auto' uses the device locale; UK locale (en-GB) maps to Imperial to match
 * real-world UK road sign conventions (miles & mph with metric tonnes/litres).
 */
export function resolveUnitSystem(pref: UnitSystem): ResolvedUnitSystem {
  if (pref === 'imperial') return 'imperial';
  if (pref === 'metric')   return 'metric';

  // auto — detect from device locale via the Intl API (available on Hermes + web)
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    if (locale.includes('-GB') || locale === 'en-GB') return 'imperial';
  } catch {
    // Intl unavailable — default to metric
  }
  return 'metric';
}

// ─── Distance ─────────────────────────────────────────────────────────────────

/**
 * Format a distance for display. Input is kilometres (Journey.distance storage unit).
 * Returns e.g. "12.3 mi" or "12.3 km".
 */
export function formatDistance(km: number, system: ResolvedUnitSystem): string {
  if (system === 'imperial') {
    return `${(km * 0.621371).toFixed(1)} mi`;
  }
  return `${km.toFixed(1)} km`;
}

/**
 * Format a short navigation distance. Input is metres.
 * Imperial: yards < 880 yd → miles. Metric: metres < 1 km → km.
 */
export function formatShortDistance(metres: number, system: ResolvedUnitSystem): string {
  if (system === 'imperial') {
    const yards = metres * 1.09361;
    if (yards < 880) return `${Math.round(yards)} yd`;
    const miles = metres / 1609.344;
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
  if (system === 'imperial') {
    return `${Math.round(kmh * 0.621371)} mph`;
  }
  return `${Math.round(kmh)} km/h`;
}

/** Unit label for speeds — "mph" or "km/h". */
export function speedUnit(system: ResolvedUnitSystem): string {
  return system === 'imperial' ? 'mph' : 'km/h';
}

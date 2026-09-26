/**
 * Applying a DVLA registration lookup to the (unsaved) vehicle form.
 *
 * A lookup only suggests values. It fills fields that are blank or that an
 * earlier lookup filled, and never replaces something the user typed or had
 * already saved: those differences are listed so the user can choose to use
 * DVLA's values. Nothing is saved until the user taps Save.
 */
import { parseUkRegistration } from '@workspace/vehicle-registration';
import { ApiError, NetworkError } from './http';
import type { VehicleLookup } from './endpoints';
import type { FuelType, Vehicle } from './model';

export type LookupField = 'make' | 'colour' | 'fuelType' | 'year' | 'engine';
export const LOOKUP_FIELDS: readonly LookupField[] = ['make', 'colour', 'fuelType', 'year', 'engine'];

/** Where a field's current value came from. */
export type FieldSource = 'blank' | 'user' | 'dvla';
export type FieldSources = Record<LookupField, FieldSource>;

type LookupForm = Pick<Vehicle, 'registration' | LookupField>;
export type Suggestions = VehicleLookup['suggested'];

export interface Conflict { field: LookupField; yours: string; suggested: string }

export interface MergeResult<F extends LookupForm> {
  form: F;
  sources: FieldSources;
  /** Fields filled from the lookup. */
  applied: LookupField[];
  /** Fields where the user's value was kept although the lookup suggests another. */
  conflicts: Conflict[];
}

export const FIELD_LABELS: Record<LookupField, string> = {
  make: 'make', colour: 'colour', fuelType: 'fuel', year: 'year', engine: 'engine',
};

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const isBlank = (field: LookupField, v: unknown) => (field === 'year' ? !v : text(v).trim() === '');
const same = (a: unknown, b: unknown) => text(a).trim().toLowerCase() === text(b).trim().toLowerCase();

/**
 * Initial sources: a saved vehicle's non-blank values are the user's. A new
 * vehicle's defaults (current year, petrol) are placeholders, so a lookup may
 * replace them.
 */
export function initialSources(existing: LookupForm | null): FieldSources {
  const out = {} as FieldSources;
  for (const f of LOOKUP_FIELDS) out[f] = existing && !isBlank(f, existing[f]) ? 'user' : 'blank';
  return out;
}

/** Records that the user edited a field (so a later lookup won't replace it). */
export function markEdited(sources: FieldSources, field: string): FieldSources {
  return (LOOKUP_FIELDS as readonly string[]).includes(field) && sources[field as LookupField] !== 'user'
    ? { ...sources, [field]: 'user' }
    : sources;
}

export function mergeLookup<F extends LookupForm>(
  form: F, sources: FieldSources, registration: string, suggested: Suggestions,
): MergeResult<F> {
  const next = { ...form, registration } as F;
  const nextSources = { ...sources };
  const applied: LookupField[] = [];
  const conflicts: Conflict[] = [];
  for (const field of LOOKUP_FIELDS) {
    const value = suggested[field];
    if (value === null || value === undefined || value === '') continue;
    const current = form[field];
    if (sources[field] === 'user' && !isBlank(field, current)) {
      if (!same(current, value)) conflicts.push({ field, yours: text(current), suggested: text(value) });
      continue;
    }
    (next as Record<LookupField, unknown>)[field] = value;
    nextSources[field] = 'dvla';
    applied.push(field);
  }
  return { form: next, sources: nextSources, applied, conflicts };
}

/** The user chose to use the suggested values for the fields they had kept. */
export function acceptConflicts<F extends LookupForm>(
  form: F, sources: FieldSources, conflicts: Conflict[], suggested: Suggestions,
): { form: F; sources: FieldSources } {
  const next = { ...form };
  const nextSources = { ...sources };
  for (const { field } of conflicts) {
    const value = suggested[field];
    if (value === null || value === undefined) continue;
    (next as Record<LookupField, unknown>)[field] = value;
    nextSources[field] = 'dvla';
  }
  return { form: next, sources: nextSources };
}

/** Checked before calling the API: returns a message when the input can't be looked up. */
export function lookupInputProblem(registration: string): string | null {
  if (!registration.trim()) return 'Enter the registration first.';
  if (!parseUkRegistration(registration)) {
    return "That doesn't look like a UK registration, so it can't be looked up. You can still enter the vehicle's details yourself.";
  }
  return null;
}

/** What to tell the user when a lookup fails. Manual entry always remains possible. */
export function lookupErrorMessage(err: unknown): string {
  if (err instanceof NetworkError) {
    return "You're offline. Enter the details yourself — you can look the registration up when you're back online.";
  }
  const code = err instanceof ApiError ? err.code : '';
  switch (code) {
    case 'invalid_registration': return "DVLA doesn't recognise that registration format. Check it, or enter the details yourself.";
    case 'vehicle_not_found': return 'DVLA has no vehicle with that registration. Check for typos (0/O, 1/I), or enter the details yourself.';
    case 'rate_limited': return "You've looked up a lot of registrations just now. Try again in a minute, or enter the details yourself.";
    case 'lookup_not_configured': return "Live DVLA lookup isn't connected on this server. Enter the details yourself.";
    case 'lookup_busy':
    case 'lookup_unavailable':
    case 'lookup_timeout':
    case 'lookup_bad_response': return "DVLA's lookup isn't working right now. Enter the details yourself, or try again later.";
    default: return "The lookup didn't work. Enter the details yourself, or try again later.";
  }
}

/** Demo Mode (development builds only): test data shaped like a lookup result. */
export function demoSuggestions(demo: { make: string; colour: string; fuelType: string; year: number; engine: string }): Suggestions {
  const fuel = (['petrol', 'diesel', 'electric', 'hybrid', 'other'] as const).includes(demo.fuelType as FuelType)
    ? (demo.fuelType as FuelType) : 'other';
  return { make: demo.make, colour: demo.colour, fuelType: fuel, year: demo.year, engine: demo.engine };
}

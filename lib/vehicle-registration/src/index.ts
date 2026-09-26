/**
 * UK vehicle registration numbers (VRNs), shared by the API and the app.
 *
 * Only UK-format registrations are ever sent to the DVLA lookup. A vehicle
 * may still be saved with any registration (for example a foreign plate);
 * those are stored in compact form and simply never looked up.
 *
 * Personalised ("cherished") registrations always use one of the standard
 * formats below, so they are accepted too.
 */

export type RegistrationFormat = 'current' | 'prefix' | 'suffix' | 'dateless';

export interface UkRegistration {
  /** Upper case, no spaces or hyphens: the form DVLA expects, e.g. "AB12CDE". */
  registration: string;
  /** How it is written on the plate, e.g. "AB12 CDE". */
  display: string;
  format: RegistrationFormat;
}

/** Longest registration the vehicles table stores (compact form). */
export const MAX_STORED_REGISTRATION_LENGTH = 10;

const FORMATS: Array<{ format: RegistrationFormat; pattern: RegExp; split: (r: string) => [string, string] }> = [
  // Since 2001: two letters, two digits, three letters (AB12 CDE).
  { format: 'current', pattern: /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/, split: (r) => [r.slice(0, 4), r.slice(4)] },
  // 1983–2001: letter, 1–3 digits, three letters (A123 BCD).
  { format: 'prefix', pattern: /^[A-Z][0-9]{1,3}[A-Z]{3}$/, split: (r) => [r.slice(0, -3), r.slice(-3)] },
  // 1963–1983: three letters, 1–3 digits, letter (ABC 123D).
  { format: 'suffix', pattern: /^[A-Z]{3}[0-9]{1,3}[A-Z]$/, split: (r) => [r.slice(0, 3), r.slice(3)] },
  // Dateless and Northern Ireland: 1–3 letters and 1–4 digits, either way round (ABC 1234, 1234 AB).
  { format: 'dateless', pattern: /^[A-Z]{1,3}[0-9]{1,4}$/, split: splitLettersDigits },
  { format: 'dateless', pattern: /^[0-9]{1,4}[A-Z]{1,3}$/, split: splitLettersDigits },
];

function splitLettersDigits(r: string): [string, string] {
  const at = r.search(/[A-Z][0-9]|[0-9][A-Z]/) + 1;
  return [r.slice(0, at), r.slice(at)];
}

/** Upper case without whitespace: how a registration is stored on a vehicle. */
export function compactRegistration(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/**
 * Upper case without whitespace: "ab12 cde" → "AB12CDE". Hyphens and dots
 * are not removed: UK plates never contain them, and stripping them could
 * turn a foreign plate ("B-MW 1234") into somebody else's UK registration.
 */
export const normaliseRegistration = compactRegistration;

/**
 * Parses a UK registration, or returns null when the input is not in a UK
 * format. Look-alike characters are never swapped (O/0, I/1): guessing could
 * look up somebody else's vehicle.
 */
export function parseUkRegistration(input: string): UkRegistration | null {
  const registration = normaliseRegistration(input);
  if (!/^[A-Z0-9]{2,7}$/.test(registration)) return null;
  for (const f of FORMATS) {
    if (f.pattern.test(registration)) {
      const [a, b] = f.split(registration);
      return { registration, display: `${a} ${b}`, format: f.format };
    }
  }
  return null;
}

export const isUkRegistration = (input: string): boolean => parseUkRegistration(input) !== null;

/** How a registration is stored on a vehicle; for a UK plate this is DVLA's form. */
export const storedRegistration = compactRegistration;

/** Plate-style spacing for UK registrations; anything else (e.g. with a hyphen) is shown as stored. */
export function displayRegistration(input: string): string {
  const stored = compactRegistration(input);
  return /^[A-Z0-9]+$/.test(stored) ? parseUkRegistration(stored)?.display ?? stored : stored;
}

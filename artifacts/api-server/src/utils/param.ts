/**
 * Normalise an Express 5 route param from `string | string[]` to `string`.
 * Express 5 types route params as `string | string[]`; passing them directly
 * to Drizzle's `eq()` produces a TS2769 error.  Call `param(req.params.xxx)`
 * to extract the first (and only) string value safely.
 */
export function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

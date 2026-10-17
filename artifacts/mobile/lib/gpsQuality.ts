// How good the drive's GPS is right now, for the recording screen's GPS chip,
// from the newest fix the Drive screen accepted (its horizontal accuracy and
// how long ago it arrived) and whether location is live at all.
//
// iOS reports horizontal accuracy in metres (CLLocation.horizontalAccuracy, a
// 68% radius): open-sky GPS is typically 3-10 m, built-up areas 10-30 m, and
// past ~50 m positions wander. Fixes worse than the Drive screen's own limit
// (120 m) are never accepted, so they show here as the fix going stale.
// Updates arrive about once a second while driving (timeInterval 1000).
//
// No React Native imports, so it is unit-tested under node.

export type GpsLevel = 'excellent' | 'strong' | 'fair' | 'weak' | 'lost';

export const GPS_QUALITY = {
  /** Accuracy (m) at or under which a fresh fix is Excellent */
  excellentM: 8,
  /** ...Strong */
  strongM: 20,
  /** ...Fair; anything vaguer (up to the 120 m acceptance limit) is Weak */
  fairM: 50,
  /** A fix older than this (ms) is stale: at best Weak */
  staleMs: 8_000,
  /** No accepted fix for this long (ms): Lost */
  lostMs: 20_000,
  /** How often the chip re-checks a fix that stopped coming (ms) */
  recheckMs: 1_000,
} as const;

export interface GpsQuality {
  level: GpsLevel;
  /** 0-4 */
  bars: number;
  label: string;
}

const QUALITY: Record<GpsLevel, GpsQuality> = {
  excellent: { level: 'excellent', bars: 4, label: 'Excellent' },
  strong: { level: 'strong', bars: 3, label: 'Strong' },
  fair: { level: 'fair', bars: 2, label: 'Fair' },
  weak: { level: 'weak', bars: 1, label: 'Weak' },
  lost: { level: 'lost', bars: 0, label: 'Lost' },
};

export function gpsQuality(input: {
  /** 'simulated' when location is off or not allowed */
  locationMode: 'live' | 'simulated';
  /** The newest accepted fix, or null before the first */
  fix: { accuracyM: number | null; timestamp: number } | null;
  now: number;
}): GpsQuality {
  const { locationMode, fix, now } = input;
  if (locationMode !== 'live' || !fix || !Number.isFinite(fix.timestamp)) return QUALITY.lost;
  const age = now - fix.timestamp;
  if (!(age <= GPS_QUALITY.lostMs)) return QUALITY.lost;
  if (age > GPS_QUALITY.staleMs) return QUALITY.weak;
  const acc = fix.accuracyM;
  // A fresh fix without an accuracy figure: usable, but unknown quality
  if (acc == null || !Number.isFinite(acc) || acc < 0) return QUALITY.fair;
  if (acc <= GPS_QUALITY.excellentM) return QUALITY.excellent;
  if (acc <= GPS_QUALITY.strongM) return QUALITY.strong;
  if (acc <= GPS_QUALITY.fairM) return QUALITY.fair;
  return QUALITY.weak;
}

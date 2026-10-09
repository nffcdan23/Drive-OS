// Figures for the Drive Complete rewards card: progress to the next level,
// the run of days with a drive, and the name to greet the driver by.
// Kept free of React Native imports so they can be unit-tested under node.

/** XP per level: the server's curve (private.level_for_xp; XP_PER_LEVEL in the API's me route). */
export const LEVEL_XP = 1000;

/**
 * Where the driver is within their level, from the profile's total XP and the
 * XP still needed for the next level (both server values).
 */
export function levelProgress(xp: number, xpToNextLevel: number): {
  fraction: number;
  xp: number;
  nextLevelXp: number;
} {
  const total = Math.max(0, Math.round(xp));
  const toNext = Math.min(LEVEL_XP, Math.max(0, Math.round(xpToNextLevel)));
  return {
    fraction: (LEVEL_XP - toNext) / LEVEL_XP,
    xp: total,
    nextLevelXp: total + toNext,
  };
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Consecutive days, ending today (or yesterday, before today's first drive),
 * with at least one drive, counted in the phone's time zone.
 */
export function dayStreak(driveStarts: readonly (string | null | undefined)[], now: Date = new Date()): number {
  const days = new Set<string>();
  for (const iso of driveStarts) {
    const t = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isFinite(t)) days.add(localDay(new Date(t)));
  }
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(localDay(day))) day.setDate(day.getDate() - 1);
  let streak = 0;
  while (days.has(localDay(day))) {
    streak++;
    day.setDate(day.getDate() - 1);
  }
  return streak;
}

/**
 * The first word of the profile's name, or undefined when there's no real
 * name yet (the placeholder profile shown before the account loads has no id).
 */
export function firstNameOf(profile: { id?: string; name?: string | null } | null | undefined): string | undefined {
  if (!profile?.id) return undefined;
  const first = (profile.name ?? "").trim().split(/\s+/)[0];
  return first || undefined;
}

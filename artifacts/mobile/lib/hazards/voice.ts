// Spoken hazard warnings during navigation: one short sentence ("Accident
// ahead in half a mile") when the driver is genuinely approaching a reported
// hazard on their route.
//
// Which hazard, and whether it matters, is decided by the warning engine
// (warnings.ts: on the route, ahead, the right direction, within the warning
// distance, guidance confident). This only speaks its result: the hazard the
// warning pill shows. Nothing here judges relevance again, so a hazard the
// engine rejects (the opposite carriageway, behind, off the route) can never
// be spoken.
//
// When: as the engine's warning comes up for a hazard, once per hazard per
// navigation. Spoken, it is never said again in that navigation: not for GPS
// jitter, a Realtime confirmation, Realtime reconnecting and reloading the
// hazards, the app going off screen and back, or a reroute that matches it
// again. A new navigation starts afresh (in memory only; nothing is stored).
//
// A warning waits (queued, never in the speaker) while:
//  - anything else is being said, and briefly after it;
//  - a turn is close: the car is at the manoeuvre (or on its roundabout), or
//    a turn prompt (preparation or immediate) is due within a few seconds or
//    was just due. Advance prompts ("In 2 miles…") rank below hazards;
//  - another hazard was spoken less than HAZARD_VOICE.cooldownMs ago.
// A waiting warning is dropped when the engine stops showing it (passed,
// expired, removed by votes, off the route, rerouted away, a nearer hazard
// took over, GPS not good enough), when navigation arrives or ends, and
// when it has become stale (too close to be useful, or waiting too long).
// Dropped for staleness it isn't said later; otherwise it may come back if
// the engine shows it again.
//
// It speaks through navigation's own voice (lib/navigation/voice.ts) and
// speaker (audioSession.ts): the same audio session, ducking and release,
// the same Off / mute, the same off-screen behaviour. Hazard warnings count
// as alerts: spoken in Normal and Alerts only. Not in Free Drive: the engine
// only warns on a route.
//
// Diagnostics: what happened, the hazard kind, a distance bucket and a
// reason. Never the sentence, the hazard, a position, a heading, a road or
// the destination.
//
// No React Native imports, so it is unit-tested under node.

import { promptKind, type HazardSpeechBlock } from '../navigation/voice';
import type { RouteProgress } from '../navigation/routeProgress';
import type { NavigationState } from '../navigation/session';
import { distanceBucket, type HazardWarning } from './warnings';

export const HAZARD_VOICE = {
  /** At least this long between two hazard warnings (ms): about half the time a town warning takes to reach its hazard */
  cooldownMs: 25_000,
  /** A warning not said within this long of first showing (ms) is out of date: skipped, not said later */
  maxWaitMs: 30_000,
  /** Too close to be worth saying (m), or fewer than this many seconds away */
  minUsefulM: 100,
  minUsefulS: 5,
  /** At the manoeuvre (m): the turn has the driver's attention */
  nearTurnM: 100,
  /** A turn prompt due within this many seconds (at least this many m) holds a warning back */
  turnClearS: 8,
  turnClearMinM: 80,
  /** A turn prompt due this recently (s, at least m) is being said, or about to be */
  turnJustDueS: 3,
  turnJustDueMinM: 30,
  /** Quiet after anything else is said (ms) */
  quietGapMs: 1_500,
  /** Distances and times are worked out at no less than this speed (m/s): slow traffic still moves */
  minSpeedMs: 8,
  /** Below this (m) the sentence has no distance */
  distanceFromM: 50,
  /** Diagnostics per navigation (the journal is shared) */
  maxLogs: 40,
} as const;

/** What is said for each kind: short, neutral, never the report's age, confirmations, place or reporter */
export const HAZARD_SPOKEN: Readonly<Record<string, string>> = {
  accident: 'Accident ahead',
  hazard: 'Hazard ahead',
  broken_down: 'Broken-down vehicle ahead',
  roadworks: 'Roadworks ahead',
  flooding: 'Flooding ahead',
  police: 'Police reported ahead',
};

/** The words for a hazard kind; a kind this version doesn't know is a hazard */
export const hazardPhrase = (kind: string): string =>
  Object.prototype.hasOwnProperty.call(HAZARD_SPOKEN, kind) ? HAZARD_SPOKEN[kind]! : HAZARD_SPOKEN.hazard!;

const M_PER_YARD = 0.9144;
const M_PER_MILE = 1_609.344;

/**
 * A distance as navigation says it (British imperial, as Mapbox's own
 * prompts): yards to the nearest 50, then 100; then half a mile, three
 * quarters of a mile, 1 mile, 1 and a half miles, whole miles. Null when
 * too close for a distance to help.
 */
export function spokenDistance(metres: number): string | null {
  if (!Number.isFinite(metres) || metres < HAZARD_VOICE.distanceFromM) return null;
  const yards = metres / M_PER_YARD;
  if (yards < 300) return `${Math.max(50, Math.round(yards / 50) * 50)} yards`;
  if (yards < 850) return `${Math.round(yards / 100) * 100} yards`;
  const miles = metres / M_PER_MILE;
  if (miles < 0.625) return 'half a mile';
  if (miles < 0.875) return 'three quarters of a mile';
  if (miles < 1.25) return '1 mile';
  if (miles < 1.75) return '1 and a half miles';
  return `${Math.round(miles)} miles`;
}

/** "Accident ahead in half a mile": the kind, and how far, once */
export function hazardSentence(kind: string, distanceAheadM: number): string {
  const d = spokenDistance(distanceAheadM);
  return d ? `${hazardPhrase(kind)} in ${d}` : hazardPhrase(kind);
}

/**
 * Whether a turn has the driver's attention at `p` (moving at `speedMs`):
 * at the manoeuvre or on its roundabout, or one of its turn prompts
 * (preparation, immediate) due within a few seconds or just due.
 */
export function turnIsClose(p: RouteProgress, speedMs: number): boolean {
  const V = HAZARD_VOICE;
  if (p.onRoundabout || p.distanceToNextM <= V.nearTurnM) return true;
  const ahead = Math.max(V.turnClearMinM, speedMs * V.turnClearS);
  const behind = Math.max(V.turnJustDueMinM, speedMs * V.turnJustDueS);
  const prompts = p.next.voice;
  return prompts.some((prompt, j) => {
    if (promptKind(j, prompts.length) === 'advance') return false;
    const gap = p.distanceToNextM - prompt.distanceBeforeM;
    return gap <= ahead && gap >= -behind;
  });
}

/** Navigation's voice, as hazard warnings use it (VoiceGuidance in the app) */
export interface HazardSpeechOutput {
  /** Why a warning can't be heard now (Off, muted, or off screen where speech can't play), or null */
  blocked(): HazardSpeechBlock | 'unavailable' | null;
  /** Something is being said */
  busy(): boolean;
  /** Says it; false if it wasn't taken */
  say(text: string): boolean;
}

export type HazardVoiceAction = 'queued' | 'held' | 'spoken' | 'skipped' | 'cancelled' | 'suppressed';

export interface HazardVoiceDeps {
  out: HazardSpeechOutput;
  /** Diagnostics: the action, the kind, a distance bucket and a reason only */
  log?: (action: HazardVoiceAction, data: { kind: string; distance?: string; reason?: string }) => void;
}

export interface HazardVoiceInput {
  state: NavigationState;
  /** The warning engine's current warning (warnings.ts) */
  warning: HazardWarning | null;
  /** The newest fix's speed (m/s), if known */
  speedMs: number | null;
  now: number;
}

type Hold = 'speech' | 'turn' | 'cooldown';

interface Waiting {
  hazardId: string;
  kind: string;
  distanceAheadM: number;
  heldFor: Hold | null;
  /** A turn held it at some point */
  heldByTurn: boolean;
}

export class HazardVoice {
  private sessionId: number | null = null;
  private route: unknown = null;
  /** Spoken, skipped as stale, or suppressed: never said in this navigation */
  private done = new Set<string>();
  /** When each hazard first came up for speech (staleness counts from then) */
  private firstUp = new Map<string, number>();
  private waiting: Waiting | null = null;
  private lastSpokenAt = -Infinity;
  private lastBusyAt = -Infinity;
  private logs = 0;
  /** Warnings spoken (for tests and diagnostics) */
  spoken = 0;

  constructor(private readonly deps: HazardVoiceDeps) {}

  /** Called after every warning recompute (each fix, reroute and hazard change): cheap, no timers */
  update(input: HazardVoiceInput): void {
    const s = input.state;
    if (s.phase === 'idle') {
      if (this.sessionId != null) this.reset(null, 'ended');
      return;
    }
    if (s.sessionId !== this.sessionId) this.reset(s.sessionId, 'ended');
    if (s.phase === 'arrived' || s.phase === 'error') {
      // Nothing after "You have arrived"
      this.drop(s.phase === 'arrived' ? 'arrived' : 'ended');
      return;
    }
    if (s.route !== this.route) {
      // A reroute: what was waiting belonged to the old route (spoken ones stay spoken)
      if (this.route != null) this.drop('reroute');
      this.route = s.route;
    }
    if (this.deps.out.busy()) this.lastBusyAt = input.now;

    const w = input.warning;
    if (this.waiting && this.waiting.hazardId !== w?.hazardId) this.drop(w ? 'superseded' : 'not_relevant');
    if (!w || this.done.has(w.hazardId)) return;
    if (!this.waiting) {
      if (!this.firstUp.has(w.hazardId)) this.firstUp.set(w.hazardId, input.now);
      this.waiting = { hazardId: w.hazardId, kind: w.kind, distanceAheadM: w.distanceAheadM, heldFor: null, heldByTurn: false };
      this.log('queued', { kind: w.kind, distance: distanceBucket(w.distanceAheadM) });
    }
    this.waiting.distanceAheadM = w.distanceAheadM;
    this.attempt(w, s.progress, input);
  }

  private attempt(w: HazardWarning, progress: RouteProgress | null, input: HazardVoiceInput) {
    const V = HAZARD_VOICE;
    const q = this.waiting!;
    const blocked = this.deps.out.blocked();
    if (blocked) {
      // Off, muted, or off screen where speech can't play: not said, and not caught up later
      this.settle('suppressed', blocked);
      return;
    }
    const v = Math.max(input.speedMs ?? 0, V.minSpeedMs);
    const tooClose = w.distanceAheadM < Math.max(V.minUsefulM, v * V.minUsefulS);
    const stale = input.now - (this.firstUp.get(w.hazardId) ?? input.now) > V.maxWaitMs;
    if (tooClose || stale) {
      this.settle('skipped', q.heldByTurn ? 'turn' : tooClose ? 'too_close' : 'stale');
      return;
    }
    if (!progress) return;
    const hold: Hold | null =
      this.deps.out.busy() || input.now - this.lastBusyAt < V.quietGapMs ? 'speech'
        : turnIsClose(progress, v) ? 'turn'
          : input.now - this.lastSpokenAt < V.cooldownMs ? 'cooldown'
            : null;
    if (hold) {
      if (hold === 'turn') q.heldByTurn = true;
      if (q.heldFor !== hold) {
        q.heldFor = hold;
        this.log('held', { kind: q.kind, distance: distanceBucket(w.distanceAheadM), reason: hold });
      }
      return;
    }
    if (!this.deps.out.say(hazardSentence(w.kind, w.distanceAheadM))) {
      // Not taken (something started meanwhile): tried again on the next update
      this.lastBusyAt = input.now;
      return;
    }
    this.spoken++;
    this.lastSpokenAt = input.now;
    this.settle('spoken');
  }

  /** The waiting warning is finished with for this navigation */
  private settle(action: 'spoken' | 'skipped' | 'suppressed', reason?: string) {
    const q = this.waiting!;
    this.done.add(q.hazardId);
    this.waiting = null;
    this.log(action, { kind: q.kind, distance: distanceBucket(q.distanceAheadM), ...(reason ? { reason } : {}) });
  }

  /** Cancels a waiting warning (it may come up again if the engine shows it again) */
  private drop(reason: string) {
    const q = this.waiting;
    if (!q) return;
    this.waiting = null;
    this.log('cancelled', { kind: q.kind, distance: distanceBucket(q.distanceAheadM), reason });
  }

  private reset(sessionId: number | null, reason: string) {
    this.drop(reason);
    this.sessionId = sessionId;
    this.route = null;
    this.done.clear();
    this.firstUp.clear();
    this.lastSpokenAt = -Infinity;
    this.lastBusyAt = -Infinity;
    this.logs = 0;
  }

  private log(action: HazardVoiceAction, data: { kind: string; distance?: string; reason?: string }) {
    if (this.logs >= HAZARD_VOICE.maxLogs) return;
    this.logs++;
    this.deps.log?.(action, { ...data, kind: data.kind.slice(0, 24) });
  }
}

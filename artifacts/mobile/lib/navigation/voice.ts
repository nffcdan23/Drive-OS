// Foreground voice guidance (Navigation Phase 4): speaks Mapbox's own en-GB
// voice instructions while guidance runs, at the distances Mapbox gives.
//
// It only reads the navigation session (state and progress). It never feeds
// back into navigation, recording, rerouting, sharing or presence.
//
// Where the words come from: each manoeuvre's `voice` prompts, kept from the
// Directions response's voiceInstructions (announcement, and
// distanceAlongGeometry: how far before the manoeuvre to start speaking).
// Mapbox writes them in British English with yards and miles
// (voice_units=british_imperial) and its own roundabout exit wording. They
// are spoken as they are. Derwent's own words are only "Updating route", and
// "You have arrived" when Mapbox gave no arrival prompt.
//
// When: a prompt is due once the distance to its manoeuvre (from route
// progress, not the banner) is at or under its distance. Usually there are
// three per manoeuvre: advance (farthest), preparation, and immediate
// (nearest). Each prompt is spoken at most once per route, keyed by session,
// route, step and prompt. GPS jitter, going slightly backwards, the camera,
// other tabs: none of them can replay one, because a prompt is marked as
// spoken (or passed) for good. When several are due at once (a gap in fixes,
// a fresh route), only the nearest is spoken, and only if it still makes
// sense where the car is now.
//
// A new route (an automatic reroute) cancels anything still queued from the
// old one and starts tracking afresh for the new one. Off route: "Updating
// route", once per time off route (and not again within a minute); the old
// route's prompts stop. Arrival: once.
//
// Off screen: where the speaker can play with the app in the background or
// the phone locked (backgroundSpeech: iOS with its audio session,
// audioSession.ts; Android), prompts carry on exactly as on screen: the
// same thresholds, once each, the same reroute and arrival handling. Being
// off screen silences nothing there; an interruption (a call, Siri) only
// loses the prompts it covered, which are never replayed. Where the speaker
// can't (an app build without the audio session), it stays foreground only:
// leaving the foreground cancels speech and nothing is queued while away;
// coming back, prompts passed meanwhile are marked as done silently, only
// the prompt at the next manoeuvre is said, and only if the car still hasn't
// reached it. Then those still ahead, as usual.
//
// The diagnostics journal gets step numbers, prompt kinds and reasons only:
// never the sentence, a road, the destination or a position.
//
// No React Native imports, so it is unit-tested under node.

import type { Journal } from '../backend/journal';
import type { Maneuver, VoicePrompt } from './maneuver';
import type { NavigationSession, NavigationState } from './session';

export type VoiceMode = 'normal' | 'alerts' | 'off';

/** The speech engine (expo-speech in the app, a fake in tests) */
export interface Speaker {
  speak(text: string): void;
  /** Stop speaking now and drop anything queued */
  stop(): void;
}

export type PromptKind = 'advance' | 'preparation' | 'immediate';

export const VOICE = {
  /** A due prompt overshot by more than this (m, or this share of its distance) is out of date: passed silently */
  staleMinM: 150,
  staleShare: 0.25,
  /** The arrive prompt this close (m) is kept for the confirmed arrival */
  arrivalPromptWithinM: 60,
  /** Coming back: the prompt at the next manoeuvre is still worth saying this far (m) or more before it */
  relevantWithinM: 15,
  /** "Updating route" at most once in this long (ms) */
  offRouteGapMs: 60_000,
  /** Prompts logged per session (the journal is shared) */
  maxLogs: 80,
  arrived: 'You have arrived',
  updating: 'Updating route',
} as const;

/** advance / preparation / immediate, from a prompt's place among its manoeuvre's (farthest first) */
export function promptKind(index: number, count: number): PromptKind {
  if (index >= count - 1) return 'immediate';
  return index === 0 && count >= 3 ? 'advance' : 'preparation';
}

/** The prompts progress may trigger for `m` (the arrival one is kept for the confirmed arrival) */
function triggerable(m: Maneuver): readonly VoicePrompt[] {
  const v = m.voice;
  if (m.kind === 'arrive' && v.length && v[v.length - 1]!.distanceBeforeM <= VOICE.arrivalPromptWithinM) return v.slice(0, -1);
  return v;
}

export interface VoiceGuidanceDeps {
  session: NavigationSession;
  speaker: Speaker;
  now(): number;
  journal?: Journal;
}

export class VoiceGuidance {
  private mode: VoiceMode = 'normal';
  private foreground = true;
  /** The speaker can play off screen: being in the background silences nothing */
  private backgroundSpeech = false;
  /** Coming back to the foreground: prompts already passed are marked, not spoken */
  private silentCatchUp = false;
  /** Prompts spoken or passed, for the route below */
  private done = new Set<string>();
  /** Of those, the ones passed without a word (off screen, or muted) */
  private quiet = new Set<string>();
  private route: unknown = null;
  private routeKey = '';
  private sessionId: number | null = null;
  private phase: NavigationState['phase'] = 'idle';
  /** When "Updating route" was last said */
  private lastOffAt = -Infinity;
  private arrivedFor: number | null = null;
  /** Mapbox's arrival prompt for the current route, if any */
  private arrivalText: string | null = null;
  private logs = 0;
  private unsubscribe: (() => void) | null = null;
  /** Prompts spoken (for tests and diagnostics) */
  spoken = 0;

  constructor(private readonly deps: VoiceGuidanceDeps) {}

  /** Starts following the session */
  attach(): () => void {
    this.unsubscribe?.();
    const off = this.deps.session.subscribe(() => this.update());
    this.unsubscribe = () => off();
    this.update();
    return () => this.detach();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deps.speaker.stop();
  }

  get currentMode(): VoiceMode {
    return this.mode;
  }

  /** The user's choice (settings, or the mute button): off stops speech at once */
  setMode(mode: VoiceMode): void {
    if (mode === this.mode) return;
    const was = this.mode;
    this.mode = mode;
    this.log('nav_voice', { state: mode === 'off' ? 'disabled' : 'enabled', mode });
    if (mode === 'off') {
      this.cancel('muted');
    } else if (was === 'off') {
      // Back on: from here on, not what passed while muted
      this.catchUpSilently();
    }
  }

  /** Whether the speaker can play with the app off screen (set once, from the speaker) */
  setBackgroundSpeech(capable: boolean): void {
    this.backgroundSpeech = capable;
  }

  /** The app came to the foreground, or left it */
  setForeground(live: boolean): void {
    if (live === this.foreground) return;
    this.foreground = live;
    // Spoken off screen too: nothing to stop, nothing to catch up
    if (this.backgroundSpeech) return;
    if (!live) {
      this.cancel('background');
    } else {
      this.catchUpSilently();
    }
  }

  /**
   * Marks the prompts already passed as done, without a word; then says the
   * prompt at the next manoeuvre if it was passed quietly and the car still
   * hasn't reached it.
   */
  private catchUpSilently() {
    this.silentCatchUp = true;
    try {
      this.update();
    } finally {
      this.silentCatchUp = false;
    }
    this.sayCurrentIfStillRelevant();
  }

  private sayCurrentIfStillRelevant() {
    const s = this.deps.session.state;
    if (!this.speaking() || (s.phase !== 'navigating' && s.phase !== 'starting')) return;
    const p = s.progress;
    if (!p || p.onRoundabout || s.gps === 'lost') return;
    const prompts = triggerable(p.next);
    const j = prompts.length - 1;
    if (j < 0 || promptKind(j, p.next.voice.length) !== 'immediate') return;
    const key = this.keyOf(p.next.stepIndex, j);
    if (!this.quiet.has(key)) return;
    if (p.distanceToNextM < VOICE.relevantWithinM || p.distanceToNextM > prompts[j]!.distanceBeforeM) return;
    this.quiet.delete(key);
    this.say(prompts[j]!.text);
    this.logPrompt({ action: 'spoken', step: p.next.stepIndex, prompt: j, kind: 'immediate', maneuver: p.next.kind, late: true });
  }

  private keyOf(step: number, prompt: number) {
    return `${this.routeKey}|${step}|${prompt}`;
  }

  private log(event: string, data: Record<string, string | number | boolean | null>) {
    this.deps.journal?.log(event, data);
  }

  private cancel(reason: 'muted' | 'background' | 'reroute' | 'ended' | 'off_route') {
    this.deps.speaker.stop();
    if (this.sessionId != null) this.log('nav_voice', { action: 'cancelled', reason });
  }

  private say(text: string): void {
    try {
      this.deps.speaker.speak(text);
      this.spoken++;
    } catch {
      this.log('nav_voice', { action: 'error', code: 'speak_failed' });
    }
  }

  /** The speech engine reported an error (never the text) */
  noteSpeechError(code: string): void {
    this.log('nav_voice', { action: 'error', code: code.slice(0, 40) });
  }

  private speaking(): boolean {
    return this.mode !== 'off' && (this.foreground || this.backgroundSpeech);
  }

  /** Called on every session change (fixes, phases, routes): cheap, no timers */
  update(): void {
    const s = this.deps.session.state;
    const prevPhase = this.phase;
    this.phase = s.phase;

    if (s.phase === 'idle') {
      if (this.sessionId != null) {
        // Ended: stop, unless it's the arrival being spoken as navigation hands over to Drive Complete
        if (prevPhase !== 'arrived') this.cancel('ended');
        this.sessionId = null;
        this.route = null;
        this.done.clear();
        this.quiet.clear();
      }
      return;
    }

    if (s.sessionId !== this.sessionId) {
      // A new navigation
      if (this.sessionId != null) this.cancel('ended');
      this.sessionId = s.sessionId;
      this.route = null;
      this.done.clear();
      this.quiet.clear();
      this.arrivedFor = null;
      this.logs = 0;
    }

    if (s.phase === 'arrived') {
      if (this.arrivedFor !== s.sessionId) {
        this.arrivedFor = s.sessionId;
        if (this.speaking()) {
          this.say(this.arrivalText ?? VOICE.arrived);
          this.logPrompt({ action: 'arrived' });
        }
      }
      return;
    }
    if (s.phase === 'error') return;

    // A new route (the first, a fresh one at the start, or a reroute):
    // anything still queued belongs to the old one
    const offRoute = (phase: NavigationState['phase']) => phase === 'offRoute' || phase === 'rerouting';
    if (s.route !== this.route) {
      const replaced = this.route != null;
      this.route = s.route;
      this.routeKey = `${s.sessionId}|${s.route.routeId}`;
      this.done.clear();
      this.quiet.clear();
      this.arrivalText = arrivalPrompt(s.route);
      // Anything still queued for the old route goes (off route, it already went: "Updating route" may finish)
      if (replaced && !offRoute(prevPhase)) this.cancel('reroute');
    }

    if (offRoute(s.phase)) {
      if (!offRoute(prevPhase)) {
        // The old route's prompts are wrong now
        this.cancel('off_route');
        const now = this.deps.now();
        if (this.speaking() && now - this.lastOffAt >= VOICE.offRouteGapMs) {
          this.lastOffAt = now;
          this.say(VOICE.updating);
          this.logPrompt({ action: 'off_route' });
        }
      }
      return;
    }

    const p = s.progress;
    if (!p || s.gps === 'lost') return;
    this.consider(p.next, p.distanceToNextM, p.onRoundabout);
  }

  private consider(next: Maneuver, distanceM: number, onRoundabout: boolean) {
    const prompts = triggerable(next);
    if (!prompts.length) return;
    const key = (j: number) => this.keyOf(next.stepIndex, j);
    // Circulating a roundabout: its own prompts are behind the car
    if (onRoundabout) {
      for (let j = 0; j < prompts.length; j++) this.done.add(key(j));
      return;
    }
    // The prompts now due and not yet spoken; the nearest of them is the one to say
    let due = -1;
    for (let j = 0; j < prompts.length; j++) {
      if (this.done.has(key(j))) continue;
      if (distanceM <= prompts[j]!.distanceBeforeM) due = j;
    }
    if (due < 0) return;
    for (let j = 0; j <= due; j++) this.done.add(key(j));
    const prompt = prompts[due]!;
    if (!this.speaking()) {
      // Passed without a word: remembered, so coming back can still say the turn itself if it's ahead
      this.quiet.add(key(due));
      return;
    }
    // Coming back (or unmuted): nothing that was passed (see sayCurrentIfStillRelevant)
    if (this.silentCatchUp) {
      this.quiet.add(key(due));
      return;
    }
    const kind = promptKind(due, next.voice.length);
    if (this.mode === 'alerts' && kind !== 'immediate') return;
    // Overshot by far (a gap in fixes): "in 400 yards" would be wrong now, unless it's the last word before the turn
    const overshoot = prompt.distanceBeforeM - distanceM;
    if (kind !== 'immediate' && overshoot > Math.max(VOICE.staleMinM, prompt.distanceBeforeM * VOICE.staleShare)) return;
    this.say(prompt.text);
    this.logPrompt({ action: 'spoken', step: next.stepIndex, prompt: due, kind, maneuver: next.kind });
  }

  private logPrompt(data: Record<string, string | number | boolean | null>) {
    if (this.logs >= VOICE.maxLogs) return;
    this.logs++;
    this.log('nav_voice', data);
  }
}

/** Mapbox's arrival prompt (kept for the confirmed arrival), if it gave one */
function arrivalPrompt(route: { legs: ReadonlyArray<{ steps: ReadonlyArray<{ maneuver: { type: string }; voice: ReadonlyArray<VoicePrompt> }> }> }): string | null {
  const steps = route.legs.flatMap((l) => l.steps);
  const last = steps.length - 1;
  if (last < 1 || steps[last]!.maneuver.type !== 'arrive') return null;
  const v = [...steps[last - 1]!.voice].sort((a, b) => b.distanceBeforeM - a.distanceBeforeM);
  const nearest = v[v.length - 1];
  return nearest && nearest.distanceBeforeM <= VOICE.arrivalPromptWithinM ? nearest.text : null;
}

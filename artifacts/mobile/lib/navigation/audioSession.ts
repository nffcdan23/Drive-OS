// The audio side of voice guidance (Navigation background voice): makes each
// spoken prompt safe to play on screen, off screen and with the phone
// locked, over music or a podcast. It only plays what the voice engine
// (voice.ts) hands it; when and what to say stays there.
//
// iOS, with the audio session (expo-audio):
//   - set up once, before the first prompt: Playback, ducking other audio,
//     allowed in the background (the "audio" background mode), and so not
//     silenced by the silent switch, like a sat-nav;
//   - for each prompt: activate the session (other audio ducks), speak on it,
//     and deactivate it shortly after the last word, telling other apps they
//     may come back up to volume. It is never left active between prompts;
//   - one prompt at a time: a prompt that comes while another is being
//     spoken waits for it (only the newest waits; an older waiting one is
//     replaced), and stop() (a reroute, mute, the end of navigation) drops
//     both;
//   - a prompt that never finishes (a call or Siri took the audio) is ended
//     by a watchdog. After any prompt that didn't finish normally, the
//     session is released again a few times over the next twenty minutes,
//     because iOS (through expo-audio) may re-activate it when the
//     interruption ends, which would leave other audio ducked.
//
// Without the session (Android, which has no such ducking for speech, or an
// app build without the module) prompts are spoken as before.
//
// The diagnostics journal gets what happened (activated, released, started,
// interrupted, resumed, failed) and whether the app was on screen: never the
// words.
//
// No React Native imports, so it is unit-tested under node.

import type { Journal } from '../backend/journal';
import type { Speaker } from './voice';

/** The speech engine (expo-speech in the app) */
export interface SpeechEngine {
  /** Speaks `text`; exactly one of done / stopped / error follows (start may come first) */
  speak(text: string, appSession: boolean, events: SpeechEvents): void;
  stop(): void;
}

export interface SpeechEvents {
  onStart(): void;
  onDone(): void;
  onStopped(): void;
  onError(): void;
}

/** The app's audio session (expo-audio on iOS) */
export interface AudioSessionControl {
  /** Playback, duck others, play in the background (once) */
  configure(): Promise<void>;
  setActive(active: boolean): Promise<void>;
}

export const AUDIO = {
  /** After the last word, release the session this much later (ms): a prompt right behind reuses it */
  releaseDelayMs: 400,
  /** A prompt that hasn't finished after this long is taken as cut off (ms): a floor, plus per character, up to a cap */
  watchdogMinMs: 6_000,
  watchdogPerCharMs: 120,
  watchdogMaxMs: 20_000,
  /** After a prompt that didn't finish normally, release the session again at these times (ms) */
  sweepAfterMs: [30_000, 120_000, 300_000, 600_000, 1_200_000],
} as const;

export interface NavigationSpeakerDeps {
  engine: SpeechEngine;
  /** null: no app audio session here (Android, or a build without the module) */
  session: AudioSessionControl | null;
  /** Whether prompts may be spoken off screen */
  background: boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  journal?: Journal;
}

type State = 'idle' | 'activating' | 'speaking';

export class NavigationSpeaker implements Speaker {
  private state: State = 'idle';
  /** The prompt being spoken; callbacks for any other are ignored */
  private utterance = 0;
  private pending: string | null = null;
  private configured = false;
  /** The session couldn't be set up at all: speak on the system's own, as before */
  private sessionUnusable = false;
  private active = false;
  private releaseTimer: unknown = null;
  private watchdog: unknown = null;
  private sweeps: unknown[] = [];
  /** The last prompt was cut off: the next one that finishes is "resumed" */
  private wasInterrupted = false;
  private appActive = true;

  constructor(private readonly deps: NavigationSpeakerDeps) {}

  /** Whether prompts can be spoken with the app off screen */
  get background(): boolean {
    return this.deps.background;
  }

  /** Being spoken (or about to be) right now */
  get busy(): boolean {
    return this.state !== 'idle';
  }

  private log(action: string, data: Record<string, string | number | boolean | null> = {}) {
    this.deps.journal?.log('nav_audio', { action, onScreen: this.appActive, ...data });
  }

  /** The app's state: coming back on screen releases a session left active by an interruption */
  setAppState(state: string): void {
    const active = state === 'active';
    if (active === this.appActive) return;
    this.appActive = active;
    if (active && this.state === 'idle') void this.release(true);
  }

  speak(text: string): void {
    if (this.state !== 'idle') {
      // One at a time: this waits for the prompt being spoken (an older waiting one is out of date)
      if (this.pending != null) this.log('replaced');
      this.pending = text;
      return;
    }
    void this.start(text);
  }

  /** Stop speaking now and drop anything waiting (reroute, mute, end of navigation) */
  stop(): void {
    this.pending = null;
    if (this.state === 'idle') return;
    this.utterance++;
    this.clearWatchdog();
    this.state = 'idle';
    try {
      this.deps.engine.stop();
    } catch {
      // Nothing playing
    }
    this.scheduleRelease();
  }

  private async start(text: string): Promise<void> {
    const id = ++this.utterance;
    this.state = 'activating';
    this.cancelRelease();
    const session = this.sessionUnusable ? null : this.deps.session;
    if (session) {
      if (!this.configured) {
        try {
          await session.configure();
          this.configured = true;
        } catch {
          // Never set up: speak on the system's own session (as before), not in silence
          this.sessionUnusable = true;
          this.log('failed', { stage: 'configure' });
        }
      }
      if (this.configured && !this.active) {
        try {
          await session.setActive(true);
          this.active = true;
          this.log('activated');
        } catch {
          // A call or Siri has the audio: this prompt is lost, not kept for later
          this.log('failed', { stage: 'activate' });
          if (id === this.utterance) this.finishFailed();
          return;
        }
      }
    }
    // Stopped while the session was coming up: let it go again
    if (id !== this.utterance) {
      // (stop() made it idle meanwhile; a newer prompt may have started since)
      if (!this.busy) this.scheduleRelease();
      return;
    }
    this.state = 'speaking';
    this.armWatchdog(id, text.length);
    const events: SpeechEvents = {
      onStart: () => { if (id === this.utterance) this.log('started'); },
      onDone: () => this.finished(id, 'done'),
      onStopped: () => this.finished(id, 'stopped'),
      onError: () => this.finished(id, 'error'),
    };
    try {
      this.deps.engine.speak(text, !!session && this.configured, events);
    } catch {
      this.finished(id, 'error');
    }
  }

  private finishFailed() {
    this.state = 'idle';
    this.pending = null;
    this.wasInterrupted = true;
    this.armSweeps();
    this.scheduleRelease();
  }

  /** The engine says the prompt `id` ended */
  private finished(id: number, how: 'done' | 'stopped' | 'error') {
    if (id !== this.utterance || this.state !== 'speaking') return;
    this.complete(how);
  }

  private complete(how: 'done' | 'stopped' | 'error' | 'watchdog') {
    this.clearWatchdog();
    this.state = 'idle';
    if (how === 'done') {
      if (this.wasInterrupted) this.log('resumed');
      this.wasInterrupted = false;
      // Audio works again: no need to keep checking the session
      this.clearSweeps();
    } else {
      // Cut off (a call, Siri, another app taking the audio) or failed
      this.wasInterrupted = true;
      this.log(how === 'error' ? 'failed' : 'interrupted', { how });
      this.armSweeps();
    }
    const next = this.pending;
    this.pending = null;
    if (next != null && how === 'done') {
      void this.start(next);
      return;
    }
    // After a cut-off, what was waiting is out of date: dropped, not replayed
    this.scheduleRelease();
  }

  private armWatchdog(id: number, chars: number) {
    this.clearWatchdog();
    const ms = Math.min(AUDIO.watchdogMaxMs, Math.max(AUDIO.watchdogMinMs, chars * AUDIO.watchdogPerCharMs));
    this.watchdog = this.deps.setTimer(() => {
      this.watchdog = null;
      if (id !== this.utterance || this.state !== 'speaking') return;
      // Its own stopped callback is for nothing now
      this.utterance++;
      try {
        this.deps.engine.stop();
      } catch {
        // Already gone
      }
      this.complete('watchdog');
    }, ms);
  }

  private clearWatchdog() {
    if (this.watchdog != null) this.deps.clearTimer(this.watchdog);
    this.watchdog = null;
  }

  private cancelRelease() {
    if (this.releaseTimer != null) this.deps.clearTimer(this.releaseTimer);
    this.releaseTimer = null;
  }

  private scheduleRelease() {
    this.cancelRelease();
    if (!this.deps.session) return;
    this.releaseTimer = this.deps.setTimer(() => {
      this.releaseTimer = null;
      if (this.state === 'idle') void this.release(false);
    }, AUDIO.releaseDelayMs);
  }

  /**
   * Deactivates the session (other audio comes back up). `force`: even if it
   * isn't known to be active (iOS may have re-activated it after an
   * interruption).
   */
  private async release(force: boolean): Promise<void> {
    const session = this.deps.session;
    if (!session || (!this.active && !force) || !this.configured || this.state !== 'idle') return;
    const was = this.active;
    this.active = false;
    try {
      await session.setActive(false);
      if (was) this.log('released');
    } catch {
      this.log('failed', { stage: 'release' });
      this.armSweeps();
    }
  }

  /** Release again later, in case the interruption's end re-activated the session */
  private armSweeps() {
    if (!this.deps.session || this.sweeps.length) return;
    this.sweeps = AUDIO.sweepAfterMs.map((ms) => this.deps.setTimer(() => {
      if (this.state === 'idle') void this.release(true);
    }, ms));
  }

  private clearSweeps() {
    for (const t of this.sweeps) this.deps.clearTimer(t);
    this.sweeps = [];
  }

  /** Navigation ended for good (sign-out): nothing left playing or active */
  dispose(): void {
    this.stop();
    this.cancelRelease();
    this.clearSweeps();
    void this.release(true);
  }
}

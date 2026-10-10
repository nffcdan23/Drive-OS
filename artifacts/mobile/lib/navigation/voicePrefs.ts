// The navigation voice preference (Navigation Phase 4): Normal (every
// prompt), Alerts only (just the prompt at each manoeuvre, rerouting and
// arrival) or Off. On this device, per signed-in user (cleared with the
// rest of their device data at sign-out). Normal unless they chose
// otherwise.
//
// The mute button during navigation switches between Off and the last
// spoken choice, and is remembered the same way.
//
// No React Native imports, so it is unit-tested under node.

import { readJson, userKey, writeJson, type KeyValueStore } from '../backend/storage';
import type { VoiceMode } from './voice';

export const VOICE_PREFS = { name: 'nav/voice/v1', default: 'normal' as VoiceMode } as const;

export const voicePrefsKey = (userId: string) => userKey(userId, VOICE_PREFS.name);

interface Stored {
  mode: VoiceMode;
  /** The spoken mode to go back to when unmuting */
  unmuted: Exclude<VoiceMode, 'off'>;
}

const MODES: readonly VoiceMode[] = ['normal', 'alerts', 'off'];
const isMode = (v: unknown): v is VoiceMode => MODES.includes(v as VoiceMode);

export class VoicePreferences {
  private value: Stored = { mode: VOICE_PREFS.default, unmuted: 'normal' };
  private listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;
  /** Changed before the stored value was read: that change wins */
  private touched = false;

  constructor(private readonly store: KeyValueStore, private readonly userId: string) {}

  get mode(): VoiceMode {
    return this.value.mode;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }

  load(): Promise<void> {
    this.loaded ??= readJson<unknown>(this.store, voicePrefsKey(this.userId), null).then((raw) => {
      if (this.touched) return;
      const r = raw as Partial<Stored> | null;
      if (r && isMode(r.mode)) {
        this.value = { mode: r.mode, unmuted: r.unmuted === 'alerts' ? 'alerts' : 'normal' };
        this.emit();
      }
    }).catch(() => {});
    return this.loaded;
  }

  async setMode(mode: VoiceMode): Promise<void> {
    if (!isMode(mode)) return;
    this.touched = true;
    if (mode === this.value.mode) return;
    this.value = { mode, unmuted: mode === 'off' ? this.value.unmuted : mode };
    this.emit();
    await writeJson(this.store, voicePrefsKey(this.userId), this.value).catch(() => {});
  }

  /** The mute button: Off, or back to the last spoken choice */
  toggleMute(): Promise<void> {
    return this.setMode(this.value.mode === 'off' ? this.value.unmuted : 'off');
  }
}

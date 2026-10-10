// The speech engine for voice guidance (lib/navigation/voice.ts): expo-speech
// (AVSpeechSynthesizer on iOS, TextToSpeech on Android), in British English.
//
// Audio: on iOS each prompt is spoken with useApplicationAudioSession false,
// so iOS speaks it in its own short-lived audio session that ducks music or a
// podcast while it talks and lets it come back afterwards. Derwent's own
// audio session is never configured or activated, so nothing can be left
// holding the audio after a prompt, and there's no background audio.
//
// A build without the native module (an app binary from before voice
// guidance) simply stays quiet: the module is looked for before expo-speech
// is loaded, so its absence is never a crash.

import { requireOptionalNativeModule } from 'expo';
import type { Speaker } from './voice';

type SpeechModule = typeof import('expo-speech');

let speech: SpeechModule | null | undefined;
function load(): SpeechModule | null {
  if (speech !== undefined) return speech;
  try {
    speech = requireOptionalNativeModule('ExpoSpeech') ? (require('expo-speech') as SpeechModule) : null;
  } catch {
    speech = null;
  }
  return speech;
}

/** Whether this app binary can speak (it has the native speech module) */
export function speechAvailable(): boolean {
  return load() != null;
}

/** expo-speech as voice guidance's Speaker. `onError` gets a short code, never the text. */
export function createSpeaker(onError: (code: string) => void): Speaker {
  let reportedMissing = false;
  return {
    speak(text) {
      const s = load();
      if (!s) {
        if (!reportedMissing) onError('unavailable');
        reportedMissing = true;
        return;
      }
      s.speak(text, {
        language: 'en-GB',
        useApplicationAudioSession: false,
        onError: () => onError('speech_error'),
      });
    },
    stop() {
      void load()?.stop().catch(() => {});
    },
  };
}

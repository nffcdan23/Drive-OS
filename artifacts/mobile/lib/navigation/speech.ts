// The speech engine and audio session for voice guidance (lib/navigation/
// voice.ts decides what to say and when; audioSession.ts plays it safely).
//
// Speech: expo-speech (AVSpeechSynthesizer on iOS, TextToSpeech on Android),
// in British English.
//
// iOS: the app's own audio session through expo-audio (linked on iOS only;
// package.json excludes it from Android): Playback with duckOthers, allowed
// in the background (UIBackgroundModes audio, app.config.js), activated just
// for each prompt and released straight after with notifyOthersOnDeactivation,
// so music or a podcast ducks while Derwent speaks and comes back after it.
// Playback isn't silenced by the silent switch (like a sat-nav), and plays
// on whatever the phone is using: speaker, AirPods, Bluetooth, the car.
// Prompts are spoken on screen, off screen and with the phone locked.
//
// Android: no app audio session (expo-audio can only ask for audio focus
// for its own players, not for speech), so speech plays over other audio
// without ducking, as before; the location foreground service keeps the app
// running while navigating, so prompts are spoken off screen too.
//
// A build without a module stays as safe as it can: without expo-speech
// nothing is spoken; on iOS without expo-audio, speech uses the system's own
// short-lived session (ducking, as before) and only on screen. A missing
// module is looked for before its package is loaded, so it's never a crash.

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { Journal } from '../backend/journal';
import { NavigationSpeaker, type AudioSessionControl, type SpeechEngine } from './audioSession';

type SpeechModule = typeof import('expo-speech');
type AudioModule = typeof import('expo-audio');

let speech: SpeechModule | null | undefined;
function loadSpeech(): SpeechModule | null {
  if (speech !== undefined) return speech;
  try {
    speech = requireOptionalNativeModule('ExpoSpeech') ? (require('expo-speech') as SpeechModule) : null;
  } catch {
    speech = null;
  }
  return speech;
}

let audio: AudioModule | null | undefined;
function loadAudio(): AudioModule | null {
  if (audio !== undefined) return audio;
  try {
    audio = Platform.OS === 'ios' && requireOptionalNativeModule('ExpoAudio') ? (require('expo-audio') as AudioModule) : null;
  } catch {
    audio = null;
  }
  return audio;
}

/** Whether this app binary can speak (it has the native speech module) */
export function speechAvailable(): boolean {
  return loadSpeech() != null;
}

/** expo-speech as the audio controller's engine. `onError` gets a short code, never the text. */
function speechEngine(onError: (code: string) => void): SpeechEngine {
  let reportedMissing = false;
  return {
    speak(text, appSession, events) {
      const s = loadSpeech();
      if (!s) {
        if (!reportedMissing) onError('unavailable');
        reportedMissing = true;
        events.onError();
        return;
      }
      s.speak(text, {
        language: 'en-GB',
        // On the app's session (expo-audio) where there is one; otherwise the
        // system's own, which ducks and releases by itself
        useApplicationAudioSession: appSession,
        onStart: () => events.onStart(),
        onDone: () => events.onDone(),
        onStopped: () => events.onStopped(),
        onError: () => {
          onError('speech_error');
          events.onError();
        },
      });
    },
    stop() {
      void loadSpeech()?.stop().catch(() => {});
    },
  };
}

/** The app's audio session for navigation speech (iOS with expo-audio), or null */
function navigationAudioSession(): AudioSessionControl | null {
  const a = loadAudio();
  if (!a) return null;
  return {
    configure: () => a.setAudioModeAsync({
      // Playback: heard with the silent switch on, and allowed in the background
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      // Other audio lowers while a prompt plays, and comes back after
      interruptionMode: 'duckOthers',
      // Never the microphone, never the earpiece
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    }),
    setActive: (active) => a.setIsAudioActiveAsync(active),
  };
}

/** The speaker voice guidance uses on this device */
export function createSpeaker(deps: {
  onError: (code: string) => void;
  journal?: Journal;
}): NavigationSpeaker {
  const session = navigationAudioSession();
  return new NavigationSpeaker({
    engine: speechEngine(deps.onError),
    session,
    // iOS needs its own session for the background; Android's speech plays from the background as it is
    background: speechAvailable() && (session != null || Platform.OS === 'android'),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    journal: deps.journal,
  });
}

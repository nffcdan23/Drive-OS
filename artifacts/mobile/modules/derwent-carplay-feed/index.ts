// The navigation session's copy for the CarPlay screen (CarPlay Milestone 4,
// lib/navigation/carPlay.ts). One way: the iPhone's session hands CarPlay
// what to show; nothing comes back. Optional: on Android, the web, Expo Go
// or an app binary built before this module there's no native module, the
// sink is null and nothing else changes.
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { CarPlayGuidance, CarPlayRouteLine, CarPlaySink } from '@/lib/navigation/carPlay';

interface NativeCarPlayFeed {
  setGuidance(guidance: CarPlayGuidance | null): Promise<void>;
  setRouteLine(routeId: string | null, coordinates: number[] | null): Promise<void>;
}

const native: NativeCarPlayFeed | null =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeCarPlayFeed>('DerwentCarPlayFeed') : null;

/** Hands guidance to the native CarPlay screen; null where there's none */
export function createCarPlaySink(onError: (err: unknown) => void): CarPlaySink | null {
  if (!native) return null;
  const n = native;
  return {
    guidance: (g: CarPlayGuidance | null) => {
      n.setGuidance(g).catch(onError);
    },
    routeLine: (line: CarPlayRouteLine | null) => {
      n.setRouteLine(line?.routeId ?? null, line?.coordinates ?? null).catch(onError);
    },
  };
}

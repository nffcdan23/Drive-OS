// Apple WeatherKit (iOS) for the drive screen's weather card. Optional: on
// Android, the web, Expo Go or an app binary built before this module, there
// is no native module and every call answers null, so the card stays hidden
// and nothing else changes.
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { CurrentWeather } from '@/lib/weather/driveWeather';

export interface WeatherAttribution {
  serviceName: string;
  legalPageURL: string;
  combinedMarkDarkURL: string;
  combinedMarkLightURL: string;
}

interface NativeWeather {
  currentWeather(latitude: number, longitude: number): Promise<{
    temperatureC: number;
    symbolName: string;
    condition: string;
    isDaylight: boolean;
    date: number;
  }>;
  attribution(): Promise<WeatherAttribution>;
}

const native: NativeWeather | null =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeWeather>('DerwentWeather') : null;

/** Whether this app binary can ask WeatherKit at all */
export const weatherKitAvailable = native != null;

/** The current weather at a position; null when WeatherKit isn't available. Throws if the request fails. */
export async function fetchCurrentWeather(latitude: number, longitude: number): Promise<CurrentWeather | null> {
  if (!native) return null;
  const w = await native.currentWeather(latitude, longitude);
  if (!Number.isFinite(w.temperatureC)) throw new Error('WeatherKit returned no temperature');
  return { temperatureC: w.temperatureC, symbolName: w.symbolName, condition: w.condition };
}

/** Apple Weather's attribution (mark and legal link), or null when unavailable */
export async function fetchWeatherAttribution(): Promise<WeatherAttribution | null> {
  if (!native) return null;
  return native.attribution();
}

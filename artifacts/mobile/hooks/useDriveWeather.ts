// The recording screen's weather (lib/weather/driveWeather.ts for when it
// asks; modules/derwent-weather for WeatherKit). The last good result is kept
// in memory for the drive (and across the screen remounting); a failed
// request only schedules a retry. Nothing here touches recording.

import { useEffect, useState } from 'react';
import { fetchCurrentWeather, weatherKitAvailable } from '@/modules/derwent-weather';
import {
  WEATHER, shownWeather, weatherRefreshDue,
  type CurrentWeather, type Position, type WeatherCache,
} from '@/lib/weather/driveWeather';

let cache: WeatherCache | null = null;
let lastFailureAt: number | null = null;
let inFlight = false;

/**
 * The weather to show while `active` (null: hidden). `getPosition` is read
 * only when a request might be due, never per GPS fix.
 */
export function useDriveWeather(active: boolean, getPosition: () => Position | null): CurrentWeather | null {
  const [weather, setWeather] = useState<CurrentWeather | null>(() => shownWeather(cache, Date.now()));
  const hasWeather = weather != null;

  useEffect(() => {
    if (!active || !weatherKitAvailable) return;
    let cancelled = false;
    const check = async () => {
      const now = Date.now();
      setWeather(shownWeather(cache, now));
      if (inFlight) return;
      const position = getPosition();
      if (!weatherRefreshDue({ cache, lastFailureAt, position, now })) return;
      inFlight = true;
      try {
        const result = await fetchCurrentWeather(position!.latitude, position!.longitude);
        if (result) {
          cache = { weather: result, fetchedAt: Date.now(), at: position! };
          lastFailureAt = null;
        }
      } catch {
        // WeatherKit unreachable, not enabled for the App ID, offline…: keep
        // what we have and try again later; the drive is unaffected
        lastFailureAt = Date.now();
      } finally {
        inFlight = false;
      }
      if (!cancelled) setWeather(shownWeather(cache, Date.now()));
    };
    void check();
    // Until the first result, check more often (the first fix may be moments away)
    const timer = setInterval(() => void check(), hasWeather ? WEATHER.checkMs : 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, getPosition, hasWeather]);

  return weather;
}

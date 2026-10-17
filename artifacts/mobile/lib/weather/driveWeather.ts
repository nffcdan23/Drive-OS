// When the recording screen asks WeatherKit for the current weather, and
// what it shows meanwhile. One request when the drive starts (as soon as
// there is a position), then again every WEATHER.refreshMs or after the car
// has moved WEATHER.moveM, never per GPS fix. A failed request is retried
// after WEATHER.retryMs and never touches the recording; the last good result
// is kept and shown until it is WEATHER.maxShowMs old.
//
// No React Native imports, so it is unit-tested under node.

import { distanceM } from '../backend/geo';

export const WEATHER = {
  refreshMs: 15 * 60_000,
  /** Substantial movement (m) that makes the weather worth asking again */
  moveM: 10_000,
  retryMs: 2 * 60_000,
  /** Older than this, a result is no longer shown */
  maxShowMs: 60 * 60_000,
  /** How often the screen checks whether a request is due */
  checkMs: 20_000,
} as const;

export interface CurrentWeather {
  temperatureC: number;
  /** SF Symbol for the condition (WeatherKit's symbolName) */
  symbolName: string;
  /** e.g. "Cloudy" (WeatherKit's localised description) */
  condition: string;
}

export interface Position { latitude: number; longitude: number }

export interface WeatherCache {
  weather: CurrentWeather;
  fetchedAt: number;
  at: Position;
}

/** Whether to ask WeatherKit now */
export function weatherRefreshDue(input: {
  cache: WeatherCache | null;
  lastFailureAt: number | null;
  position: Position | null;
  now: number;
}): boolean {
  const { cache, lastFailureAt, position, now } = input;
  if (!position || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)) return false;
  if (lastFailureAt != null && now - lastFailureAt < WEATHER.retryMs) return false;
  if (!cache) return true;
  if (now - cache.fetchedAt >= WEATHER.refreshMs) return true;
  return distanceM(cache.at, position) >= WEATHER.moveM;
}

/** The weather to show, or null (the card is hidden) */
export function shownWeather(cache: WeatherCache | null, now: number): CurrentWeather | null {
  if (!cache || now - cache.fetchedAt > WEATHER.maxShowMs) return null;
  return cache.weather;
}

/** Whole degrees Celsius, e.g. "12°C" ("-0" shown as "0") */
export function formatTemperatureC(celsius: number): string {
  const n = Math.round(celsius);
  return `${n === 0 ? 0 : n}°C`;
}

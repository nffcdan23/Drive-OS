import * as Location from 'expo-location';
import { shareInFlight } from './shareInFlight';

/**
 * Asks for foreground ("while using the app") location access. Use this
 * instead of calling Location.requestForegroundPermissionsAsync directly.
 *
 * expo-location's iOS requester keeps only one pending caller while the system
 * prompt is open: a second request replaces the first, whose promise then never
 * settles. The map asks from two places at once (position and compass), so on a
 * fresh install the position watcher waited forever after "Allow" and the map
 * showed no location. Sharing the in-flight request gives every caller the
 * answer.
 */
export const requestForegroundLocation = shareInFlight(() => Location.requestForegroundPermissionsAsync());

/**
 * Asks for background ("Always" on iOS) location access, for recording a
 * drive in the background.  Shared the same way, and the only place it's asked.
 */
export const requestBackgroundLocation = shareInFlight(() => Location.requestBackgroundPermissionsAsync());

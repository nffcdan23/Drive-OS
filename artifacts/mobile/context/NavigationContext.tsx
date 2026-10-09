/**
 * Route previews (Navigation Phase 2A) for the running app.
 *
 * One RoutePreviewStore per signed-in user, in its own context: the store
 * object never changes, so a preview update re-renders only the components
 * that read it (the preview panel, the map's route layers), never the Drive
 * screen, which reads only the phase (useRoutePreviewPhase).
 *
 * Routes are requested only when the user asks (opening a preview, Update
 * Route, Retry). They stay in memory: nothing is stored on the device or the
 * server, and nothing here is logged.
 *
 * Previews need the Mapbox map (DRIVE_MAPBOX) and no drive being recorded;
 * otherwise places still open in the phone's maps app, as before.
 *
 * Also here (Phase 2B): the user's recent destinations (device only, never
 * Search Box results) and destination search (lib/navigation/search.ts),
 * which only runs where a result can be previewed on the Mapbox map.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as Location from 'expo-location';
import { ep, newId } from '@/lib/backendClient';
import { ApiError, AuthRequiredError, NetworkError, describeError } from '@/lib/backend/http';
import { requestForegroundLocation } from '@/lib/locationPermission';
import { DRIVE_MAPBOX } from '@/lib/mapProvider';
import { deviceStorage } from '@/lib/secureStorage';
import { RecentDestinations, type RecentDestination } from '@/lib/navigation/recents';
import { DestinationSearch, type SearchState } from '@/lib/navigation/search';
import { RoutePreviewStore, type PreviewError, type PreviewPhase, type PreviewState } from '@/lib/navigation/previewStore';
import type { Destination, LatLng, RouteOrigin } from '@/lib/navigation/model';

/** A fix this recent is used as the route's start without asking for another */
const ORIGIN_MAX_AGE_MS = 60_000;
/** Below this speed the GPS course is noise, so no heading is sent */
const HEADING_MIN_KMH = 10;

interface NavigationContextValue {
  store: RoutePreviewStore;
  /** The Drive screen's accepted fixes: the preview's start, and when it goes out of date */
  noteFix(fix: { latitude: number; longitude: number; speedKmh: number; headingDeg: number | null; time: number }): void;
  /** Where a route would start now: the latest fix, or a fresh position */
  currentOrigin(): Promise<RouteOrigin>;
  /** The latest position the Drive screen accepted, if recent (search ranks near it) */
  recentPosition(): LatLng | null;
  recents: RecentDestinations;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function describePreviewError(err: unknown): PreviewError {
  if (err instanceof NetworkError) return { code: 'offline', message: "You're offline. Check your connection and try again." };
  if (err instanceof AuthRequiredError) return { code: 'signed_out', message: err.message };
  if (err instanceof ApiError) return { code: err.code, message: err.message };
  return { code: 'unknown', message: describeError(err) };
}

export function NavigationProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const store = useMemo(() => new RoutePreviewStore({
    fetchRoutes: (body) => {
      if (!ep) return Promise.reject(new Error('The app is not connected to a server.'));
      return ep.getRoutes(body);
    },
    describe: describePreviewError,
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }), []);
  const lastFix = useRef<{ origin: RouteOrigin; time: number } | null>(null);

  const noteFix = useCallback<NavigationContextValue['noteFix']>((fix) => {
    const coordinate: LatLng = { latitude: fix.latitude, longitude: fix.longitude };
    const moving = fix.speedKmh >= HEADING_MIN_KMH && fix.headingDeg != null && fix.headingDeg >= 0;
    lastFix.current = { origin: { coordinate, headingDeg: moving ? fix.headingDeg : null }, time: fix.time };
    store.noteFix(coordinate, fix.time);
  }, [store]);

  const currentOrigin = useCallback(async (): Promise<RouteOrigin> => {
    const recent = lastFix.current;
    if (recent && Date.now() - recent.time <= ORIGIN_MAX_AGE_MS) return recent.origin;
    const { status } = await requestForegroundLocation();
    if (status !== 'granted') throw new Error('Allow location access to preview a route from where you are.');
    const pos = (await Location.getLastKnownPositionAsync({ maxAge: ORIGIN_MAX_AGE_MS }))
      ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    return { coordinate: { latitude: pos.coords.latitude, longitude: pos.coords.longitude }, headingDeg: null };
  }, []);

  const recentPosition = useCallback((): LatLng | null => {
    const recent = lastFix.current;
    return recent && Date.now() - recent.time <= 10 * ORIGIN_MAX_AGE_MS ? recent.origin.coordinate : null;
  }, []);
  // On this device, for this user only; cleared at sign-out (CloudSync.wipeLocal)
  const recents = useMemo(() => new RecentDestinations(deviceStorage, userId), [userId]);
  useEffect(() => { void recents.load(); }, [recents]);

  const value = useMemo(
    () => ({ store, noteFix, currentOrigin, recentPosition, recents }),
    [store, noteFix, currentOrigin, recentPosition, recents],
  );
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

function useNavigation(): NavigationContextValue {
  const v = useContext(NavigationContext);
  if (!v) throw new Error('Navigation hooks must be used inside NavigationProvider');
  return v;
}

export function useRoutePreviewStore(): RoutePreviewStore {
  return useNavigation().store;
}

/** The preview's phase only: re-renders the caller when the phase changes, nothing else */
export function useRoutePreviewPhase(): PreviewPhase {
  const store = useRoutePreviewStore();
  return useSyncExternalStore(useCallback((fn: () => void) => store.subscribe(fn), [store]), () => store.phase);
}

/** The whole preview state: for the preview panel only */
export function useRoutePreview(): PreviewState {
  const store = useRoutePreviewStore();
  return useSyncExternalStore(useCallback((fn: () => void) => store.subscribe(fn), [store]), () => store.state);
}

/** Hands the Drive screen's fixes to the preview */
export function useNoteRouteFix() {
  return useNavigation().noteFix;
}

/** Whether places open as a route preview here (Mapbox map, no drive recording) */
export function canPreviewRoutes(isDriving: boolean): boolean {
  return DRIVE_MAPBOX != null && !isDriving;
}

/**
 * Opens a route preview to `destination` from where the phone is now. The
 * user chose the place: this is the request (never repeated on its own).
 * Rejects only when there's no position to start from.
 */
export function useOpenRoutePreview() {
  const { store, currentOrigin, recents } = useNavigation();
  return useCallback(async (destination: Destination) => {
    const origin = await currentOrigin();
    void store.open(destination, origin);
    // A destination the user went to (never a Search Box result: recents skips those)
    void recents.record(destination);
  }, [store, currentOrigin, recents]);
}

/** Recent destinations, newest first */
export function useRecentDestinations(): { items: readonly RecentDestination[]; remove(id: string): void } {
  const { recents } = useNavigation();
  const items = useSyncExternalStore(useCallback((fn: () => void) => recents.subscribe(fn), [recents]), () => recents.items);
  return useMemo(() => ({ items, remove: (id: string) => void recents.remove(id) }), [items, recents]);
}

/**
 * Destination search for one search screen: Mapbox Search Box when results
 * can be previewed on the Mapbox map (DRIVE_MAPBOX, no drive recording),
 * otherwise local results only. Closed (session ended, nothing kept) when
 * the screen goes.
 */
export function useDestinationSearch(isDriving: boolean): { search: DestinationSearch; state: SearchState } {
  const { recentPosition } = useNavigation();
  const remote = canPreviewRoutes(isDriving);
  const [search] = useState(() => new DestinationSearch({
    token: remote ? DRIVE_MAPBOX?.token ?? null : null,
    fetch: (url, init) => fetch(url, init),
    newSessionToken: newId,
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }));
  useEffect(() => {
    const near = recentPosition();
    search.setProximity(near);
    if (!near) {
      // No recent fix from the Drive screen: the phone's last known position, if any
      Location.getLastKnownPositionAsync({ maxAge: 10 * ORIGIN_MAX_AGE_MS })
        .then((p) => { if (p) search.setProximity({ latitude: p.coords.latitude, longitude: p.coords.longitude }); })
        .catch(() => {});
    }
    return () => search.close();
  }, [search, recentPosition]);
  const state = useSyncExternalStore(useCallback((fn: () => void) => search.subscribe(fn), [search]), () => search.state);
  return { search, state };
}

/** Update Route / Retry: fresh routes from where the phone is now */
export function useUpdateRoutePreview() {
  const { store, currentOrigin } = useNavigation();
  return useCallback(async () => {
    const origin = await currentOrigin();
    await store.update(origin);
  }, [store, currentOrigin]);
}

/**
 * useSyncExternalStore for things that only matter on screen: while the app
 * is in the background the snapshot is held as it was (no re-render, nothing
 * sent to the map), and the newest one arrives in one update when the app is
 * back. Background guidance keeps the navigation state current meanwhile.
 *
 * Only "background" holds it: an "inactive" app (an incoming call banner,
 * Control Centre) is still visible, so it stays current.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

export function useOnScreenSnapshot<T>(subscribe: (fn: () => void) => () => void, getSnapshot: () => T): T {
  const onScreen = useRef(AppState.currentState !== 'background');
  const held = useRef<{ value: T } | null>(null);
  const sub = useCallback((fn: () => void) => {
    const off = subscribe(() => { if (onScreen.current) fn(); });
    const app = AppState.addEventListener('change', (state) => {
      const next = state !== 'background';
      if (next === onScreen.current) return;
      onScreen.current = next;
      // Back on screen: the newest state, in one update
      if (next) fn();
    });
    return () => {
      off();
      app.remove();
    };
  }, [subscribe]);
  const snapshot = useCallback(() => {
    if (onScreen.current || !held.current) held.current = { value: getSnapshot() };
    return held.current.value;
  }, [getSnapshot]);
  return useSyncExternalStore(sub, snapshot);
}

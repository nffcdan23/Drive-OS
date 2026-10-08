import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { VisualGate, type VisualState } from "@/lib/visualGate";

/**
 * Whether the screen may do visual work (see lib/visualGate): `live` while
 * the app is active, `mounted` once it has been on screen at all.
 * `liveRef` flips the moment AppState changes (before any re-render), so a
 * frame loop reading it stops at once; `onChange` runs at that moment too.
 */
export function useVisualGate(
  onChange?: (next: VisualState, prev: VisualState) => void,
) {
  const [gate] = useState(() => new VisualGate(AppState.currentState));
  const [state, setState] = useState<VisualState>(gate.current);
  const liveRef = useRef(state.live);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const unsubscribe = gate.subscribe((next, prev) => {
      liveRef.current = next.live;
      onChangeRef.current?.(next, prev);
      setState(next);
    });
    const sub = AppState.addEventListener("change", (s) => gate.update(s));
    // A change between the first render and subscribing
    gate.update(AppState.currentState);
    return () => {
      sub.remove();
      unsubscribe();
    };
  }, [gate]);

  return { live: state.live, mounted: state.mounted, liveRef };
}

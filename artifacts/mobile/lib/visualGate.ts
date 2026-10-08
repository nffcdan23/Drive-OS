// Whether the Drive screen may do visual work (the map, its camera, the
// marker, the trail, the frame loop and on-screen timers).
//
// Background = recording and data only.  Foreground = recording + map/UI.
//
//  - live: the app is active (on screen).  Only then does the frame loop run
//    or anything get written to the map; leaving "active" (backgrounded,
//    locked, or briefly inactive) stops it at once.
//  - mounted: the app has been on screen at least once in this process.
//    When iOS launches the app in the background to deliver locations, the
//    map is never created at all until the user actually opens it; once
//    created it stays (it is only paused while the app isn't active).
//
// Kept free of React Native imports so it can be unit-tested under node; the
// Drive screen feeds it AppState.

export type AppStateName =
  "active" | "inactive" | "background" | "unknown" | "extension" | string;

export interface VisualState {
  live: boolean;
  mounted: boolean;
}

export class VisualGate {
  private state: VisualState;
  private listeners = new Set<(s: VisualState, prev: VisualState) => void>();

  constructor(initial: AppStateName | null | undefined) {
    this.state = VisualGate.from(initial, false);
  }

  private static from(
    app: AppStateName | null | undefined,
    wasMounted: boolean,
  ): VisualState {
    const live = app === "active";
    // Launched in the background: no map until the app is first shown
    const mounted = wasMounted || (app != null && app !== "background");
    return { live, mounted };
  }

  get current(): VisualState {
    return this.state;
  }

  /** The app's state changed (AppState "change") */
  update(app: AppStateName | null | undefined): VisualState {
    const prev = this.state;
    const next = VisualGate.from(app, prev.mounted);
    if (next.live !== prev.live || next.mounted !== prev.mounted) {
      this.state = next;
      for (const fn of this.listeners) fn(next, prev);
    }
    return this.state;
  }

  subscribe(fn: (s: VisualState, prev: VisualState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

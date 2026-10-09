/**
 * Keeps the screen on while turn-by-turn guidance is running (Navigation
 * Phase 3). Guidance is foreground only: if iOS auto-locked the phone, the
 * app would go to the background and guidance would pause mid-route. Mounted
 * only while guiding, so arriving, ending or leaving navigation lets the
 * screen lock as usual again.
 */
import { useKeepAwake } from "expo-keep-awake";

export function GuidanceKeepAwake() {
  useKeepAwake("derwent-guidance");
  return null;
}

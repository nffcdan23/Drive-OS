import type { ActiveDrive } from "@/context/AppContext";
import type { ResolvedUnitSystem } from "@/lib/units";

/** Recording-screen colours, on top of the Derwent graphite palette. */
export const rec = {
  cyan: "#00CFE8",
  cyanBright: "#5BE8FF",
  blue: "#1E7BFF",
  red: "#FF4B4B",
  finish: ["#FF6A4D", "#F23B2E"] as const,
  marker: "#FF9F45",
  amber: "#F5B83D",
  green: "#3FD98A",
  text: "#FFFFFF",
  textMuted: "rgba(214,224,234,0.72)",
  hairline: "rgba(220,232,244,0.14)",
};

/** Elapsed time as HH:MM:SS, the format of the REC pill. */
export function formatElapsed(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Mean of the recorded speed samples (km/h), as the drive summary computes it. */
export function averageSpeedKmh(drive: ActiveDrive | null): number {
  if (!drive || drive.speedSamples.length === 0) return 0;
  return (
    drive.speedSamples.reduce((a, b) => a + b, 0) / drive.speedSamples.length
  );
}

/** km/h in the user's unit (mph or km/h). */
export function toDisplaySpeed(kmh: number, system: ResolvedUnitSystem) {
  return Math.max(0, system === "imperial" ? kmh * 0.621371 : kmh);
}

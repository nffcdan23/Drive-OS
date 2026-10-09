/**
 * The manoeuvre arrow for turn-by-turn guidance (Navigation Phase 3), drawn
 * from the normalised manoeuvre (never Mapbox's own data): a turn's angle, a
 * U-turn on the driving side, and roundabouts drawn the way they're driven
 * (clockwise in the UK) with the exit to take and its number.
 */
import React, { memo } from "react";
import Svg, { Circle, G, Path, Text as SvgText } from "react-native-svg";
import type { Maneuver, ManeuverDirection } from "@/lib/navigation/maneuver";

/** What the icon needs of a manoeuvre */
export type IconManeuver = Pick<Maneuver, "kind" | "direction" | "exit" | "drivingSide">;

/** The arrival flag */
export const ARRIVAL_ICON: IconManeuver = { kind: "arrive", direction: null, exit: null, drivingSide: "left" };

/** Exit direction as an angle (degrees, clockwise from straight ahead) */
const ANGLE: Record<ManeuverDirection, number> = {
  straight: 0,
  slightRight: 45,
  right: 90,
  sharpRight: 135,
  uturn: 180,
  sharpLeft: -135,
  left: -90,
  slightLeft: -45,
};

const rad = (d: number) => (d * Math.PI) / 180;

/** An arrowhead with its tip at (x, y), pointing along `angle` */
function head(x: number, y: number, angle: number, size = 7) {
  const s = Math.sin(rad(angle));
  const c = Math.cos(rad(angle));
  const bx = x - s * size;
  const by = y + c * size;
  return `M${x.toFixed(2)} ${y.toFixed(2)} L${(bx + c * size * 0.8).toFixed(2)} ${(by + s * size * 0.8).toFixed(2)} L${(bx - c * size * 0.8).toFixed(2)} ${(by - s * size * 0.8).toFixed(2)} Z`;
}

function TurnArrow({ angle, color }: { angle: number; color: string }) {
  if (angle === 0) {
    return (
      <G>
        <Path d="M24 42 L24 14" stroke={color} strokeWidth={5} strokeLinecap="round" fill="none" />
        <Path d={head(24, 7, 0, 9)} fill={color} />
      </G>
    );
  }
  const len = 13;
  const ex = 24 + Math.sin(rad(angle)) * len;
  const ey = 22 - Math.cos(rad(angle)) * len;
  const tipX = ex + Math.sin(rad(angle)) * 7;
  const tipY = ey - Math.cos(rad(angle)) * 7;
  return (
    <G>
      <Path
        d={`M24 42 L24 22 L${ex.toFixed(2)} ${ey.toFixed(2)}`}
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path d={head(tipX, tipY, angle, 8)} fill={color} />
    </G>
  );
}

function UTurn({ side, color }: { side: "left" | "right"; color: string }) {
  // Where traffic drives on the left, a U-turn swings right (and vice versa)
  const flip = side === "left" ? 1 : -1;
  const x0 = 24 - 7 * flip;
  const x1 = 24 + 7 * flip;
  return (
    <G>
      <Path
        d={`M${x0} 42 L${x0} 20 A7 7 0 0 ${flip > 0 ? 1 : 0} ${x1} 20 L${x1} 30`}
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
      />
      <Path d={head(x1, 39, 180, 8)} fill={color} />
    </G>
  );
}

function Roundabout({ m, color, muted }: { m: IconManeuver; color: string; muted: string }) {
  const cx = 24;
  const cy = 20;
  const r = 9;
  // Traffic goes clockwise where it drives on the left
  const clockwise = m.drivingSide === "left";
  // All the way round (a U-turn) stops just short of the entry, so it draws
  const exitAngle =
    m.direction === "uturn" ? (clockwise ? 165 : 195) : m.direction ? ANGLE[m.direction] : 0;
  const sweep = clockwise ? (exitAngle - 180 + 720) % 360 : (180 - exitAngle + 720) % 360;
  const at = (a: number, radius: number) => ({
    x: cx + Math.sin(rad(a)) * radius,
    y: cy - Math.cos(rad(a)) * radius,
  });
  const entry = at(180, r);
  const exit = at(exitAngle, r);
  const out = at(exitAngle, r + 11);
  const tip = at(exitAngle, r + 16);
  const large = sweep > 180 ? 1 : 0;
  return (
    <G>
      <Circle cx={cx} cy={cy} r={r} stroke={muted} strokeWidth={3} fill="none" />
      <Path
        d={`M24 44 L${entry.x.toFixed(2)} ${entry.y.toFixed(2)} A${r} ${r} 0 ${large} ${clockwise ? 1 : 0} ${exit.x.toFixed(2)} ${exit.y.toFixed(2)} L${out.x.toFixed(2)} ${out.y.toFixed(2)}`}
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path d={head(tip.x, tip.y, exitAngle, 7)} fill={color} />
      {m.exit ? (
        <SvgText
          x={cx}
          y={cy + 4}
          fontSize={11}
          fontWeight="700"
          fill={color}
          textAnchor="middle"
        >
          {m.exit}
        </SvgText>
      ) : null}
    </G>
  );
}

function Flag({ color }: { color: string }) {
  return (
    <G>
      <Path d="M15 43 L15 7" stroke={color} strokeWidth={4} strokeLinecap="round" />
      <Path d="M15 8 L35 13 L15 21 Z" fill={color} />
    </G>
  );
}

export const ManeuverIcon = memo(function ManeuverIcon({
  maneuver,
  size = 52,
  color = "#FFFFFF",
  muted = "rgba(255,255,255,0.35)",
}: {
  maneuver: IconManeuver;
  size?: number;
  color?: string;
  muted?: string;
}) {
  const m = maneuver;
  let body: React.ReactNode;
  if (m.kind === "arrive") body = <Flag color={color} />;
  else if (m.kind === "roundabout" || m.kind === "miniRoundabout") body = <Roundabout m={m} color={color} muted={muted} />;
  else if (m.kind === "uturn" || m.direction === "uturn") body = <UTurn side={m.drivingSide} color={color} />;
  else {
    let angle = m.direction ? ANGLE[m.direction] : 0;
    // A fork, slip road or merge bears off rather than turns
    if ((m.kind === "fork" || m.kind === "onRamp" || m.kind === "offRamp" || m.kind === "merge") && Math.abs(angle) > 45) {
      angle = Math.sign(angle) * 45;
    }
    body = <TurnArrow angle={angle} color={color} />;
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {body}
    </Svg>
  );
});

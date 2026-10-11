// The words on the navigation card (the reference-led redesign): the main
// line, the line under it and the shield, from the manoeuvre's own Mapbox
// data only. No React Native imports, so it is unit-tested under node.

import type { Maneuver } from './maneuver';

/**
 * The card's two text lines: the road or place the manoeuvre leads to (the
 * banner's main text), then what to do. Without a road, the instruction is
 * the main line and the signposts the second.
 */
export function guidanceLines(m: Maneuver): { primary: string; secondary: string | null } {
  const road = m.primaryText ?? m.roadRef ?? m.roadName;
  if (road && road !== m.instruction) return { primary: road, secondary: m.instruction };
  return { primary: m.instruction, secondary: m.secondaryText ?? m.signposts };
}

/** The shield: the junction number, else the road number; none without either */
export function guidanceShield(m: Maneuver): { text: string; motorway: boolean } | null {
  if (m.junctionRef) return { text: `J${m.junctionRef}`, motorway: true };
  if (m.roadRef) return { text: m.roadRef, motorway: /^M\d|\(M\)$/i.test(m.roadRef) };
  return null;
}

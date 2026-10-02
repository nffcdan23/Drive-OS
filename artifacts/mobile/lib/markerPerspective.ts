// How the Drive map's location arrow is drawn to sit on a tilted map.
//
// The arrow is plan-view artwork (seen from straight above).  On a pitched
// map, anything lying on the road is foreshortened along the screen's vertical
// axis by roughly cos(pitch), and a raised object shows a little of its side
// toward the viewer.  The marker reproduces both: after rotating the arrow to
// its heading it is squashed vertically (so pointing up the road it shortens,
// pointing across it keeps its width), and a dark "edge" copy and a soft shadow
// are offset toward the bottom of the screen, by more the steeper the view.
//
// Kept free of React Native imports so it can be unit-tested under node.

export const MARKER_PERSPECTIVE = {
  // Share of the map's pitch the arrow is laid back by.  The full 60° would
  // halve its length pointing up the road, which reads poorly at marker size;
  // 0.8 (48°) keeps it clearly on the road while staying legible.
  tiltFactor: 0.8,
  // Steeper than this and the arrow becomes a sliver; MapKit rarely goes there
  maxTiltDeg: 60,
  // ── Depth: tune these after a road test ──
  // Screen-space drop (pt) of the side wall below the top face at full tilt
  // (scaled by sin of the tilt, so ~3.9 pt on the 60° navigation camera)
  edgeLiftPt: 5.2,
  // The shadow sits 2 pt down even when flat (the old artwork's offset),
  // plus this much more at full tilt
  shadowBasePt: 2,
  shadowLiftPt: 4,
  shadowOpacity: 0.34,
  // Side wall: a graphite band with its own dark edge, distinct from the top
  // face's near-black outline so the two read as separate layers rather than
  // merging into one thick outline
  wallFill: "#454B55",
  wallStroke: "#121316",
} as const;

export interface MarkerPerspective {
  /** Vertical squash applied after rotation (1 = flat, top-down) */
  scaleY: number;
  /** How far the dark side wall shows below the arrow, in points */
  edgeLift: number;
  /** How far the ground shadow sits below the arrow, in points */
  shadowLift: number;
}

const DEG = Math.PI / 180;

/** The arrow's perspective for a map pitch in degrees (0 = straight down) */
export function markerPerspective(mapPitchDeg: number): MarkerPerspective {
  const p = MARKER_PERSPECTIVE;
  const pitch = Number.isFinite(mapPitchDeg) ? mapPitchDeg : 0;
  const tilt = Math.min(Math.max(pitch, 0) * p.tiltFactor, p.maxTiltDeg) * DEG;
  return {
    scaleY: Math.cos(tilt),
    edgeLift: p.edgeLiftPt * Math.sin(tilt),
    shadowLift: p.shadowBasePt + p.shadowLiftPt * Math.sin(tilt),
  };
}

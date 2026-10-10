// Turn-by-turn manoeuvres (Navigation Phase 3): the route's steps as the
// guidance UI reads them, never Mapbox's own shapes.
//
// One manoeuvre per step: step k's manoeuvre is where step k begins (turn
// left here, take the 2nd exit here). Mapbox attaches the *announcements* for
// a manoeuvre to the step before it: step k-1's banner and voice prompts
// describe the manoeuvre at the end of step k-1, which is the start of step
// k. So manoeuvre k takes its banner and voice from step k-1, and its
// instruction, road and exit from step k.
//
// The instruction is Mapbox's own en-GB sentence ("At the roundabout, take
// the 2nd exit onto the A591"); a sentence is only composed here when Mapbox
// gave none. The roundabout exit is Mapbox's structured exit number, never
// read out of the text.
//
// The voice prompts and their distances are what voice guidance speaks
// (Phase 4, voice.ts). Lane data is kept for later (null until the API
// forwards it).
//
// No React Native imports, so it is unit-tested under node.

import type { LatLng, RouteStep } from './model';

export type ManeuverKind =
  | 'depart'
  | 'turn'
  | 'continue'
  | 'merge'
  | 'onRamp'
  | 'offRamp'
  | 'fork'
  | 'endOfRoad'
  | 'roundabout'
  | 'miniRoundabout'
  | 'roundaboutExit'
  | 'uturn'
  | 'arrive'
  | 'notification';

export type ManeuverDirection =
  | 'straight'
  | 'slightLeft'
  | 'left'
  | 'sharpLeft'
  | 'slightRight'
  | 'right'
  | 'sharpRight'
  | 'uturn';

/** A lane at a junction (Phase 6). Not sent by the API yet. */
export interface LaneInfo {
  indications: string[];
  valid: boolean;
  active: boolean;
}

export interface VoicePrompt {
  /** How far before the manoeuvre it should be spoken (m) */
  distanceBeforeM: number;
  text: string;
}

export interface Maneuver {
  /** The step this manoeuvre begins */
  stepIndex: number;
  kind: ManeuverKind;
  direction: ManeuverDirection | null;
  /** Roundabout exit to take (1 = first), from Mapbox's structured data */
  exit: number | null;
  /** Which side traffic drives on here ('left' in the UK: roundabouts go clockwise) */
  drivingSide: 'left' | 'right';
  /** What to do, in Mapbox's en-GB words */
  instruction: string;
  /** The banner's main text, usually the road or place it leads to */
  primaryText: string | null;
  secondaryText: string | null;
  /** The road this manoeuvre leads onto */
  roadName: string | null;
  roadRef: string | null;
  /** Signposted destinations, e.g. "Keswick" */
  signposts: string | null;
  /** Junction number(s), e.g. "36" */
  junctionRef: string | null;
  location: LatLng;
  bearingAfter: number | null;
  /** Spoken prompts for this manoeuvre, farthest first (Phase 5) */
  voice: VoicePrompt[];
  /** Lanes approaching it (Phase 6); null until the API sends them */
  lanes: LaneInfo[] | null;
}

const KINDS: Record<string, ManeuverKind> = {
  depart: 'depart',
  arrive: 'arrive',
  turn: 'turn',
  continue: 'continue',
  'new name': 'continue',
  'use lane': 'continue',
  merge: 'merge',
  'on ramp': 'onRamp',
  'off ramp': 'offRamp',
  fork: 'fork',
  'end of road': 'endOfRoad',
  roundabout: 'roundabout',
  rotary: 'roundabout',
  'roundabout turn': 'miniRoundabout',
  'exit roundabout': 'roundaboutExit',
  'exit rotary': 'roundaboutExit',
  notification: 'notification',
};

const DIRECTIONS: Record<string, ManeuverDirection> = {
  uturn: 'uturn',
  'sharp right': 'sharpRight',
  right: 'right',
  'slight right': 'slightRight',
  straight: 'straight',
  'slight left': 'slightLeft',
  left: 'left',
  'sharp left': 'sharpLeft',
};

export function maneuverKind(type: string, modifier: string | null): ManeuverKind {
  const kind = KINDS[type] ?? 'continue';
  if ((kind === 'turn' || kind === 'continue') && modifier === 'uturn') return 'uturn';
  return kind;
}

export function maneuverDirection(modifier: string | null): ManeuverDirection | null {
  return modifier ? DIRECTIONS[modifier] ?? null : null;
}

export const isRoundabout = (k: ManeuverKind) => k === 'roundabout' || k === 'miniRoundabout';

/** "1st", "2nd", "3rd", "4th", "11th", "21st" */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const DIRECTION_WORDS: Record<ManeuverDirection, string> = {
  straight: 'straight on',
  slightLeft: 'slight left',
  left: 'left',
  sharpLeft: 'sharp left',
  slightRight: 'slight right',
  right: 'right',
  sharpRight: 'sharp right',
  uturn: 'a U-turn',
};

/** The road a step is on, as a sign would put it: "A591 Lake Road", "Lake Road", "A591" */
export function roadLabel(step: Pick<RouteStep, 'roadName' | 'roadRef'>): string | null {
  const name = step.roadName?.trim() || null;
  const ref = step.roadRef?.trim() || null;
  if (name && ref && !name.includes(ref)) return `${ref} ${name}`;
  return name ?? ref;
}

/**
 * Only when Mapbox gave no instruction: a plain one from the structured data.
 * (Mapbox's own sentence is always preferred.)
 */
function composeInstruction(kind: ManeuverKind, direction: ManeuverDirection | null, exit: number | null, road: string | null): string {
  const onto = road ? ` onto ${road}` : '';
  switch (kind) {
    case 'depart':
      return road ? `Head along ${road}` : 'Head off';
    case 'arrive':
      return 'You have arrived';
    case 'roundabout':
    case 'miniRoundabout':
      return exit ? `At the roundabout, take the ${ordinal(exit)} exit${onto}` : `At the roundabout, go ${direction ? DIRECTION_WORDS[direction] : 'ahead'}${onto}`;
    case 'roundaboutExit':
      return `Exit the roundabout${onto}`;
    case 'uturn':
      return 'Make a U-turn';
    case 'merge':
      return `Merge${onto}`;
    case 'onRamp':
      return `Take the slip road${onto}`;
    case 'offRamp':
      return `Take the exit${onto}`;
    case 'fork':
      return `Keep ${direction?.includes('Right') || direction === 'right' ? 'right' : 'left'}${onto}`;
    case 'continue':
      return road ? `Continue on ${road}` : 'Continue';
    default:
      return direction ? `Turn ${DIRECTION_WORDS[direction]}${onto}` : `Continue${onto}`;
  }
}

/** The manoeuvre that begins step `index` of `steps` (all legs, in order) */
export function maneuverFor(steps: readonly RouteStep[], index: number): Maneuver {
  const step = steps[index]!;
  const before = index > 0 ? steps[index - 1]! : null;
  const m = step.maneuver;
  const kind = maneuverKind(m.type, m.modifier);
  const direction = kind === 'uturn' ? 'uturn' : maneuverDirection(m.modifier);
  const exit = isRoundabout(kind) || kind === 'roundaboutExit' ? m.exit : null;
  const road = roadLabel(step);
  const lanes = (step as RouteStep & { lanes?: LaneInfo[] | null }).lanes ?? null;
  return {
    stepIndex: index,
    kind,
    direction,
    exit,
    drivingSide: (step.drivingSide ?? before?.drivingSide ?? 'left') === 'right' ? 'right' : 'left',
    instruction: m.instruction?.trim() || composeInstruction(kind, direction, exit, road),
    primaryText: before?.banner?.primary ?? null,
    secondaryText: before?.banner?.secondary ?? null,
    roadName: step.roadName,
    roadRef: step.roadRef,
    signposts: step.signposts,
    junctionRef: step.junctionRef,
    location: m.location,
    bearingAfter: m.bearingAfter,
    voice: [...(before?.voice ?? [])].sort((a, b) => b.distanceBeforeM - a.distanceBeforeM),
    lanes: Array.isArray(lanes) ? lanes : null,
  };
}

export function maneuversFor(steps: readonly RouteStep[]): Maneuver[] {
  return steps.map((_, i) => maneuverFor(steps, i));
}

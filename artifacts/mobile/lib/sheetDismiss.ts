// Swipe-down-to-dismiss for the app's bottom sheets (components/KeyboardAwareSheet).
//
// Kept free of React Native imports so it can be unit-tested under node.

export const SHEET_DISMISS = {
  // A drag starts once the finger has moved this far vertically (taps, and
  // sideways moves past twice this, stay with the sheet's buttons and fields)
  startDistance: 8,
  // Released past this share of the sheet's height, or this far, it closes
  dismissShare: 0.3,
  dismissDistance: 120,
  // ...or flicked down this fast (points per millisecond)
  dismissVelocity: 0.8,
  // Dragging up moves the sheet only this fraction of the finger's travel
  upResistance: 0.15,
  // A scrolling sheet stops this far below the status bar
  topGap: 12,
} as const;

/**
 * How the sheet moves.  It opens with a spring from below the screen to its
 * resting place (critically damped, so it settles without bouncing); a short
 * drag springs back the same way; closing reverses the opening, accelerating
 * away downwards, or carries on at the speed a flick left it with.
 */
export const SHEET_MOTION = {
  spring: { stiffness: 300, damping: 34, mass: 1 },
  closeMs: 260,
  // A flick carries the sheet off at least this fast (points per millisecond),
  // taking no less than this long, so it never just vanishes
  minFlingSpeed: 1.2,
  minFlingMs: 140,
} as const;

/** Where the sheet is drawn for a drag of `dy` (down follows the finger) */
export function sheetDragOffset(dy: number): number {
  return dy >= 0 ? dy : dy * SHEET_DISMISS.upResistance;
}

/** Whether letting go after dragging `dy` at velocity `vy` closes the sheet */
export function releaseDismisses(
  dy: number,
  vy: number,
  sheetHeight: number,
): boolean {
  if (dy <= 0) return false;
  const far = Math.min(
    SHEET_DISMISS.dismissDistance,
    sheetHeight > 0
      ? sheetHeight * SHEET_DISMISS.dismissShare
      : SHEET_DISMISS.dismissDistance,
  );
  return dy >= far || vy >= SHEET_DISMISS.dismissVelocity;
}

/**
 * How far the sheet rises when the keyboard opens.  The sheet already keeps
 * the home-indicator area clear (its bottom padding includes the safe-area
 * inset), and the keyboard covers that area anyway, so the sheet rises by the
 * keyboard's height less that inset: its own bottom padding then sits above
 * the keyboard, just as it sits above the home indicator when closed.
 */
export function sheetKeyboardLift(
  keyboardHeight: number,
  safeAreaBottom: number,
): number {
  return Math.max(0, keyboardHeight - safeAreaBottom);
}

/**
 * One move of a drag on the sheet.  `offset` is where the sheet is drawn
 * (0 at rest, positive further down), or null when the drag is scrolling the
 * sheet's content instead and the sheet stays put.
 *
 * A drag that starts in scrolling content moves the sheet only once that
 * content is at its top: from then on the sheet follows the finger from where
 * the hand-off happened (`handoffAt`, carried from move to move).  Pushed back
 * up to its resting place, the sheet hands the drag back to the content, which
 * scrolls again.  A drag on the rest of the sheet (its handle, or content that
 * doesn't scroll) moves the sheet from the start, with resistance upwards.
 */
export function sheetDragStep(
  translationY: number,
  inScrollingContent: boolean,
  contentAtTop: boolean,
  handoffAt: number | null,
  startOffset: number,
): { offset: number | null; handoffAt: number | null } {
  if (!inScrollingContent) {
    return {
      offset: sheetDragOffset(startOffset + translationY),
      handoffAt: null,
    };
  }
  if (handoffAt === null && !contentAtTop)
    return { offset: null, handoffAt: null };
  const from = handoffAt ?? translationY;
  const offset = startOffset + translationY - from;
  if (offset < 0) return { offset: 0, handoffAt: null };
  return { offset, handoffAt: from };
}

/** How long the sheet takes to leave from `remaining` above the bottom, let go at `velocity` (points/ms, down positive) */
export function dismissDuration(remaining: number, velocity: number): number {
  if (velocity <= 0) return SHEET_MOTION.closeMs;
  const speed = Math.max(velocity, SHEET_MOTION.minFlingSpeed);
  return Math.min(
    SHEET_MOTION.closeMs,
    Math.max(SHEET_MOTION.minFlingMs, remaining / speed),
  );
}

/** The backdrop's opacity with the sheet `offset` below its resting place */
export function backdropOpacity(offset: number, sheetHeight: number): number {
  if (sheetHeight <= 0) return offset > 0 ? 0 : 1;
  return Math.min(1, Math.max(0, 1 - offset / sheetHeight));
}

/**
 * Where a sheet's scroll view should scroll so a field is fully visible, with
 * `gap` to spare; null when it already is.  Positions are in the scroll
 * content's coordinates; `viewport` is the visible height.
 */
export function revealScrollOffset(
  fieldTop: number,
  fieldBottom: number,
  scrollY: number,
  viewport: number,
  gap: number,
): number | null {
  if (fieldBottom + gap > scrollY + viewport) {
    // Below the visible part: scroll just far enough (but never past its top)
    return Math.min(fieldBottom + gap - viewport, Math.max(0, fieldTop - gap));
  }
  if (fieldTop - gap < scrollY) return Math.max(0, fieldTop - gap);
  return null;
}

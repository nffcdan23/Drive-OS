// Swipe-down-to-dismiss for the app's bottom sheets (components/KeyboardAwareSheet).
//
// Kept free of React Native imports so it can be unit-tested under node.

export const SHEET_DISMISS = {
  // A drag starts once the finger has moved this far, mostly downwards (taps
  // and horizontal moves stay with the sheet's buttons and fields)
  startDistance: 8,
  // Released past this share of the sheet's height, or this far, it closes
  dismissShare: 0.3,
  dismissDistance: 120,
  // ...or flicked down this fast (points per millisecond)
  dismissVelocity: 0.8,
  // Dragging up moves the sheet only this fraction of the finger's travel
  upResistance: 0.15,
  // A scrolling sheet's content pulled down past its top by this much (and
  // let go) closes it.  The bounce halves the finger's travel, hence smaller
  // than dismissDistance.
  overscrollDistance: 64,
  // A scrolling sheet stops this far below the status bar
  topGap: 12,
} as const;

/** Whether a move on the sheet should start dragging it */
export function claimsSheetDrag(dx: number, dy: number): boolean {
  return dy > SHEET_DISMISS.startDistance && Math.abs(dy) > Math.abs(dx);
}

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

/** Whether a scrolling sheet's content, let go at `offsetY`, was pulled down far enough to close */
export function overscrollDismisses(offsetY: number): boolean {
  return offsetY <= -SHEET_DISMISS.overscrollDistance;
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

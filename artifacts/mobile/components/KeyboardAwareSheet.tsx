// The backdrop for a bottom sheet in a Modal that has text fields.
//
// The sheet sits at the bottom of the screen as before.  When one of its
// fields is focused and the keyboard would cover it, the sheet moves up only
// as far as that field needs (KeyboardAwareScrollViewCompat), and back down
// when the keyboard closes.  A field already clear of the keyboard doesn't
// move it at all.
import React, { type ReactNode } from "react";
import { KeyboardAwareScrollViewCompat } from "./KeyboardAwareScrollViewCompat";

export function KeyboardAwareSheet({
  backdropColor,
  children,
}: {
  /** The dimmed backdrop behind the sheet */
  backdropColor?: string;
  children: ReactNode;
}) {
  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: backdropColor }}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end" }}
      bounces={false}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </KeyboardAwareScrollViewCompat>
  );
}

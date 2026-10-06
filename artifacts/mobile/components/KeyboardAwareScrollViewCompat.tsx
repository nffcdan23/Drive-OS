// The app's keyboard-aware scroll view, for every form.
//
// When a field gains focus, react-native-keyboard-controller measures it
// against the keyboard: if it's already clear of the keyboard nothing moves;
// if the keyboard would cover any of it, the view scrolls just far enough to
// leave KEYBOARD_FIELD_GAP between the field and the keyboard (a multiline
// field follows its caret), and when the keyboard closes the view scrolls back
// to where it was.  The keyboard's height already includes the home-indicator
// area, so no safe-area or tab-bar offset is added on top.
import React, { forwardRef } from "react";
import { Platform, ScrollView, ScrollViewProps } from "react-native";
import {
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewProps,
} from "react-native-keyboard-controller";
import { KEYBOARD_FIELD_GAP } from "@/lib/keyboardGap";

export { KEYBOARD_FIELD_GAP };

type Props = KeyboardAwareScrollViewProps & ScrollViewProps;

export const KeyboardAwareScrollViewCompat = forwardRef<ScrollView, Props>(
  function KeyboardAwareScrollViewCompat(
    {
      children,
      keyboardShouldPersistTaps = "handled",
      bottomOffset = KEYBOARD_FIELD_GAP,
      ...props
    },
    ref,
  ) {
    if (Platform.OS === "web") {
      return (
        <ScrollView
          ref={ref}
          keyboardShouldPersistTaps={keyboardShouldPersistTaps}
          {...props}
        >
          {children}
        </ScrollView>
      );
    }
    return (
      <KeyboardAwareScrollView
        ref={ref as never}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        bottomOffset={bottomOffset}
        {...props}
      >
        {children}
      </KeyboardAwareScrollView>
    );
  },
);

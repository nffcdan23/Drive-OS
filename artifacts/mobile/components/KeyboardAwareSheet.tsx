// A bottom sheet in its own Modal, for sheets with text fields.
//
// - Dismissal: tap the dimmed area above it, swipe the sheet down, or use the
//   accessibility escape gesture; each calls `onClose` (which also puts the
//   keyboard away).  A transparent Modal gets no system swipe or close of its
//   own on iOS, so without these the sheet could only be left by its own buttons.
// - Layout: the dimmed backdrop is a full-screen layer of its own, behind the
//   sheet and fixed in place; the keyboard handling wraps only the panel.
// - Keyboard: the sheet rides on the keyboard.  It rises by the keyboard's
//   height less the safe-area inset its bottom padding already keeps clear
//   (lib/sheetDismiss.ts), so the whole sheet stays usable, the field being
//   typed in and the button under it included, with the sheet's own bottom
//   padding as the gap above the keyboard.  When the keyboard closes the sheet
//   settles back.
//
// It uses React Native's own KeyboardAvoidingView, not a keyboard-aware
// ScrollView: the sheet doesn't scroll, and nothing from
// react-native-keyboard-controller runs inside the Modal (its
// KeyboardAwareScrollView in this Modal is what opening Add Friend crashed on).
import React, { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  claimsSheetDrag,
  releaseDismisses,
  sheetDragOffset,
} from "@/lib/sheetDismiss";

export function KeyboardAwareSheet({
  visible,
  onClose,
  backdropColor,
  children,
}: {
  visible: boolean;
  /** The user asked to close it (backdrop tap, swipe down, escape) */
  onClose: () => void;
  /** The dimmed backdrop behind the sheet */
  backdropColor?: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const drag = useRef(new Animated.Value(0)).current;
  const sheetHeight = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = () => {
    Keyboard.dismiss();
    onCloseRef.current();
  };

  // Each opening starts in place, whatever the last one ended as
  useEffect(() => {
    if (visible) drag.setValue(0);
  }, [visible, drag]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Only a downward drag is the sheet's; taps stay with its fields and buttons
        onMoveShouldSetPanResponder: (_e, g) => claimsSheetDrag(g.dx, g.dy),
        onPanResponderMove: (_e, g) => drag.setValue(sheetDragOffset(g.dy)),
        onPanResponderRelease: (_e, g) => {
          if (releaseDismisses(g.dy, g.vy, sheetHeight.current)) {
            Animated.timing(drag, {
              toValue: Math.max(sheetHeight.current, g.dy),
              duration: 180,
              useNativeDriver: true,
            }).start(() => {
              Keyboard.dismiss();
              onCloseRef.current();
            });
          } else {
            Animated.spring(drag, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 0,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
        },
      }),
    [drag],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
    >
      <View style={styles.fill}>
        {/* The dimmed backdrop: the whole screen, behind the sheet, and
            fixed; the keyboard never moves it.  Tapping it closes the sheet. */}
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: backdropColor }]}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        {/* Only the sheet rides on the keyboard: this wraps just the panel,
            anchored to the bottom of the screen */}
        <KeyboardAvoidingView
          style={styles.sheetDock}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          // KeyboardAvoidingView pads by the keyboard's height plus this
          // offset: less the inset gives sheetKeyboardLift()
          keyboardVerticalOffset={-insets.bottom}
          pointerEvents="box-none"
        >
          <Animated.View
            {...pan.panHandlers}
            onLayout={(e) => {
              sheetHeight.current = e.nativeEvent.layout.height;
            }}
            onAccessibilityEscape={close}
            style={{ transform: [{ translateY: drag }] }}
          >
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Its bottom edge stays on the screen's, so the padding the keyboard adds
  // raises the panel and nothing else
  sheetDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
});

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
// - Long forms: with `scrollable`, the sheet may grow to just below the status
//   bar, and a SheetScrollView inside the panel scrolls its fields once they
//   don't fit (the keyboard taking space included).  It keeps the field being
//   typed in visible, and pulling its content down past the top closes the
//   sheet, as dragging the sheet does.
//
// It uses React Native's own KeyboardAvoidingView, not a keyboard-aware
// ScrollView: the sheet itself doesn't scroll, and nothing from
// react-native-keyboard-controller runs inside the Modal (its
// KeyboardAwareScrollView in this Modal is what opening Add Friend crashed on).
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KEYBOARD_FIELD_GAP } from "@/lib/keyboardGap";
import {
  claimsSheetDrag,
  overscrollDismisses,
  releaseDismisses,
  revealScrollOffset,
  sheetDragOffset,
  SHEET_DISMISS,
} from "@/lib/sheetDismiss";

/** The open sheet's close, for a SheetScrollView inside it */
const SheetClose = createContext<() => void>(() => {});

export function KeyboardAwareSheet({
  visible,
  onClose,
  backdropColor,
  scrollable = false,
  children,
}: {
  visible: boolean;
  /** The user asked to close it (backdrop tap, swipe down, escape) */
  onClose: () => void;
  /** The dimmed backdrop behind the sheet */
  backdropColor?: string;
  /**
   * A long form: the sheet may be as tall as the screen allows, and its
   * fields go in a SheetScrollView (its panel needs flexShrink: 1)
   */
  scrollable?: boolean;
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
          style={[
            styles.sheetDock,
            // A long sheet may reach just below the status bar; the padding
            // the keyboard adds then shortens it rather than lifting it off-screen
            scrollable && {
              top: insets.top + SHEET_DISMISS.topGap,
              justifyContent: "flex-end",
            },
          ]}
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
            style={[
              { transform: [{ translateY: drag }] },
              scrollable && styles.shrink,
            ]}
          >
            <SheetClose.Provider value={close}>{children}</SheetClose.Provider>
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
  shrink: { flexShrink: 1 },
  scroll: { flexGrow: 0, flexShrink: 1 },
});

/**
 * The fields of a long sheet (`scrollable`), inside its panel.  It scrolls
 * only when they don't fit; until then a drag anywhere moves the sheet.
 * When the keyboard takes space, the field being typed in is scrolled into
 * view; pulling the content down past its top closes the sheet.
 */
export function SheetScrollView({
  contentContainerStyle,
  children,
}: {
  contentContainerStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const close = useContext(SheetClose);
  const ref = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const scrollY = useRef(0);
  const viewport = useRef(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const overflows = contentHeight > viewportHeight + 1;

  // The field being typed in, kept in view as the keyboard shortens the sheet
  const revealFocused = () => {
    const input = TextInput.State.currentlyFocusedInput() as {
      measureLayout?: (
        relativeTo: unknown,
        onSuccess: (x: number, y: number, w: number, h: number) => void,
        onFail?: () => void,
      ) => void;
    } | null;
    const content = contentRef.current;
    if (!input?.measureLayout || !content) return;
    input.measureLayout(
      content,
      (_x, y, _w, h) => {
        const to = revealScrollOffset(
          y,
          y + h,
          scrollY.current,
          viewport.current,
          KEYBOARD_FIELD_GAP,
        );
        if (to != null) ref.current?.scrollTo({ y: to, animated: true });
      },
      () => {},
    );
  };

  return (
    <ScrollView
      ref={ref}
      innerViewRef={contentRef as React.RefObject<View>}
      style={styles.scroll}
      contentContainerStyle={contentContainerStyle}
      scrollEnabled={overflows}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={(e) => {
        scrollY.current = e.nativeEvent.contentOffset.y;
      }}
      onScrollEndDrag={(e) => {
        if (overscrollDismisses(e.nativeEvent.contentOffset.y)) close();
      }}
      onContentSizeChange={(_w, h) => setContentHeight(h)}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        const shrank = h < viewport.current;
        viewport.current = h;
        setViewportHeight(h);
        if (shrank) revealFocused();
      }}
    >
      {children}
    </ScrollView>
  );
}

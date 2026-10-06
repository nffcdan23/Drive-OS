// A bottom sheet in its own Modal, for sheets with text fields.
//
// - Motion (lib/sheetDismiss.ts): it rises from below the screen with a
//   spring and settles without bouncing, the backdrop fading in as it comes.
//   Closing reverses that: it slides back down off the screen and the
//   backdrop fades out, then `onClose` is called.  The sheet's own position
//   drives the backdrop, so a drag dims it less as the sheet goes down.
// - Dragging: the sheet follows the finger.  Let go far enough down, or with
//   a downward flick, it carries on off the screen and closes; otherwise it
//   springs back into place.
// - Other ways out: a tap on the dimmed area above it, the accessibility
//   escape gesture, and the system close.  Every close puts the keyboard away.
// - Layout: the dimmed backdrop is a full-screen layer of its own, behind the
//   sheet and fixed in place; the keyboard handling wraps only the panel.
// - Keyboard: the sheet rides on the keyboard.  It rises by the keyboard's
//   height less the safe-area inset its bottom padding already keeps clear
//   (lib/sheetDismiss.ts), so the whole sheet stays usable, the field being
//   typed in and the button under it included, with the sheet's own bottom
//   padding as the gap above the keyboard.  When the keyboard closes the sheet
//   settles back.
// - Long forms: with `scrollable`, the sheet may grow to just below the status
//   bar, and a SheetScrollView inside the panel scrolls its fields once they
//   don't fit (the keyboard taking space included), keeping the field being
//   typed in visible.  A drag that starts in those fields scrolls them; once
//   they're at their top, pulling further down takes the sheet with it, and
//   pushing it back up hands the drag back to the fields.  The drag and the
//   scroll view's own scrolling run side by side (react-native-gesture-handler),
//   so they never fight over a touch.
//
// It uses React Native's own KeyboardAvoidingView, not a keyboard-aware
// ScrollView: nothing from react-native-keyboard-controller runs inside the
// Modal (its KeyboardAwareScrollView in this Modal is what opening Add Friend
// crashed on).
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  type NativeGesture,
} from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KEYBOARD_FIELD_GAP } from "@/lib/keyboardGap";
import {
  releaseDismisses,
  revealScrollOffset,
  sheetDragStep,
  dismissDuration,
  SHEET_DISMISS,
  SHEET_MOTION,
} from "@/lib/sheetDismiss";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** What the sheet's drag needs to know about a SheetScrollView inside it */
type SheetScroll = {
  /** Where the scrolling content starts, from the top of the sheet */
  top: number;
  /** Whether it's at its top (or doesn't scroll at all) */
  atTop: () => boolean;
  /** Holds it at its top while the sheet itself is being dragged */
  holdAtTop: () => void;
};
type SheetContextValue = {
  scrollGesture: NativeGesture;
  scroll: React.MutableRefObject<SheetScroll | null>;
};
const SheetContext = createContext<SheetContextValue | null>(null);

export function KeyboardAwareSheet({
  visible,
  onClose,
  backdropColor,
  scrollable = false,
  children,
}: {
  visible: boolean;
  /** The user asked to close it (backdrop tap, drag down, escape) */
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
  const { height: screenHeight } = useWindowDimensions();
  // Hidden below the screen until it has been laid out
  const translateY = useRef(new Animated.Value(screenHeight)).current;
  const [shown, setShown] = useState(visible);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const [sheetHeight, setSheetHeight] = useState(0);
  const sheetHeightRef = useRef(0);
  // Just below the bottom of the screen: where the sheet comes from and goes to
  const offscreen = () => sheetHeightRef.current || screenHeight;
  const closing = useRef(false);
  const opening = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Where the sheet is drawn, kept current (its animations run natively)
  const position = useRef(screenHeight);
  useEffect(() => {
    const id = translateY.addListener(({ value }) => {
      position.current = value;
    });
    return () => translateY.removeListener(id);
  }, [translateY]);

  // Slides off the bottom of the screen (from wherever it is), then `done`
  const leave = useCallback(
    (velocity: number, done: () => void) => {
      closing.current = true;
      Keyboard.dismiss();
      translateY.stopAnimation();
      const to = offscreen();
      Animated.timing(translateY, {
        toValue: to,
        duration: dismissDuration(Math.max(0, to - position.current), velocity),
        // A flick carries on at its speed; otherwise the opening, reversed
        easing:
          velocity > 0 ? Easing.out(Easing.quad) : Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(done);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [translateY, screenHeight],
  );

  // The user closes it: slide away, then tell the screen
  const dismiss = useCallback(
    (velocity = 0) => {
      if (closing.current) return;
      leave(velocity, () => {
        setShown(false);
        onCloseRef.current();
      });
    },
    [leave],
  );
  const close = useCallback(() => dismiss(0), [dismiss]);

  // Opening: shown hidden below the screen, then (once laid out, see
  // onLayout) it rises.  The screen closing it (a form submitted) leaves the
  // same way the user's close does.
  useEffect(() => {
    if (visible) {
      closing.current = false;
      opening.current = true;
      translateY.setValue(screenHeight);
      setShown(true);
    } else if (shownRef.current && !closing.current) {
      leave(0, () => setShown(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ── Dragging ──
  const scroll = useRef<SheetScroll | null>(null);
  const scrollGesture = useMemo(() => Gesture.Native(), []);
  const drag = useRef({
    start: 0,
    handoffAt: null as number | null,
    inContent: false,
    moved: false,
  });
  // Back into place (velocity in points per second, as Animated.spring takes it)
  const settle = useCallback(
    (velocity: number) => {
      Animated.spring(translateY, {
        toValue: 0,
        velocity,
        ...SHEET_MOTION.spring,
        useNativeDriver: true,
      }).start();
    },
    [translateY],
  );
  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Plain JS callbacks: they drive an Animated.Value
        .runOnJS(true)
        // Vertical drags only; taps stay with the sheet's fields and buttons
        .activeOffsetY([
          -SHEET_DISMISS.startDistance,
          SHEET_DISMISS.startDistance,
        ])
        .failOffsetX([
          -2 * SHEET_DISMISS.startDistance,
          2 * SHEET_DISMISS.startDistance,
        ])
        // Side by side with the content's scrolling: each move decides which one moves
        .simultaneousWithExternalGesture(scrollGesture)
        // At touch-down: where the finger landed (the scrolling fields, or
        // the rest of the sheet)
        .onBegin((e) => {
          const d = drag.current;
          d.handoffAt = null;
          d.moved = false;
          d.inContent = scroll.current != null && e.y >= scroll.current.top;
        })
        // A drag (not a tap) takes hold of the sheet where it is, even mid-animation
        .onStart(() => {
          translateY.stopAnimation();
          drag.current.start = position.current;
        })
        .onUpdate((e) => {
          if (closing.current) return;
          const d = drag.current;
          const step = sheetDragStep(
            e.translationY,
            d.inContent,
            scroll.current?.atTop() ?? true,
            d.handoffAt,
            d.start,
          );
          d.handoffAt = step.handoffAt;
          if (step.offset === null) return;
          d.moved = true;
          if (d.inContent && step.offset > 0) scroll.current?.holdAtTop();
          translateY.setValue(step.offset);
        })
        .onEnd((e) => {
          const d = drag.current;
          if (!d.moved || closing.current) return;
          d.moved = false;
          // Gesture velocities are points per second; the dismiss rules use per millisecond
          const perMs = e.velocityY / 1000;
          const offset = position.current;
          if (releaseDismisses(offset, perMs, sheetHeightRef.current)) {
            dismiss(perMs);
          } else {
            settle(e.velocityY);
          }
        })
        .onFinalize(() => {
          // Cancelled mid-drag (another touch took over): back into place
          if (drag.current.moved && !closing.current) settle(0);
          drag.current.moved = false;
        }),
    [scrollGesture, translateY, dismiss, settle],
  );

  // The backdrop follows the sheet: clear below the screen, full at rest
  const backdropOpacity = translateY.interpolate({
    inputRange: [0, Math.max(sheetHeight, 1)],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  const context = useMemo(() => ({ scrollGesture, scroll }), [scrollGesture]);

  return (
    <Modal
      visible={shown}
      transparent
      // The sheet animates itself (rising, dragged, sliding away)
      animationType="none"
      onRequestClose={close}
    >
      <GestureHandlerRootView style={styles.fill}>
        {/* The dimmed backdrop: the whole screen, behind the sheet, and
            fixed; the keyboard never moves it.  Tapping it closes the sheet. */}
        <AnimatedPressable
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: backdropColor, opacity: backdropOpacity },
          ]}
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
          <GestureDetector gesture={pan}>
            <Animated.View
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height;
                sheetHeightRef.current = h;
                setSheetHeight(h);
                // Laid out: rise from just below the screen to rest
                if (opening.current) {
                  opening.current = false;
                  translateY.setValue(h);
                  Animated.spring(translateY, {
                    toValue: 0,
                    ...SHEET_MOTION.spring,
                    useNativeDriver: true,
                  }).start();
                }
              }}
              onAccessibilityEscape={close}
              style={[
                { transform: [{ translateY }] },
                scrollable && styles.shrink,
              ]}
            >
              <SheetContext.Provider value={context}>
                {children}
              </SheetContext.Provider>
            </Animated.View>
          </GestureDetector>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
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
 * When it does scroll, a drag scrolls it, and once it's at its top a further
 * pull down moves the sheet (see KeyboardAwareSheet).  When the keyboard takes
 * space, the field being typed in is scrolled into view.
 */
export function SheetScrollView({
  contentContainerStyle,
  children,
}: {
  contentContainerStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const sheet = useContext(SheetContext);
  const ref = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const scrollY = useRef(0);
  const viewport = useRef(0);
  const top = useRef(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const overflows = contentHeight > viewportHeight + 1;
  const overflowsRef = useRef(overflows);
  overflowsRef.current = overflows;

  // Tell the sheet's drag where the content is and whether it's at its top
  useEffect(() => {
    if (!sheet) return;
    sheet.scroll.current = {
      get top() {
        return top.current;
      },
      atTop: () => !overflowsRef.current || scrollY.current <= 0,
      holdAtTop: () => {
        if (scrollY.current > 0) {
          scrollY.current = 0;
          ref.current?.scrollTo({ y: 0, animated: false });
        }
      },
    };
    return () => {
      sheet.scroll.current = null;
    };
  }, [sheet]);

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

  const view = (
    <ScrollView
      ref={ref}
      // RN's d.ts types this as RefObject<View> (non-null); null only until mount
      innerViewRef={contentRef as React.RefObject<View>}
      style={styles.scroll}
      contentContainerStyle={contentContainerStyle}
      scrollEnabled={overflows}
      // At its top a pull down moves the sheet, not the content
      bounces={false}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={(e) => {
        scrollY.current = e.nativeEvent.contentOffset.y;
      }}
      onContentSizeChange={(_w, h) => setContentHeight(h)}
      onLayout={(e) => {
        // Its top within the sheet (the panel it sits in starts at the sheet's top)
        top.current = e.nativeEvent.layout.y;
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
  // Inside a sheet, its scrolling runs alongside the sheet's drag
  return sheet ? (
    <GestureDetector gesture={sheet.scrollGesture}>{view}</GestureDetector>
  ) : (
    view
  );
}

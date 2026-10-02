import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
  type TouchableOpacityProps,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import colors from "@/constants/colors";

// One set of OS listeners for all material surfaces, including modal portals.
const Preferences = createContext({
  reduceMotion: true,
  reduceTransparency: true,
});
export function MaterialProvider({ children }: { children: React.ReactNode }) {
  const [reduceMotion, setMotion] = useState(true);
  const [reduceTransparency, setTransparency] = useState(true);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (mounted) setMotion(v);
      })
      .catch(() => {});
    if (Platform.OS === "ios") {
      AccessibilityInfo.isReduceTransparencyEnabled()
        .then((v) => {
          if (mounted) setTransparency(v);
        })
        .catch(() => {});
    } else setTransparency(false);
    const motion = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setMotion,
    );
    const transparency =
      Platform.OS === "ios"
        ? AccessibilityInfo.addEventListener(
            "reduceTransparencyChanged",
            setTransparency,
          )
        : null;
    return () => {
      mounted = false;
      motion.remove();
      transparency?.remove();
    };
  }, []);
  return (
    <Preferences.Provider value={{ reduceMotion, reduceTransparency }}>
      {children}
    </Preferences.Provider>
  );
}

/** The system Reduce Motion setting, from the shared listener above. */
export function useReducedMotion() {
  return useContext(Preferences).reduceMotion;
}

type Corners = Pick<
  ViewStyle,
  | "borderRadius"
  | "borderTopLeftRadius"
  | "borderTopRightRadius"
  | "borderBottomLeftRadius"
  | "borderBottomRightRadius"
>;
function corners(style: ViewProps["style"]): Corners {
  const value = StyleSheet.flatten(style) ?? {};
  return {
    borderRadius: value.borderRadius,
    borderTopLeftRadius: value.borderTopLeftRadius,
    borderTopRightRadius: value.borderTopRightRadius,
    borderBottomLeftRadius: value.borderBottomLeftRadius,
    borderBottomRightRadius: value.borderBottomRightRadius,
  };
}
type Material = "chrome" | "dense" | "accent";
export function GlassBackground({
  material = "chrome",
  shape = {},
}: {
  material?: Material;
  shape?: Corners;
}) {
  const { reduceTransparency } = useContext(Preferences);
  const nativeGlass =
    Platform.OS === "ios" && !reduceTransparency && isLiquidGlassAvailable();
  const opaque = reduceTransparency || Platform.OS === "android";
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={[
        StyleSheet.absoluteFill,
        shape,
        { zIndex: -1, overflow: "hidden" },
      ]}
    >
      {material === "accent" ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: colors.dark.primary },
          ]}
        />
      ) : opaque ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: colors.dark.card },
          ]}
        />
      ) : nativeGlass ? (
        <GlassView
          colorScheme="dark"
          glassEffectStyle="regular"
          tintColor={
            material === "dense" ? "rgba(12,18,24,0.78)" : "rgba(16,24,32,0.45)"
          }
          style={[StyleSheet.absoluteFill, shape]}
        />
      ) : (
        <BlurView
          tint="dark"
          intensity={45}
          style={[StyleSheet.absoluteFill, shape]}
        />
      )}
      {material !== "accent" && !opaque && !nativeGlass && (
        <View
          style={[
            StyleSheet.absoluteFill,
            shape,
            {
              backgroundColor:
                material === "dense"
                  ? "rgba(12,18,24,0.78)"
                  : "rgba(16,24,32,0.42)",
            },
          ]}
        />
      )}
    </View>
  );
}

export function GlassSurface({
  style,
  children,
  material = "chrome",
  focused = false,
  ...props
}: ViewProps & { material?: Material; focused?: boolean }) {
  return (
    <View
      {...props}
      style={[
        styles.material,
        style,
        { backgroundColor: "transparent" },
        focused && styles.focused,
      ]}
    >
      <GlassBackground shape={corners(style)} material={material} />
      {children}
    </View>
  );
}
const AnimatedButton = Animated.createAnimatedComponent(TouchableOpacity);
export function GlassButton({
  style,
  children,
  material = "chrome",
  onPressIn,
  onPressOut,
  ...props
}: TouchableOpacityProps & { material?: Material }) {
  const { reduceMotion } = useContext(Preferences);
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduceMotion) {
      scale.stopAnimation();
      scale.setValue(1);
    }
    return () => scale.stopAnimation();
  }, [reduceMotion, scale]);
  const animate = (toValue: number) => {
    if (reduceMotion) return;
    Animated.spring(scale, {
      toValue,
      stiffness: 420,
      damping: 30,
      mass: 0.65,
      useNativeDriver: true,
    }).start();
  };
  return (
    <AnimatedButton
      {...props}
      accessibilityRole={props.accessibilityRole ?? "button"}
      activeOpacity={0.86}
      onPressIn={(event) => {
        animate(0.97);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animate(1);
        onPressOut?.(event);
      }}
      style={[
        styles.material,
        style,
        { backgroundColor: "transparent", transform: [{ scale }] },
      ]}
    >
      <GlassBackground shape={corners(style)} material={material} />
      {children}
    </AnimatedButton>
  );
}
const styles = StyleSheet.create({
  focused: {
    borderColor: "rgba(0,207,232,0.5)",
    borderTopColor: "rgba(180,242,250,0.65)",
  },
  material: {
    isolation: "isolate",
    backgroundColor: "transparent",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(220,232,244,0.16)",
    borderTopColor: "rgba(235,244,255,0.28)",
  },
});

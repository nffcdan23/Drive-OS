/**
 * The launch loading screen: the Derwent artwork, full screen, with a slim
 * progress bar near the bottom. It takes over from the native splash (same
 * artwork, same framing, so the handoff is invisible), follows the real
 * start-up steps, and fades into the app once it's ready.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as SplashScreen from "expo-splash-screen";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { APP_NAME } from "@/constants/brand";

const ARTWORK = require("@/assets/images/loading-screen.png");

// Shown at least this long, so a fast start reads as a smooth fill, not a flash.
const MIN_VISIBLE_MS = 900;
// Never hold the app back longer than this; screens have their own loading states.
const MAX_VISIBLE_MS = 12_000;

export default function LoadingScreen({
  progress,
  ready,
  onFinished,
}: {
  /** 0–1: how far start-up has got. */
  progress: number;
  ready: boolean;
  onFinished: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const trackWidth = Math.round(Math.min(220, width * 0.56));

  const fill = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const shownAt = useRef(Date.now()).current;
  const [timedOut, setTimedOut] = useState(false);
  const [percent, setPercent] = useState(0);
  const finishing = useRef(false);

  // Hand over from the native splash once the artwork is on screen.
  const hideNativeSplash = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);
  useEffect(() => {
    try {
      SplashScreen.setOptions({ fade: true, duration: 200 });
    } catch {
      // Not supported on this platform.
    }
    // In case the artwork never reports that it displayed.
    const fallback = setTimeout(hideNativeSplash, 2500);
    const cap = setTimeout(() => setTimedOut(true), MAX_VISIBLE_MS);
    return () => { clearTimeout(fallback); clearTimeout(cap); };
  }, [hideNativeSplash]);

  useEffect(() => {
    // Tens only: enough for VoiceOver without re-rendering every frame.
    const id = fill.addListener(({ value }) => setPercent(Math.round(value * 10) * 10));
    return () => fill.removeListener(id);
  }, [fill]);

  // Each step: ease to its value, then creep towards the next so the bar
  // never looks stuck while the step is running.
  useEffect(() => {
    if (ready || timedOut) return;
    const anim = Animated.sequence([
      Animated.timing(fill, {
        toValue: progress,
        duration: 450,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(fill, {
        toValue: Math.min(0.92, progress + 0.18),
        duration: 6000,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [progress, ready, timedOut, fill]);

  // Ready: fill the bar, then fade into the app.
  useEffect(() => {
    if ((!ready && !timedOut) || finishing.current) return;
    finishing.current = true;
    // A fast start spends the minimum time filling, rather than sitting full.
    const remaining = MIN_VISIBLE_MS - (Date.now() - shownAt);
    Animated.sequence([
      Animated.timing(fill, {
        toValue: 1,
        duration: Math.max(350, remaining),
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.delay(120),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 450,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => onFinished());
  }, [ready, timedOut, fill, opacity, shownAt, onFinished]);

  const translateX = fill.interpolate({
    inputRange: [0, 1],
    outputRange: [-trackWidth, 0],
  });

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, { opacity }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Loading ${APP_NAME}`}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
    >
      <Image
        source={ARTWORK}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        contentPosition="center"
        transition={0}
        onDisplay={hideNativeSplash}
        onError={hideNativeSplash}
      />
      <View
        pointerEvents="none"
        style={[styles.footer, { bottom: Math.max(insets.bottom, 16) + 34 }]}
      >
        <View style={[styles.glow, { width: trackWidth }]}>
          <View style={styles.track}>
            <Animated.View
              style={[styles.fill, { width: trackWidth, transform: [{ translateX }] }]}
            >
              <LinearGradient
                colors={["#2CC9F2", "#6FE6FF"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          </View>
        </View>
        <Text style={styles.label} maxFontSizeMultiplier={1.2}>
          Loading…
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: "#07090C", zIndex: 1000, elevation: 1000 },
  footer: { position: "absolute", left: 0, right: 0, alignItems: "center", gap: 12 },
  // The shadow sits outside the track, which clips its fill.
  glow: {
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(6,9,12,0.6)",
    shadowColor: "#2CC9F2",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  track: {
    flex: 1,
    borderRadius: 3,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
  },
  fill: { height: "100%", borderRadius: 3, overflow: "hidden" },
  label: {
    color: "rgba(236,240,244,0.72)",
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 1.5,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 6,
  },
});

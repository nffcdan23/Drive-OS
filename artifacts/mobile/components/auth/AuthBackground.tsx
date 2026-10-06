import React from "react";
import { StyleSheet, View } from "react-native";
import { Image, type ImageSource } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";

/**
 * The sign-in artwork. Set to the Derwent login background once it's in
 * assets/images (e.g. require("@/assets/images/login-background.jpg")).
 * Until then the screen uses a dark road-at-dusk gradient.
 */
const ARTWORK: ImageSource | null = null;

/** Full-screen artwork (cover) with scrims that keep the controls legible. */
export default function AuthBackground() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {ARTWORK ? (
        <Image
          source={ARTWORK}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          contentPosition="center"
          accessible={false}
        />
      ) : (
        <LinearGradient
          colors={["#1B2230", "#2A2026", "#3A2418", "#120E0C", "#06080B"]}
          locations={[0, 0.3, 0.46, 0.7, 1]}
          style={StyleSheet.absoluteFill}
        />
      )}
      {/* Top: a light veil for the status bar and logo. */}
      <LinearGradient
        colors={["rgba(4,6,9,0.45)", "rgba(4,6,9,0)"]}
        style={[styles.scrim, { top: 0, height: "22%" }]}
      />
      {/* Bottom: darker behind the controls. */}
      <LinearGradient
        colors={["rgba(4,6,9,0)", "rgba(4,6,9,0.55)", "rgba(4,6,9,0.88)"]}
        locations={[0, 0.4, 1]}
        style={[styles.scrim, { bottom: 0, height: "62%" }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { position: "absolute", left: 0, right: 0 },
});

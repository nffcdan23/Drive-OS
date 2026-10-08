// What a friend's live marker looks like, shared by the Mapbox and Apple/Google
// map layers. Deliberately unlike the user's own cyan location arrow:
//   stationary  a round avatar (initials when there's no photo) in a teal ring
//   driving     the same avatar in a brighter ring with a heading notch that
//               points the way they're going (a car badge when the heading
//               isn't known), so "on the move" reads at a glance
//   stale       the whole marker faded (position older than two minutes)

import React, { memo, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { sectionAccent } from "@/constants/colors";

export const FRIEND_ACCENT = sectionAccent.social; // teal: not the user's cyan
export const FRIEND_MARKER_SIZE = 44; // the whole marker, notch included

const AVATAR = 32;

export interface FriendMarkerFaceProps {
  initials: string;
  avatarUrl: string | null;
  driving: boolean;
  /** Rounded heading in degrees (driving and moving only), else null. */
  headingDeg: number | null;
  stale: boolean;
  selected: boolean;
  /** The avatar image finished loading or failed (Apple Maps re-snapshots then). */
  onImageSettled?: () => void;
}

export const FriendMarkerFace = memo(function FriendMarkerFace({
  initials,
  avatarUrl,
  driving,
  headingDeg,
  stale,
  selected,
  onImageSettled,
}: FriendMarkerFaceProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = !!avatarUrl && !imageFailed;
  return (
    <View
      style={[s.root, stale && s.stale]}
      pointerEvents="none"
      accessibilityElementsHidden
    >
      {driving && headingDeg != null && (
        <View style={[s.notchRing, { transform: [{ rotate: `${headingDeg}deg` }] }]}>
          <View style={s.notch} />
        </View>
      )}
      <View
        style={[
          s.ring,
          driving ? s.ringDriving : s.ringStill,
          selected && s.ringSelected,
        ]}
      >
        {showImage ? (
          <Image
            source={{ uri: avatarUrl! }}
            style={s.avatar}
            onLoad={onImageSettled}
            onError={() => {
              setImageFailed(true);
              onImageSettled?.();
            }}
          />
        ) : (
          <Text style={s.initials} numberOfLines={1}>
            {initials}
          </Text>
        )}
      </View>
      {driving && headingDeg == null && (
        <View style={s.badge}>
          <Ionicons name="car-sport" size={10} color="#0A0D10" />
        </View>
      )}
    </View>
  );
});

const s = StyleSheet.create({
  root: {
    width: FRIEND_MARKER_SIZE,
    height: FRIEND_MARKER_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  stale: { opacity: 0.45 },
  ring: {
    width: AVATAR + 6,
    height: AVATAR + 6,
    borderRadius: (AVATAR + 6) / 2,
    backgroundColor: "#141A20",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  ringStill: { borderWidth: 2, borderColor: "rgba(57,217,160,0.75)" },
  ringDriving: { borderWidth: 3, borderColor: FRIEND_ACCENT },
  ringSelected: { borderColor: "#F3F5F7" },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 },
  initials: { color: "#F3F5F7", fontSize: 13, fontWeight: "700", letterSpacing: 0.3 },
  // A full-size square turned to the heading; the notch sits at its top edge
  notchRing: {
    position: "absolute",
    width: FRIEND_MARKER_SIZE,
    height: FRIEND_MARKER_SIZE,
    alignItems: "center",
  },
  notch: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 7,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: FRIEND_ACCENT,
  },
  badge: {
    position: "absolute",
    right: 2,
    bottom: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: FRIEND_ACCENT,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#0A0D10",
  },
});

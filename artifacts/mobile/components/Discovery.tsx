import React from "react";
import { View, Text, StyleSheet, Image, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassButton, GlassSurface } from "@/components/Glass";
import colors, { sectionAccent } from "@/constants/colors";
import type { DriveOSEvent, Group, Friend } from "@/context/AppContext";
const c = colors.dark;

export function SectionHeader({
  title,
  onPress,
  action = "See All",
}: {
  title: string;
  onPress?: () => void;
  action?: string;
}) {
  return (
    <View style={s.section}>
      <Text style={s.heading}>{title}</Text>
      {onPress && (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={onPress}
          style={s.link}
        >
          <Text style={s.meta}>{action}</Text>
          <Ionicons
            name="chevron-forward"
            size={14}
            color={c.mutedForeground}
          />
        </TouchableOpacity>
      )}
    </View>
  );
}
export function EventPreviewCard({
  event,
  onPress,
}: {
  event: DriveOSEvent;
  onPress: () => void;
}) {
  return (
    <GlassButton
      style={s.card}
      onPress={onPress}
      accessibilityLabel={`View ${event.name}`}
    >
      {event.coverUri ? (
        <Image
          source={{ uri: event.coverUri }}
          style={s.image}
          resizeMode="cover"
        />
      ) : (
        <View style={s.imageFallback}>
          <Ionicons
            name="calendar-outline"
            size={34}
            color={sectionAccent.social}
          />
        </View>
      )}
      <View style={s.content}>
        <Text style={s.name} numberOfLines={2}>
          {event.name}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {event.location}
        </Text>
        <Text style={s.meta}>
          {new Date(event.date + "T12:00:00").toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
          })}{" "}
          · {event.startTime}
        </Text>
        <Text style={s.meta}>{event.attendeeCount} attending</Text>
      </View>
    </GlassButton>
  );
}
export function CommunityPreviewCard({
  group,
  onPress,
}: {
  group: Group;
  onPress: () => void;
}) {
  return (
    <GlassButton
      style={[s.card, { width: 174 }]}
      onPress={onPress}
      accessibilityLabel={`View ${group.name}`}
    >
      {group.logoUri ? (
        <Image
          source={{ uri: group.logoUri }}
          style={s.image}
          resizeMode="cover"
        />
      ) : (
        <View style={s.imageFallback}>
          <Ionicons
            name="people-outline"
            size={38}
            color={sectionAccent.social}
          />
        </View>
      )}
      <View style={s.content}>
        <Text style={s.name} numberOfLines={2}>
          {group.name}
        </Text>
        <Text style={s.meta}>{group.memberCount.toLocaleString()} members</Text>
        {!!group.primaryLocation && (
          <Text style={s.meta} numberOfLines={1}>
            {group.primaryLocation}
          </Text>
        )}
        {group.isMember && (
          <Text style={{ color: sectionAccent.social, fontSize: 12 }}>
            Your community
          </Text>
        )}
      </View>
    </GlassButton>
  );
}
export function UserActivityCard({
  friend,
  onPress,
}: {
  friend: Friend;
  onPress: () => void;
}) {
  const accent =
    friend.status === "driving" ? sectionAccent.drive : sectionAccent.social;
  return (
    <GlassButton
      style={[s.card, { width: 170, padding: 16, gap: 12 }]}
      onPress={onPress}
      accessibilityLabel={`${friend.name}, ${friend.status === "driving" ? "Driving now" : "Online"}`}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {friend.avatarUrl ? (
          <Image source={{ uri: friend.avatarUrl }} style={s.avatar} />
        ) : (
          <GlassSurface
            style={[
              s.avatar,
              { alignItems: "center", justifyContent: "center" },
            ]}
          >
            <Text style={s.name}>{friend.initials}</Text>
          </GlassSurface>
        )}
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: accent,
          }}
        />
      </View>
      <Text style={s.name} numberOfLines={1}>
        {friend.name}
      </Text>
      <Text style={{ color: accent, fontSize: 13 }}>
        {friend.status === "driving" ? "Driving now" : "Online"}
      </Text>
    </GlassButton>
  );
}
const s = StyleSheet.create({
  section: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 20,
    marginTop: 22,
    marginBottom: 12,
  },
  heading: {
    flexShrink: 1,
    color: c.foreground,
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  link: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4 },
  meta: { color: c.mutedForeground, fontSize: 12, lineHeight: 18 },
  card: { width: 210, borderRadius: 20 },
  image: { width: "100%", height: 114 },
  imageFallback: {
    height: 90,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.secondary,
  },
  content: { padding: 12, gap: 5 },
  name: { color: c.foreground, fontSize: 15, fontWeight: "600" },
  avatar: { width: 48, height: 48, borderRadius: 24 },
});

import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp, EventType } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

const EVENT_TYPE_LABELS: Record<EventType, string> = {
  static_car_meet: 'Static Car Meet', scenic_drive: 'Scenic Drive', convoy: 'Convoy',
  road_trip: 'Road Trip', show: 'Show / Exhibition', track_day: 'Track Day',
  closed_course: 'Closed Course Motorsport', charity: 'Charity Event',
  photography: 'Photography Meet', owner_club: 'Owner Club Meet', other: 'Other',
};

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { events, rsvpEvent } = useApp();

  const event = events.find((e) => e.id === id);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top,
      paddingHorizontal: 16, paddingBottom: 12,
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    backBtn: { padding: 4 },
    headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    scroll: { flex: 1 },
    content: { padding: 20, paddingBottom: 40 },
    typeBadge: {
      alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5,
      backgroundColor: colors.primary + '15', borderRadius: 10,
      marginBottom: 12,
    },
    typeBadgeText: { fontSize: 12, color: colors.primary, fontFamily: 'Inter_600SemiBold' },
    eventName: { fontSize: 24, fontWeight: '700', color: colors.foreground, fontFamily: 'Inter_700Bold', marginBottom: 4 },
    eventOrganiser: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginBottom: 16 },
    infoCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 16, marginBottom: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    infoRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    infoRowLast: { borderBottomWidth: 0 },
    infoLabel: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', flex: 1 },
    infoValue: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    descCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 16, marginBottom: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    descTitle: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', marginBottom: 8 },
    descText: { fontSize: 14, color: colors.foreground, fontFamily: 'Inter_400Regular', lineHeight: 21 },
    attendeesRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
    attendeesText: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
    rsvpSection: { marginBottom: 20 },
    rsvpTitle: { fontSize: 15, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold', marginBottom: 10 },
    rsvpRow: { flexDirection: 'row', gap: 10 },
    rsvpBtn: {
      flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
      borderWidth: 1, borderColor: colors.border,
    },
    rsvpGoing: { backgroundColor: colors.primary, borderColor: colors.primary },
    rsvpInterested: { borderColor: colors.primary, backgroundColor: colors.primary + '15' },
    rsvpDeclined: { borderColor: colors.destructive, backgroundColor: colors.destructive + '10' },
    rsvpText: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    rsvpTextGoing: { color: '#fff' },
    rsvpTextInterested: { color: colors.primary },
    rsvpTextDeclined: { color: colors.destructive },
    privacyNote: {
      padding: 12, backgroundColor: colors.muted, borderRadius: 10, marginBottom: 16,
    },
    privacyNoteText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', lineHeight: 18 },
    reportBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingVertical: 12, justifyContent: 'center',
    },
    reportBtnText: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
  });

  if (!event) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Ionicons name="calendar-outline" size={48} color={colors.mutedForeground} />
        <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: '600', marginTop: 12, fontFamily: 'Inter_600SemiBold' }}>Event not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontFamily: 'Inter_500Medium' }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isGoing = event.rsvpStatus === 'going';
  const isInterested = event.rsvpStatus === 'interested';
  const isDeclined = event.rsvpStatus === 'declined';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{event.name}</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.typeBadge}>
          <Text style={styles.typeBadgeText}>{EVENT_TYPE_LABELS[event.eventType]}</Text>
        </View>
        <Text style={styles.eventName}>{event.name}</Text>
        <Text style={styles.eventOrganiser}>Organised by {event.organiser}</Text>

        {!event.isPublic && (
          <View style={styles.privacyNote}>
            <Text style={styles.privacyNoteText}>
              This is a private event. Location details are visible to confirmed attendees only.
            </Text>
          </View>
        )}

        {/* Details card */}
        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Ionicons name="calendar-outline" size={18} color={colors.primary} />
            <Text style={styles.infoLabel}>Date</Text>
            <Text style={styles.infoValue}>{event.date}</Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="time-outline" size={18} color={colors.mutedForeground} />
            <Text style={styles.infoLabel}>Time</Text>
            <Text style={styles.infoValue}>{event.startTime} – {event.endTime}</Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="location-outline" size={18} color={colors.mutedForeground} />
            <Text style={styles.infoLabel}>Location</Text>
            <Text style={styles.infoValue}>{event.location}</Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="car-outline" size={18} color={colors.mutedForeground} />
            <Text style={styles.infoLabel}>Vehicles</Text>
            <Text style={styles.infoValue}>{event.vehicleCategory}</Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="ticket-outline" size={18} color={colors.mutedForeground} />
            <Text style={styles.infoLabel}>Entry</Text>
            <Text style={styles.infoValue}>{event.entryCost}</Text>
          </View>
          <View style={[styles.infoRow, styles.infoRowLast]}>
            <Ionicons name="people-outline" size={18} color={colors.mutedForeground} />
            <Text style={styles.infoLabel}>Capacity</Text>
            <Text style={styles.infoValue}>{event.attendeeCount} / {event.capacity}</Text>
          </View>
        </View>

        {/* Description */}
        {event.description ? (
          <View style={styles.descCard}>
            <Text style={styles.descTitle}>About this event</Text>
            <Text style={styles.descText}>{event.description}</Text>
          </View>
        ) : null}

        {/* RSVP */}
        <View style={styles.rsvpSection}>
          <Text style={styles.rsvpTitle}>Are you going?</Text>
          <View style={styles.rsvpRow}>
            <TouchableOpacity
              style={[styles.rsvpBtn, isGoing && styles.rsvpGoing]}
              onPress={() => { rsvpEvent(event.id, isGoing ? null : 'going'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}>
              <Text style={[styles.rsvpText, isGoing && styles.rsvpTextGoing]}>
                {isGoing ? '✓ Going' : 'Going'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.rsvpBtn, isInterested && styles.rsvpInterested]}
              onPress={() => { rsvpEvent(event.id, isInterested ? null : 'interested'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}>
              <Text style={[styles.rsvpText, isInterested && styles.rsvpTextInterested]}>Interested</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.rsvpBtn, isDeclined && styles.rsvpDeclined]}
              onPress={() => { rsvpEvent(event.id, isDeclined ? null : 'declined'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}>
              <Text style={[styles.rsvpText, isDeclined && styles.rsvpTextDeclined]}>Can't Go</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Actions */}
        <TouchableOpacity onPress={() => Alert.alert('Calendar', 'Calendar export will be available in the next update.')}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }}>
            <Ionicons name="calendar-outline" size={18} color={colors.primary} />
            <Text style={{ fontSize: 14, color: colors.primary, fontFamily: 'Inter_500Medium' }}>Add to Calendar</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => Alert.alert('Share Event', `https://driveos.app/event/${event.id}`)}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }}>
            <Ionicons name="share-outline" size={18} color={colors.primary} />
            <Text style={{ fontSize: 14, color: colors.primary, fontFamily: 'Inter_500Medium' }}>Share Event</Text>
          </View>
        </TouchableOpacity>

        {/* Report */}
        <TouchableOpacity style={styles.reportBtn} onPress={() => Alert.alert('Report Event', 'Report this event to the moderation team?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Report', style: 'destructive', onPress: () => Alert.alert('Reported', 'Thank you — our team will review this event.') },
        ])}>
          <Ionicons name="flag-outline" size={14} color={colors.mutedForeground} />
          <Text style={styles.reportBtnText}>Report this event</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

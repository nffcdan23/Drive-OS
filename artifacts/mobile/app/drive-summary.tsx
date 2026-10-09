/**
 * Drive Complete.  The drive is saved when this screen opens (endDrive, as
 * before), so nothing recorded is lost whatever is tapped next:
 *  - Save Drive applies the chosen visibility and opens Drives;
 *  - Discard deletes the saved drive, after confirming;
 *  - the close button leaves the drive saved as it is.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useApp, type Journey } from '@/context/AppContext';
import type { Visibility } from '@/lib/backend/endpoints';
import { SyncBanner } from '@/components/SyncBanner';
import DriveCompleteView, { type DriveRewards } from '@/components/driveComplete/DriveCompleteView';
import { dayStreak, firstNameOf, levelProgress } from '@/lib/driveRewards';

function confirmDiscard(onConfirm: () => void) {
  const title = 'Discard this drive?';
  const message = "It will be deleted from your drives and can't be recovered.";
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Keep Drive', style: 'cancel' },
    { text: 'Discard', style: 'destructive', onPress: onConfirm },
  ]);
}

export default function DriveSummaryScreen() {
  const router = useRouter();
  const {
    currentDrive, endDrive, updateJourney, deleteJourney, syncStatus, retryJourneySync, resolvedUnitSystem, userProfile,
    journeys,
  } = useApp();
  const [savedJourney, setJourney] = useState<Journey | null>(null);
  const [isSaving, setIsSaving] = useState(true);
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [leaving, setLeaving] = useState(false);
  const endedRef = useRef(false);

  // Snapshot the drive on mount (before endDrive clears it), shown until the
  // saved journey's own figures arrive
  const snapshot = useRef({
    distance: currentDrive?.estimatedDistance ?? 0,
    topSpeed: currentDrive?.topSpeed ?? 0,
    avgSpeed: currentDrive?.speedSamples && currentDrive.speedSamples.length > 0
      ? Math.round(currentDrive.speedSamples.reduce((a, b) => a + b, 0) / currentDrive.speedSamples.length)
      : 0,
    startTime: currentDrive?.startTime ?? Date.now(),
    coordinates: currentDrive?.coordinates ?? [],
    endedAt: Date.now(),
    recorded: !!currentDrive,
  }).current;

  // End the drive once on mount; the sync banner shows if uploading fails
  useEffect(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (!currentDrive) { setIsSaving(false); return; }
    (async () => {
      try {
        const j = await endDrive();
        if (j) {
          setJourney(j);
          // A drive already on the server has the visibility it was given
          // (the account's default for new drives); one still uploading
          // starts at the safest, Only me.
          if (!j.id.startsWith('local:') && j.privacy) setVisibility(j.privacy);
        }
      } finally {
        setIsSaving(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The saved drive, kept current as it syncs (its XP comes from the server)
  // (a drive saved while uploading gets its server id once it syncs; it's
  // the same drive when it started at the same moment)
  const savedStart = savedJourney?.startedAtIso ? Date.parse(savedJourney.startedAtIso) : Number.NaN;
  const journey = savedJourney
    ? journeys.find((j) => j.id === savedJourney.id)
      ?? journeys.find((j) => !!j.startedAtIso && Date.parse(j.startedAtIso) === savedStart)
      ?? savedJourney
    : null;

  const distance = journey?.distance ?? snapshot.distance;
  const duration = journey?.duration ?? Math.round((snapshot.endedAt - snapshot.startTime) / 1000);
  const avgSpeed = journey?.averageSpeed ?? snapshot.avgSpeed;
  const topSpeed = journey?.topSpeed ?? snapshot.topSpeed;
  const route = journey && journey.routeCoordinates.length > 1 ? journey.routeCoordinates : snapshot.coordinates;
  const firstName = firstNameOf(userProfile);
  // Level and XP are the profile's, which the app refreshes once the drive
  // has synced; the streak counts days with a drive, this one included.
  const progress = levelProgress(userProfile.xp, userProfile.xpToNextLevel);
  const rewards: DriveRewards = {
    xpEarned: journey && !journey.id.startsWith('local:') ? journey.xpEarned ?? 0 : null,
    level: userProfile.level,
    levelFraction: progress.fraction,
    xp: progress.xp,
    nextLevelXp: progress.nextLevelXp,
    streakDays: dayStreak([
      ...journeys.map((j) => j.startedAtIso ?? (j.date ? `${j.date}T12:00:00` : null)),
      snapshot.recorded ? new Date(snapshot.startTime).toISOString() : null,
    ]),
  };
  const busy = isSaving || leaving;

  function handleSave() {
    if (busy) return;
    setLeaving(true);
    // Sent when changed, and always for a drive still uploading (it goes
    // with the drive when it completes)
    if (journey && (visibility !== journey.privacy || journey.id.startsWith('local:'))) {
      updateJourney(journey.id, { privacy: visibility });
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace('/(tabs)/journeys');
  }

  function handleDiscard() {
    if (busy || !journey) return;
    confirmDiscard(() => {
      setLeaving(true);
      deleteJourney(journey.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      router.replace('/(tabs)/(drive)');
    });
  }

  function handleClose() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.replace('/(tabs)/(drive)');
  }

  return (
    <DriveCompleteView
      firstName={firstName}
      isSaving={isSaving}
      busy={busy}
      hasJourney={!!journey}
      distanceKm={distance}
      durationS={duration}
      avgSpeedKmh={avgSpeed}
      topSpeedKmh={topSpeed}
      route={route}
      unitSystem={resolvedUnitSystem}
      rewards={rewards}
      visibility={visibility}
      onVisibility={setVisibility}
      visibilityLocked={leaving}
      onSave={handleSave}
      onDiscard={handleDiscard}
      onClose={handleClose}
      syncBanner={
        <SyncBanner
          visible={syncStatus !== 'idle'}
          status={syncStatus === 'syncing' ? 'syncing' : syncStatus === 'error' ? 'error' : 'waiting'}
          onRetry={retryJourneySync}
        />
      }
    />
  );
}

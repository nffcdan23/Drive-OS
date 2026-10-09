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
import DriveCompleteView from '@/components/driveComplete/DriveCompleteView';

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
  } = useApp();
  const [journey, setJourney] = useState<Journey | null>(null);
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

  const distance = journey?.distance ?? snapshot.distance;
  const duration = journey?.duration ?? Math.round((snapshot.endedAt - snapshot.startTime) / 1000);
  const avgSpeed = journey?.averageSpeed ?? snapshot.avgSpeed;
  const topSpeed = journey?.topSpeed ?? snapshot.topSpeed;
  const route = journey && journey.routeCoordinates.length > 1 ? journey.routeCoordinates : snapshot.coordinates;
  const firstName = userProfile?.name?.trim().split(/\s+/)[0];
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

/**
 * Drive Complete.  The drive is saved on the phone when this screen opens
 * (endDrive), so nothing recorded is lost whatever is tapped next; ended at
 * `endAt` when given (where the car stopped: "Looks like you've stopped" →
 * End Drive), else now.  Saving is
 * local-first: endDrive returns once the phone has it and uploads in the
 * background, so neither button ever waits on the network (offline, the
 * drive stays queued and uploads when the connection returns):
 *  - Save Drive applies the chosen visibility and opens Drives;
 *  - Discard deletes the saved drive, after confirming;
 *  - the close button leaves the drive saved as it is.
 *
 * Arrived with navigation (`arrivedAt`, a drive navigation started): the
 * drive is NOT ended on opening.  Continue Drive goes back to the map with
 * the same drive still recording, as a plain drive (navigation has already
 * ended); Save Drive ends it at the moment of arrival and saves it as above;
 * Discard throws it away (after confirming); the close button saves it like
 * Save Drive, so nothing is lost.
 *
 * Upload state isn't shown here: the app-wide ConnectionBanner (top of the
 * screen, in the layout) already reports drives waiting to upload, offline
 * and server errors, with Retry.  Nothing floats over this screen, so Save
 * Drive and Discard are never covered.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useApp, type Journey } from '@/context/AppContext';
import { LocalSaveError } from '@/lib/backend/cloudSync';
import type { Visibility } from '@/lib/backend/endpoints';
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
  const params = useLocalSearchParams<{ endAt?: string; arrivedAt?: string }>();
  const endAt = params.endAt ? Number(params.endAt) : null;
  const arrivedAt = params.arrivedAt ? Number(params.arrivedAt) : null;
  const {
    currentDrive, endDrive, retryDriveSave, updateJourney, deleteJourney, discardDrive, activeDriveMs, resolvedUnitSystem,
    userProfile, journeys,
  } = useApp();
  // Arrived: the drive is still recording until Save Drive (or Discard, or Continue Drive)
  const [arrived, setArrived] = useState(arrivedAt != null && Number.isFinite(arrivedAt) && !!currentDrive);
  const [savedJourney, setJourney] = useState<Journey | null>(null);
  const [isSaving, setIsSaving] = useState(!arrived);
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [leaving, setLeaving] = useState(false);
  // The phone couldn't save the drive (storage failed): it isn't reported as saved
  const [saveError, setSaveError] = useState<string | null>(null);
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
    endedAt: Number.isFinite(endAt) && endAt != null ? endAt : arrived ? arrivedAt! : Date.now(),
    recorded: !!currentDrive,
    // The drive's own driving time (pauses and temporary stops left out), until the saved journey's arrives
    drivenS: Math.round((activeDriveMs() ?? 0) / 1000),
  }).current;

  /** Ends and saves the drive (once): where it stopped, at arrival, or now */
  function save(at: number | null, reason: 'user' | 'stop' | 'arrival') {
    if (endedRef.current) return;
    endedRef.current = true;
    if (!currentDrive) { setIsSaving(false); return; }
    setIsSaving(true);
    (async () => {
      try {
        const j = await endDrive({ endAt: at, reason });
        if (j) {
          setJourney(j);
          // A drive already on the server has the visibility it was given
          // (the account's default for new drives); one still uploading
          // starts at the safest, Only me.
          if (!j.id.startsWith('local:') && j.privacy) setVisibility(j.privacy);
        }
      } catch (err) {
        if (!(err instanceof LocalSaveError)) return; // reported by AppContext
        setJourney(err.journey);
        setSaveError("Couldn't save this drive on your phone. Tap Save Drive to try again.");
      } finally {
        setIsSaving(false);
      }
    })();
  }

  // End the drive once on mount (not when arrived: the driver chooses first);
  // the ConnectionBanner reports it if uploading fails
  useEffect(() => {
    if (arrived) return;
    save(endAt != null && Number.isFinite(endAt) ? endAt : null, endAt != null ? 'stop' : 'user');
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
  const duration = journey?.duration ?? (snapshot.drivenS || Math.round((snapshot.endedAt - snapshot.startTime) / 1000));
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

  async function handleSave() {
    if (busy) return;
    if (arrived) {
      // Ends it now, at the moment of arrival, then on as usual (the visibility goes with it)
      setArrived(false);
      if (!currentDrive) { router.replace('/(tabs)/journeys'); return; }
      save(arrivedAt, 'arrival');
      pendingSave.current = true;
      return;
    }
    setLeaving(true);
    if (saveError) {
      // Only the phone's own save can hold the screen; never the network
      if (!(await retryDriveSave())) {
        setLeaving(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      setSaveError(null);
    }
    // Sent when changed, and always for a drive still uploading (it goes
    // with the drive when it completes)
    if (journey && (visibility !== journey.privacy || journey.id.startsWith('local:'))) {
      updateJourney(journey.id, { privacy: visibility });
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace('/(tabs)/journeys');
  }

  // Save Drive tapped while arrived: finished once the drive is saved
  const pendingSave = useRef(false);
  useEffect(() => {
    if (!pendingSave.current || isSaving) return;
    pendingSave.current = false;
    void handleSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSaving]);

  function handleContinue() {
    if (busy || !arrived) return;
    // The same drive carries on recording, now a plain drive (navigation already ended)
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setLeaving(true);
    router.replace('/(tabs)/(drive)');
  }

  function handleDiscard() {
    if (busy) return;
    if (arrived) {
      confirmDiscard(() => {
        setLeaving(true);
        endedRef.current = true;
        void discardDrive();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        router.replace('/(tabs)/(drive)');
      });
      return;
    }
    if (!journey) return;
    confirmDiscard(() => {
      setLeaving(true);
      deleteJourney(journey.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      router.replace('/(tabs)/(drive)');
    });
  }

  function handleClose() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Arrived: closing saves it (at arrival), so nothing is lost
    if (arrived) save(arrivedAt, 'arrival');
    router.replace('/(tabs)/(drive)');
  }

  return (
    <DriveCompleteView
      firstName={firstName}
      isSaving={isSaving}
      busy={busy}
      hasJourney={arrived ? !!currentDrive : !!journey}
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
      saveError={saveError}
      onContinue={arrived ? handleContinue : undefined}
    />
  );
}

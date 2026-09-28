/**
 * The signed-in user's data for every screen.
 *
 * Supabase (through the DriveOS API) is the source of truth; this provider
 * is a thin React layer over CloudSync, which caches data on the device per
 * user, queues edits made offline and uploads recorded drives. Failures are
 * surfaced (connection banner, alerts), never silently ignored.
 *
 * The provider is mounted per user (keyed by user id), so switching
 * accounts can never show the previous account's data.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AppState } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { CloudSync, type SyncStatus } from '@/lib/backend/cloudSync';
import { describeError } from '@/lib/backend/http';
import type { GpsFix } from '@/lib/backend/journeyRecorder';
import type { LocationKind, SpotCategory, Visibility } from '@/lib/backend/endpoints';
import type {
  ActiveDrive, BlockedUser, Conversation, Convoy, Coordinate, DriveOSEvent, Friend, FriendRequest, Group, Journey,
  JourneyCategory, Message, NearbySpot, Notification, ProfileStats, SavedPlace, UserProfile, Vehicle,
} from '@/lib/backend/model';
import type { PreparedFile } from '@/lib/backend/uploads';
import { base64ToBytes } from '@/lib/backend/bytes';
import { initials } from '@/lib/backend/mappers';
import { UnitSystem, ResolvedUnitSystem, resolveUnitSystem } from '@/lib/units';
import { api, backendEnv, ep, newId, onConnectionStatus } from '@/lib/backendClient';
import { deviceStorage } from '@/lib/secureStorage';

export type {
  Vehicle, VehicleSnapshot, Coordinate, JourneyCategory, Journey, Achievement, UserProfile, Friend, FriendRequest,
  BlockedUser, Convoy, Group, EventType, DriveOSEvent, Conversation, Message, Notification, Destination, ActiveDrive,
  SavedPlace, NearbySpot,
} from '@/lib/backend/model';
export type { SyncStatus as CloudSyncStatus } from '@/lib/backend/cloudSync';

export type SyncStatusSummary = 'idle' | 'syncing' | 'error';

interface AppContextValue {
  vehicles: Vehicle[];
  journeys: Journey[];
  userProfile: UserProfile;
  isPassengerMode: boolean;
  isDriving: boolean;
  currentDrive: ActiveDrive | null;
  activeVehicle: Vehicle | null;

  // Loading & sync
  isLoading: boolean;
  syncStatus: SyncStatusSummary;
  sync: SyncStatus;
  unsyncedJourneyId: string | null;
  retryJourneySync: () => Promise<void>;
  retrySync: () => Promise<void>;
  dismissRejections: () => Promise<void>;
  discardPendingJourney: (id: string) => Promise<void>;

  categories: JourneyCategory[];
  addCategory: (c: Omit<JourneyCategory, 'id'>) => void;
  updateCategory: (id: string, updates: Partial<JourneyCategory>) => void;
  deleteCategory: (id: string) => void;

  setActiveVehicle: (id: string) => void;
  addVehicle: (v: Omit<Vehicle, 'id'>) => void;
  updateVehicle: (id: string, updates: Partial<Vehicle>) => void;
  deleteVehicle: (id: string) => void;
  lookupVehicle: (registration: string) => ReturnType<CloudSync['lookupVehicle']>;

  addJourney: (j: Omit<Journey, 'id'>) => void;
  updateJourney: (id: string, updates: Partial<Journey>) => void;
  deleteJourney: (id: string) => void;

  startDrive: () => void;
  updateDriveCoordinate: (coord: Coordinate & { speed: number; accuracy?: number | null; heading?: number | null; altitude?: number | null; timestamp?: number }) => void;
  endDrive: () => Promise<Journey | null>;
  togglePassengerMode: () => void;

  updateProfile: (updates: Partial<UserProfile>) => void;
  setAvatar: (uri: string) => Promise<void>;

  // Saved places & Beauty Spots
  places: SavedPlace[];
  addPlace: (p: { kind: LocationKind; name: string; coordinate: Coordinate; description?: string; category?: SpotCategory | null; visibility?: Visibility }) => Promise<string>;
  updatePlace: (id: string, updates: Partial<Pick<SavedPlace, 'name' | 'description' | 'visibility' | 'category'>>) => void;
  deletePlace: (id: string) => void;
  findNearbySpots: (lat: number, lng: number, radiusM?: number) => Promise<NearbySpot[]>;

  // Friends
  friends: Friend[];
  friendRequests: FriendRequest[];
  sendFriendRequest: (friendCode: string) => Promise<'pending' | 'accepted'>;
  acceptFriendRequest: (id: string) => void;
  declineFriendRequest: (id: string) => void;
  removeFriend: (id: string) => void;
  blockedUsers: BlockedUser[];
  blockUser: (id: string, name: string) => void;
  unblockUser: (id: string) => void;

  convoys: Convoy[];
  addConvoy: (c: Omit<Convoy, 'id'>) => void;
  updateConvoy: (id: string, updates: Partial<Convoy>) => void;
  deleteConvoy: (id: string) => void;
  joinConvoy: (id: string) => void;
  leaveConvoy: (id: string) => void;

  groups: Group[];
  addGroup: (g: Omit<Group, 'id' | 'createdAt' | 'memberCount' | 'myRole' | 'isMember'>) => void;
  joinGroup: (id: string) => void;
  leaveGroup: (id: string) => void;

  events: DriveOSEvent[];
  addEvent: (e: Omit<DriveOSEvent, 'id' | 'attendeeCount' | 'rsvpStatus'>) => void;
  rsvpEvent: (id: string, status: DriveOSEvent['rsvpStatus']) => void;

  // Messaging has no server yet, so it stays empty rather than faking delivery.
  conversations: Conversation[];
  messages: Message[];
  sendMessage: (conversationId: string, content: string) => void;
  startConversation: (participantId: string, participantName: string, participantInitials: string) => string;
  markConversationRead: (id: string) => void;

  notifications: Notification[];
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  unreadNotificationCount: number;

  unitSystem: UnitSystem;
  resolvedUnitSystem: ResolvedUnitSystem;
  setUnitSystem: (s: UnitSystem) => void;

  profileStats: ProfileStats;
  refreshProfileStats: () => Promise<void>;

  /** Members of a group (admins also see pending requests). Online only. */
  loadGroupMembers: (groupId: string) => Promise<Array<{ id: string; name: string; initials: string; role: string; status: string }>>;
  /** People in a convoy. Online only. */
  loadConvoyParticipants: (convoyId: string) => Promise<Array<{ id: string; name: string; initials: string; role: string }>>;
  /** Maps a temporary local id (record created offline, drive still uploading) to its server id. */
  resolveId: (id: string) => string;
  /** True when there are changes or drives that haven't reached the server. */
  hasUnsyncedWork: () => boolean;
  /** Removes this user's cached data from the device (on sign-out). */
  clearLocalData: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);
const NO_CONVERSATIONS: Conversation[] = [];
const NO_MESSAGES: Message[] = [];

/**
 * Resizes a picked photo (JPEG) so it fits the upload limits, and returns its
 * bytes. The bytes come straight from the image manipulator as base64: Expo's
 * native fetch can't be relied on to read local file:// URIs on Android.
 */
async function prepareUpload(uri: string, width: number): Promise<PreparedFile> {
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width } }], {
    compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true,
  });
  if (!result.base64) throw new Error('The photo could not be read.');
  const bytes = base64ToBytes(result.base64);
  return { body: bytes, size: bytes.length, mimeType: 'image/jpeg' };
}
const prepareImage = (uri: string) => prepareUpload(uri, 1600);
const prepareAvatar = (uri: string) => prepareUpload(uri, 512);

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';

/** Shows an error the user needs to know about (the action didn't happen). */
function reportFailure(action: string, err: unknown) {
  Alert.alert(action, describeError(err));
}

export function AppProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const cloud = useMemo(() => {
    if (!ep || !backendEnv) throw new Error('Backend is not configured');
    const c = new CloudSync({
      ep, store: deviceStorage, userId, publishableKey: backendEnv.supabasePublishableKey, newId, timezone,
      prepareFile: (uri, purpose) => (purpose === 'avatar' ? prepareAvatar(uri) : prepareImage(uri)),
    });
    return c;
  }, [userId]);

  // Re-render on every change inside CloudSync.
  const version = useSyncExternalStore(
    useCallback((fn: () => void) => cloud.subscribe(fn), [cloud]),
    () => cloud.data,
  );
  const status = useSyncExternalStore(
    useCallback((fn: () => void) => cloud.subscribe(fn), [cloud]),
    () => cloud.status,
  );
  const data = version;

  const [isLoading, setIsLoading] = useState(true);
  const [isPassengerMode, setIsPassengerMode] = useState(false);
  const [currentDrive, setCurrentDrive] = useState<ActiveDrive | null>(null);
  const isDriving = currentDrive !== null;

  // Start: cached data first, then the server.
  useEffect(() => {
    cloud.resume();
    const unsubscribe = onConnectionStatus((state, detail) => cloud.reportConnection(state, detail));
    let cancelled = false;
    (async () => {
      await cloud.start();
      if (!cancelled) setIsLoading(false);
      await cloud.sync().catch(() => {});
    })();
    return () => { cancelled = true; unsubscribe(); cloud.dispose(); };
  }, [cloud]);

  // Keep retrying while something is waiting or the server was unreachable,
  // and whenever the app comes back to the foreground.
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const tick = () => {
      const s = statusRef.current;
      if (s.pendingChanges || s.pendingJourneys || s.connection !== 'online') {
        void (async () => {
          if (s.connection !== 'online' && api) await api.ping();
          await cloud.sync().catch(() => {});
        })();
      }
    };
    const timer = setInterval(tick, 30_000);
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') void cloud.sync().catch(() => {}); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [cloud]);

  const activeVehicle = data.vehicles.find((v) => v.isActive) ?? data.vehicles[0] ?? null;
  const activeVehicleRef = useRef(activeVehicle);
  activeVehicleRef.current = activeVehicle;

  // ── Drives ──
  const startDrive = useCallback(() => {
    if (cloud.isDriving) return;
    setCurrentDrive({ startTime: Date.now(), coordinates: [], speedSamples: [], topSpeed: 0, estimatedDistance: 0, currentSpeed: 0 });
    cloud.startDrive(activeVehicleRef.current).catch((err) => reportFailure('Could not start recording', err));
  }, [cloud]);

  const passengerRef = useRef(isPassengerMode);
  passengerRef.current = isPassengerMode;
  const updateDriveCoordinate = useCallback((p: Coordinate & { speed: number; accuracy?: number | null; heading?: number | null; altitude?: number | null; timestamp?: number }) => {
    if (!cloud.isDriving || passengerRef.current) return;
    const fix: GpsFix = {
      latitude: p.latitude, longitude: p.longitude, speedMs: p.speed, headingDeg: p.heading ?? null,
      accuracyM: p.accuracy ?? null, altitudeM: p.altitude ?? null, timestamp: p.timestamp ?? Date.now(),
    };
    cloud.addFix(fix);
    const speedKmh = Math.max(0, p.speed) * 3.6;
    setCurrentDrive((prev) => {
      if (!prev) return prev;
      const last = prev.coordinates[prev.coordinates.length - 1];
      let added = 0;
      if (last) {
        const dLat = (p.latitude - last.latitude) * 111;
        const dLon = (p.longitude - last.longitude) * 111 * Math.cos(p.latitude * (Math.PI / 180));
        added = Math.sqrt(dLat * dLat + dLon * dLon);
      }
      return {
        ...prev,
        coordinates: [...prev.coordinates, { latitude: p.latitude, longitude: p.longitude }],
        speedSamples: [...prev.speedSamples, speedKmh],
        topSpeed: Math.max(prev.topSpeed, speedKmh),
        estimatedDistance: prev.estimatedDistance + added,
        currentSpeed: speedKmh,
      };
    });
  }, [cloud]);

  const endDrive = useCallback(async () => {
    setCurrentDrive(null);
    try {
      return await cloud.endDrive();
    } catch (err) {
      reportFailure('Could not save the drive', err);
      return null;
    }
  }, [cloud]);

  const pendingJourney = data.journeys.find((j) => j.syncState && j.syncState !== 'synced') ?? null;
  const syncSummary: SyncStatusSummary =
    status.refreshing || (status.pendingJourneys > 0 && status.connection === 'online') ? 'syncing'
      : status.connection === 'offline' || status.connection === 'server_error' || status.pendingJourneys > 0 || status.pendingChanges > 0 ? 'error'
        : 'idle';

  // Actions are created once per user so screens can use them in effect deps.
  const actions = useMemo(() => {
    const online = <A extends unknown[]>(label: string, fn: (...a: A) => Promise<unknown>, after?: () => Promise<unknown>) =>
      (...args: A) => {
        // Promise.resolve().then(): a synchronous throw (e.g. an invalid date typed
        // into a form) is reported like any other failure instead of crashing.
        Promise.resolve().then(() => fn(...args))
          .catch((err) => reportFailure(label, err))
          .finally(() => { if (after) after().catch(() => {}); });
      };
    return {
      retryJourneySync: () => cloud.syncJourneys().then(() => cloud.refresh()),
      retrySync: async () => { if (api) await api.ping(); await cloud.sync(); },
      dismissRejections: () => cloud.outbox.dismissRejections(),
      discardPendingJourney: (id: string) => cloud.discardPendingJourney(id),

      addCategory: (c: Omit<JourneyCategory, 'id'>) => void cloud.addCategory(c),
      updateCategory: (id: string, u: Partial<JourneyCategory>) => void cloud.updateCategory(id, u),
      deleteCategory: (id: string) => void cloud.deleteCategory(id),

      setActiveVehicle: (id: string) => void cloud.setActiveVehicle(id),
      addVehicle: (v: Omit<Vehicle, 'id'>) => void cloud.addVehicle(v),
      updateVehicle: (id: string, u: Partial<Vehicle>) => void cloud.updateVehicle(id, u),
      deleteVehicle: (id: string) => void cloud.deleteVehicle(id),
      lookupVehicle: (reg: string) => cloud.lookupVehicle(reg),

      // Journeys are only created by recording a drive.
      addJourney: () => Alert.alert('Not available', 'Journeys are created by recording a drive.'),
      updateJourney: (id: string, u: Partial<Journey>) => void cloud.updateJourney(id, u),
      deleteJourney: (id: string) => void cloud.deleteJourney(id),

      togglePassengerMode: () => setIsPassengerMode((p) => !p),

      updateProfile: (u: Partial<UserProfile>) => void cloud.updateProfile(u),
      setAvatar: (uri: string) => cloud.setAvatar(uri),

      addPlace: (p: Parameters<CloudSync['addPlace']>[0]) => cloud.addPlace(p),
      updatePlace: (id: string, u: Partial<Pick<SavedPlace, 'name' | 'description' | 'visibility' | 'category'>>) => void cloud.updatePlace(id, u),
      deletePlace: (id: string) => void cloud.deletePlace(id),
      findNearbySpots: (lat: number, lng: number, r?: number) => cloud.nearbySpots(lat, lng, r),

      sendFriendRequest: (code: string) => cloud.sendFriendRequest(code),
      acceptFriendRequest: online('Could not accept the request', (id: string) => cloud.acceptFriendRequest(id)),
      declineFriendRequest: online('Could not decline the request', (id: string) => cloud.declineFriendRequest(id)),
      removeFriend: online('Could not remove the friend', (id: string) => cloud.removeFriend(id)),
      blockUser: online('Could not block this driver', (id: string, _name: string) => cloud.blockUser(id)),
      unblockUser: online('Could not unblock this driver', (id: string) => cloud.unblockUser(id)),

      addConvoy: online('Could not create the convoy', (c: Omit<Convoy, 'id'>) => ep!.createConvoy({
        name: c.name, description: c.description, destinationName: c.destination,
        visibility: c.isPrivate ? 'private' : 'public', startsAt: toIso(c.startTime), maxParticipants: c.maxParticipants ?? null,
      }), () => cloud.refreshConvoys()),
      updateConvoy: online('Could not update the convoy', (id: string, u: Partial<Convoy>) => ep!.updateConvoy(id, {
        ...(u.name !== undefined ? { name: u.name } : {}),
        ...(u.description !== undefined ? { description: u.description } : {}),
        ...(u.destination !== undefined ? { destinationName: u.destination } : {}),
        ...(u.isPrivate !== undefined ? { visibility: u.isPrivate ? 'private' : 'public' } : {}),
        ...(u.startTime !== undefined ? { startsAt: toIso(u.startTime) } : {}),
        ...(u.maxParticipants !== undefined ? { maxParticipants: u.maxParticipants } : {}),
        ...(u.status && u.status !== 'forming' ? { status: u.status } : {}),
      }), () => cloud.refreshConvoys()),
      deleteConvoy: online('Could not delete the convoy', (id: string) => ep!.deleteConvoy(id), () => cloud.refreshConvoys()),
      joinConvoy: online('Could not join the convoy', (id: string) => ep!.joinConvoy(id), () => cloud.refreshConvoys()),
      leaveConvoy: online('Could not leave the convoy', (id: string) => ep!.leaveConvoy(id), () => cloud.refreshConvoys()),

      addGroup: online('Could not create the group', (g: Omit<Group, 'id' | 'createdAt' | 'memberCount' | 'myRole' | 'isMember'>) => ep!.createGroup({
        name: g.name, description: g.description, isPublic: g.isPublic, membershipMethod: g.membershipMethod,
        primaryLocation: g.primaryLocation, vehicleInterests: g.vehicleInterests,
      }), () => cloud.refreshGroups()),
      joinGroup: online('Could not join the group', (id: string) => ep!.joinGroup(id), () => cloud.refreshGroups()),
      leaveGroup: online('Could not leave the group', (id: string) => ep!.leaveGroup(id), () => cloud.refreshGroups()),

      addEvent: online('Could not create the event', (e: Omit<DriveOSEvent, 'id' | 'attendeeCount' | 'rsvpStatus'>) => ep!.createEvent({
        name: e.name, description: e.description, locationName: e.location,
        startsAt: toIso(`${e.date}T${e.startTime || '09:00'}`), timezone: timezone(),
        eventType: e.eventType, visibility: e.groupId && !e.isPublic ? 'group' : e.isPublic ? 'public' : 'private',
        ...(e.groupId ? { groupId: e.groupId } : {}),
        ...(e.capacity > 0 ? { capacity: e.capacity } : {}),
        entryCost: e.entryCost || 'Free', vehicleCategory: e.vehicleCategory || 'All',
      }).then((created) => ep!.rsvpEvent(created.id, 'going')), () => cloud.refreshEvents()),
      rsvpEvent: online('Could not update your RSVP', (id: string, st: DriveOSEvent['rsvpStatus']) =>
        (st ? ep!.rsvpEvent(id, st) : ep!.withdrawRsvp(id)), () => cloud.refreshEvents()),

      sendMessage: () => Alert.alert('Messaging is coming soon', 'Messages are not delivered yet, so nothing was sent.'),
      startConversation: () => { Alert.alert('Messaging is coming soon', 'Direct messages are not available yet.'); return ''; },
      markConversationRead: () => {},

      markNotificationRead: online('Could not update the notification', (id: string) => cloud.markNotificationRead(id)),
      markAllNotificationsRead: online('Could not update notifications', () => cloud.markAllNotificationsRead()),

      setUnitSystem: (st: UnitSystem) => void cloud.setUnitSystem(st),
      refreshProfileStats: () => cloud.refreshFriends().catch(() => {}),

      loadGroupMembers: async (groupId: string) => (await ep!.getGroup(groupId)).members.map((m) => ({
        id: m.id, name: m.displayName, initials: initials(m.displayName), role: m.role, status: m.status,
      })),
      loadConvoyParticipants: async (convoyId: string) => (await ep!.getConvoy(convoyId)).participants.map((p) => ({
        id: p.id, name: p.displayName, initials: initials(p.displayName), role: p.role,
      })),
      resolveId: (id: string) => cloud.resolveJourneyId(cloud.outbox.resolve(id)),
      hasUnsyncedWork: () => cloud.hasUnsyncedWork,
      clearLocalData: () => cloud.wipeLocal(),
      deleteAccount: async () => {
        await ep!.deleteAccount();
        await cloud.wipeLocal();
      },
    };
  }, [cloud]);

  const value: AppContextValue = {
    ...actions,
    vehicles: data.vehicles,
    journeys: data.journeys,
    userProfile: data.profile,
    isPassengerMode, isDriving, currentDrive, activeVehicle,
    isLoading,
    syncStatus: syncSummary,
    sync: status,
    unsyncedJourneyId: pendingJourney?.id ?? null,
    categories: data.categories,
    startDrive, updateDriveCoordinate, endDrive,
    places: data.places,
    friends: data.friends,
    friendRequests: data.friendRequests,
    blockedUsers: data.blockedUsers,
    convoys: data.convoys,
    groups: data.groups,
    events: data.events,
    conversations: NO_CONVERSATIONS,
    messages: NO_MESSAGES,
    notifications: data.notifications,
    unreadNotificationCount: data.notifications.filter((n) => !n.read).length,
    unitSystem: data.unitSystem,
    resolvedUnitSystem: resolveUnitSystem(data.unitSystem),
    profileStats: data.profileStats,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Accepts ISO strings or "YYYY-MM-DDTHH:MM" local times from the forms. */
function toIso(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Enter a valid date and time.');
  return d.toISOString();
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

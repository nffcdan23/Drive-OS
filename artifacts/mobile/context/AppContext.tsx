import React, {
  createContext, useContext, useEffect, useState, useCallback, useRef,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MOCK_VEHICLES, MOCK_JOURNEYS, MOCK_ACHIEVEMENTS,
  MOCK_FRIENDS, MOCK_CONVOYS, DEFAULT_CATEGORIES,
  MOCK_GROUPS, MOCK_EVENTS, MOCK_CONVERSATIONS, MOCK_MESSAGES, MOCK_NOTIFICATIONS,
} from '@/constants/mockData';
import {
  apiGetMe, apiGetVehicles, apiGetJourneys, apiGetCategories,
  apiGetNotifications, apiStartJourney, apiAddRoutePoints,
  apiCompleteJourney, apiUpdateJourney, apiDeleteJourney, apiCreateVehicle,
  apiUpdateVehicle, apiDeleteVehicle, apiActivateVehicle,
  ApiVehicle, ApiJourney,
} from '@/lib/apiClient';
import {
  loadDraft, saveDraft, clearDraft, clearPendingPoints,
  JourneyDraft, DraftRoutePoint,
} from '@/lib/journeyDraft';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Vehicle {
  id: string;
  nickname: string;
  registration: string;
  make: string;
  model: string;
  year: number;
  colour: string;
  fuelType: 'petrol' | 'diesel' | 'electric' | 'hybrid';
  engine: string;
  power: string;
  torque: string;
  zeroToSixty: string;
  topSpeed: string;
  mileage: number;
  fuelPercentage: number;
  imageUri: string | null;
  isActive: boolean;
}

export interface VehicleSnapshot {
  vehicleId: string;
  make: string;
  model: string;
  nickname: string;
  year: number;
  registration: string;
  imageUri: string | null;
  power: string;
  engine: string;
}

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface JourneyCategory {
  id: string;
  name: string;
  icon: string;
  colour: string;
}

export interface Journey {
  id: string;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;   // seconds
  distance: number;   // km
  averageSpeed: number; // km/h
  topSpeed: number;     // km/h
  vehicleId: string;
  notes: string;
  routeCoordinates: Coordinate[];
  photos: string[];
  categoryId?: string;
  journeyType?: 'personal' | 'convoy';
  xpEarned?: number;
  vehicleSnapshot?: VehicleSnapshot;
  privacy?: 'private' | 'friends' | 'public';
  convoyId?: string;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  unlockedAt: string | null;
}

export interface UserProfile {
  name: string;
  level: number;
  xp: number;
  xpToNextLevel: number;
  totalDistance: number;
  totalJourneys: number;
  achievements: Achievement[];
  username?: string;
  bio?: string;
  friendCode?: string;
}

export interface Friend {
  id: string;
  name: string;
  initials: string;
  status: 'online' | 'offline' | 'driving';
  location: string;
}

export interface FriendRequest {
  id: string;
  fromId: string;
  fromName: string;
  fromInitials: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
  isIncoming: boolean;
}

export interface BlockedUser {
  id: string;
  blockedName: string;
}

export interface Convoy {
  id: string;
  name: string;
  leaderId: string;
  leaderName: string;
  destination: string;
  driverCount: number;
  isPrivate: boolean;
  startTime: string;
  status: 'forming' | 'active' | 'completed' | 'cancelled';
  description: string;
  maxParticipants?: number;
  privacyMethod?: 'invite_only' | 'passcode' | 'group_members';
  isOwn?: boolean;
  isJoined?: boolean;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  logoUri: string | null;
  isPublic: boolean;
  memberCount: number;
  membershipMethod: 'open' | 'request' | 'invite' | 'code';
  myRole: 'owner' | 'admin' | 'moderator' | 'verified_member' | 'member' | null;
  isMember: boolean;
  primaryLocation: string;
  vehicleInterests: string;
  createdAt: string;
}

export type EventType =
  | 'static_car_meet' | 'scenic_drive' | 'convoy' | 'road_trip'
  | 'show' | 'track_day' | 'closed_course' | 'charity' | 'photography'
  | 'owner_club' | 'other';

export interface DriveOSEvent {
  id: string;
  name: string;
  description: string;
  coverUri: string | null;
  location: string;
  date: string;
  startTime: string;
  endTime: string;
  eventType: EventType;
  isPublic: boolean;
  groupId: string | null;
  capacity: number;
  attendeeCount: number;
  organiser: string;
  vehicleCategory: string;
  rsvpStatus: 'going' | 'interested' | 'declined' | null;
  entryCost: string;
}

export interface Conversation {
  id: string;
  participantId: string;
  participantName: string;
  participantInitials: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: string;
  isOwn: boolean;
}

export interface Notification {
  id: string;
  type: 'friend_request' | 'friend_accepted' | 'message' | 'convoy_invite'
    | 'convoy_updated' | 'convoy_cancelled' | 'group_invite'
    | 'group_request_result' | 'group_news' | 'event_invite' | 'event_reminder';
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}

export interface Destination {
  id: string;
  name: string;
  address: string;
  type: 'home' | 'work' | 'favourite' | 'recent' | 'scenic' | 'search';
  coordinate: Coordinate;
}

export interface ActiveDrive {
  startTime: number;
  coordinates: Coordinate[];
  speedSamples: number[];
  topSpeed: number;
  estimatedDistance: number;
  currentSpeed: number;
}

// ─── Context ──────────────────────────────────────────────────────────────────

export type SyncStatus = 'idle' | 'syncing' | 'error';

interface AppContextValue {
  // Core
  vehicles: Vehicle[];
  journeys: Journey[];
  userProfile: UserProfile;
  isPassengerMode: boolean;
  isDriving: boolean;
  currentDrive: ActiveDrive | null;
  activeVehicle: Vehicle | null;

  // Loading & sync state
  isLoading: boolean;
  syncStatus: SyncStatus;
  unsyncedJourneyId: string | null;
  retryJourneySync: () => Promise<void>;

  // Journey categories
  categories: JourneyCategory[];
  addCategory: (c: Omit<JourneyCategory, 'id'>) => void;
  updateCategory: (id: string, updates: Partial<JourneyCategory>) => void;
  deleteCategory: (id: string) => void;

  // Vehicles
  setActiveVehicle: (id: string) => void;
  addVehicle: (v: Omit<Vehicle, 'id'>) => void;
  updateVehicle: (id: string, updates: Partial<Vehicle>) => void;
  deleteVehicle: (id: string) => void;

  // Journeys
  addJourney: (j: Omit<Journey, 'id'>) => void;
  updateJourney: (id: string, updates: Partial<Journey>) => void;
  deleteJourney: (id: string) => void;

  // Driving
  startDrive: () => void;
  updateDriveCoordinate: (coord: Coordinate & { speed: number }) => void;
  endDrive: () => Promise<Journey | null>;
  togglePassengerMode: () => void;

  // Profile
  updateProfile: (updates: Partial<UserProfile>) => void;

  // Friends
  friends: Friend[];
  friendRequests: FriendRequest[];
  sendFriendRequest: (name: string, initials: string) => void;
  acceptFriendRequest: (id: string) => void;
  declineFriendRequest: (id: string) => void;
  removeFriend: (id: string) => void;
  blockedUsers: BlockedUser[];
  blockUser: (id: string, name: string) => void;
  unblockUser: (id: string) => void;

  // Convoys
  convoys: Convoy[];
  addConvoy: (c: Omit<Convoy, 'id'>) => void;
  updateConvoy: (id: string, updates: Partial<Convoy>) => void;
  deleteConvoy: (id: string) => void;
  joinConvoy: (id: string) => void;
  leaveConvoy: (id: string) => void;

  // Groups
  groups: Group[];
  addGroup: (g: Omit<Group, 'id' | 'createdAt' | 'memberCount' | 'myRole' | 'isMember'>) => void;
  joinGroup: (id: string) => void;
  leaveGroup: (id: string) => void;

  // Events
  events: DriveOSEvent[];
  addEvent: (e: Omit<DriveOSEvent, 'id' | 'attendeeCount' | 'rsvpStatus'>) => void;
  rsvpEvent: (id: string, status: DriveOSEvent['rsvpStatus']) => void;

  // Messaging
  conversations: Conversation[];
  messages: Message[];
  sendMessage: (conversationId: string, content: string) => void;
  startConversation: (participantId: string, participantName: string, participantInitials: string) => string;
  markConversationRead: (id: string) => void;

  // Notifications
  notifications: Notification[];
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  unreadNotificationCount: number;
}

const AppContext = createContext<AppContextValue | null>(null);

// ─── Storage keys ─────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  VEHICLES:       '@driveos/vehicles',
  JOURNEYS:       '@driveos/journeys',
  PROFILE:        '@driveos/profile',
  PASSENGER_MODE: '@driveos/passengerMode',
  CATEGORIES:     '@driveos/categories',
  CONVOYS:        '@driveos/convoys',
  FRIENDS:        '@driveos/friends',
  FRIEND_REQUESTS:'@driveos/friendRequests',
  BLOCKED:        '@driveos/blocked',
  GROUPS:         '@driveos/groups',
  EVENTS:         '@driveos/events',
  CONVERSATIONS:  '@driveos/conversations',
  MESSAGES:       '@driveos/messages',
  NOTIFICATIONS:  '@driveos/notifications',
};

// ─── Default profile ──────────────────────────────────────────────────────────

const DEFAULT_PROFILE: UserProfile = {
  name: 'Driver',
  username: undefined,
  bio: undefined,
  friendCode: undefined,
  level: 1,
  xp: 0,
  xpToNextLevel: 1000,
  totalDistance: 0,
  totalJourneys: 0,
  achievements: MOCK_ACHIEVEMENTS,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

function snapshotVehicle(v: Vehicle): VehicleSnapshot {
  return {
    vehicleId: v.id, make: v.make, model: v.model, nickname: v.nickname,
    year: v.year, registration: v.registration, imageUri: v.imageUri,
    power: v.power, engine: v.engine,
  };
}

/** Map an API vehicle to the local Vehicle shape. */
function apiVehicleToLocal(v: ApiVehicle): Vehicle {
  return {
    id:             v.id,
    nickname:       v.nickname,
    registration:   v.registration,
    make:           v.make,
    model:          v.model,
    year:           v.year,
    colour:         v.colour,
    fuelType:       (v.fuelType as Vehicle['fuelType']) ?? 'petrol',
    engine:         v.engine,
    power:          v.power,
    torque:         v.torque,
    zeroToSixty:    v.zeroToSixty,
    topSpeed:       v.topSpeedSpec,
    mileage:        v.mileage,
    fuelPercentage: 75, // not in DB, use default
    imageUri:       v.imageUrl ?? null,
    isActive:       v.isActive,
  };
}

/** Map an API journey to the local Journey shape. */
function apiJourneyToLocal(j: ApiJourney): Journey {
  const toTime = (iso: string | null) => {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  return {
    id:              j.id,
    name:            j.name,
    date:            j.date,
    startTime:       toTime(j.startTimeIso),
    endTime:         toTime(j.endTimeIso),
    duration:        j.durationSeconds,
    distance:        j.distanceKm,
    averageSpeed:    j.avgSpeedKmh,
    topSpeed:        j.topSpeedKmh,
    vehicleId:       j.vehicleId ?? '',
    notes:           j.notes,
    routeCoordinates: [],
    photos:          (j.photos as string[]) ?? [],
    categoryId:      j.categoryId ?? undefined,
    journeyType:     (j.journeyType as Journey['journeyType']) ?? 'personal',
    xpEarned:        j.xpEarned,
    privacy:         (j.privacy as Journey['privacy']) ?? 'private',
    convoyId:        j.convoyId ?? undefined,
    vehicleSnapshot: j.vehicleSnapshot ? (j.vehicleSnapshot as VehicleSnapshot) : undefined,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [vehicles,       setVehicles]       = useState<Vehicle[]>(MOCK_VEHICLES);
  const [journeys,       setJourneys]       = useState<Journey[]>(MOCK_JOURNEYS);
  const [userProfile,    setUserProfile]    = useState<UserProfile>(DEFAULT_PROFILE);
  const [isPassengerMode,setIsPassengerMode]= useState(false);
  const [isDriving,      setIsDriving]      = useState(false);
  const [currentDrive,   setCurrentDrive]   = useState<ActiveDrive | null>(null);
  const [categories,     setCategories]     = useState<JourneyCategory[]>(DEFAULT_CATEGORIES);
  const [convoys,        setConvoys]        = useState<Convoy[]>(MOCK_CONVOYS);
  const [friends,        setFriends]        = useState<Friend[]>(MOCK_FRIENDS);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [blockedUsers,   setBlockedUsers]   = useState<BlockedUser[]>([]);
  const [groups,         setGroups]         = useState<Group[]>(MOCK_GROUPS);
  const [events,         setEvents]         = useState<DriveOSEvent[]>(MOCK_EVENTS);
  const [conversations,  setConversations]  = useState<Conversation[]>(MOCK_CONVERSATIONS);
  const [messages,       setMessages]       = useState<Message[]>(MOCK_MESSAGES);
  const [notifications,  setNotifications]  = useState<Notification[]>(MOCK_NOTIFICATIONS);
  const [loaded,         setLoaded]         = useState(false);
  const [isLoading,      setIsLoading]      = useState(true);
  const [syncStatus,     setSyncStatus]     = useState<SyncStatus>('idle');
  const [unsyncedJourneyId, setUnsyncedJourneyId] = useState<string | null>(null);

  // Refs for drive lifecycle (not reactive — just for internal coordination)
  const serverJourneyIdRef = useRef<string | null>(null);
  const journeyDraftRef    = useRef<JourneyDraft | null>(null);
  const flushIntervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeVehicleRef   = useRef<Vehicle | null>(null);

  // Keep activeVehicleRef in sync so callbacks close over the latest value
  const activeVehicle = vehicles.find((v) => v.isActive) ?? vehicles[0] ?? null;
  activeVehicleRef.current = activeVehicle;

  // ── Step 1: Load from AsyncStorage (fast, offline-capable) ──────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const results = await Promise.all(
          Object.values(STORAGE_KEYS).map((k) => AsyncStorage.getItem(k))
        );
        const keys = Object.keys(STORAGE_KEYS) as (keyof typeof STORAGE_KEYS)[];
        const map: Record<string, string | null> = {};
        keys.forEach((k, i) => { map[STORAGE_KEYS[k]] = results[i]; });

        const parse = (k: string, fallback: unknown) => {
          const v = map[k];
          return v ? JSON.parse(v) : fallback;
        };

        setVehicles(parse(STORAGE_KEYS.VEHICLES, MOCK_VEHICLES));
        setJourneys(parse(STORAGE_KEYS.JOURNEYS, MOCK_JOURNEYS));
        setUserProfile(parse(STORAGE_KEYS.PROFILE, DEFAULT_PROFILE));
        setIsPassengerMode(parse(STORAGE_KEYS.PASSENGER_MODE, false));
        setCategories(parse(STORAGE_KEYS.CATEGORIES, DEFAULT_CATEGORIES));
        setConvoys(parse(STORAGE_KEYS.CONVOYS, MOCK_CONVOYS));
        setFriends(parse(STORAGE_KEYS.FRIENDS, MOCK_FRIENDS));
        setFriendRequests(parse(STORAGE_KEYS.FRIEND_REQUESTS, []));
        setBlockedUsers(parse(STORAGE_KEYS.BLOCKED, []));
        setGroups(parse(STORAGE_KEYS.GROUPS, MOCK_GROUPS));
        setEvents(parse(STORAGE_KEYS.EVENTS, MOCK_EVENTS));
        setConversations(parse(STORAGE_KEYS.CONVERSATIONS, MOCK_CONVERSATIONS));
        setMessages(parse(STORAGE_KEYS.MESSAGES, MOCK_MESSAGES));
        setNotifications(parse(STORAGE_KEYS.NOTIFICATIONS, MOCK_NOTIFICATIONS));
      } catch {
        // Use defaults on failure
      } finally {
        setLoaded(true);
      }
    };
    load();
  }, []);

  // ── Step 2: Load from API (authoritative, replaces local data) ──────────────
  useEffect(() => {
    if (!loaded) return; // wait for AsyncStorage to load first

    const loadFromApi = async () => {
      try {
        // Parallel fetch everything
        const [me, apiVehicles, apiJourneys, apiCats, apiNotifs] = await Promise.all([
          apiGetMe().catch(() => null),
          apiGetVehicles().catch(() => null),
          apiGetJourneys().catch(() => null),
          apiGetCategories().catch(() => null),
          apiGetNotifications().catch(() => null),
        ]);

        // Always apply API responses — even empty arrays are authoritative.
        // Mock / seed data is only the offline fallback; once the API responds
        // (even with []) the server is the source of truth.
        if (me) {
          setUserProfile((prev) => ({
            ...prev,
            name:          me.name,
            username:      me.username ?? prev.username,
            bio:           me.bio ?? prev.bio,
            friendCode:    me.friendCode ?? prev.friendCode,
            level:         me.level,
            xp:            me.xp,
            xpToNextLevel: me.xpToNextLevel,
            totalDistance: me.totalDistance,
            totalJourneys: me.totalJourneys,
          }));
        }

        if (apiVehicles !== null) {
          setVehicles(apiVehicles.map(apiVehicleToLocal));
        }

        if (apiJourneys !== null) {
          setJourneys(apiJourneys.map(apiJourneyToLocal));
        }

        if (apiCats !== null) {
          setCategories(apiCats.map((c) => ({
            id:     c.id,
            name:   c.name,
            icon:   c.icon,
            colour: c.colour,
          })));
        }

        if (apiNotifs !== null) {
          setNotifications(
            apiNotifs.map((n) => ({
              id:        n.id,
              type:      n.type as Notification['type'],
              title:     n.title,
              body:      n.body,
              read:      n.read,
              createdAt: n.createdAt,
            }))
          );
        }

        // Check for an unfinished draft (from a previous session that crashed)
        const draft = await loadDraft();
        if (draft && draft.journeyId) {
          journeyDraftRef.current = draft;
          serverJourneyIdRef.current = draft.journeyId;
          // Note: We don't restore isDriving=true because the GPS session is gone.
          // Instead, we show the sync banner so the user can complete the save.
          setSyncStatus('error');
          setUnsyncedJourneyId(`draft:${draft.journeyId}`);
        }
      } catch {
        // API unavailable — continue with local data
      } finally {
        setIsLoading(false);
      }
    };

    loadFromApi();
  }, [loaded]);

  // ── Persist state to AsyncStorage whenever it changes ────────────────────────
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.VEHICLES, JSON.stringify(vehicles)); }, [vehicles, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.JOURNEYS, JSON.stringify(journeys)); }, [journeys, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(userProfile)); }, [userProfile, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.PASSENGER_MODE, JSON.stringify(isPassengerMode)); }, [isPassengerMode, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(categories)); }, [categories, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.CONVOYS, JSON.stringify(convoys)); }, [convoys, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.FRIENDS, JSON.stringify(friends)); }, [friends, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.FRIEND_REQUESTS, JSON.stringify(friendRequests)); }, [friendRequests, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.BLOCKED, JSON.stringify(blockedUsers)); }, [blockedUsers, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.GROUPS, JSON.stringify(groups)); }, [groups, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(events)); }, [events, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(conversations)); }, [conversations, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.MESSAGES, JSON.stringify(messages)); }, [messages, loaded]);
  useEffect(() => { if (!loaded) return; AsyncStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(notifications)); }, [notifications, loaded]);

  // ── Flush pending route points every 30 s during a drive ─────────────────────
  const flushPendingPoints = useCallback(async () => {
    const draft   = journeyDraftRef.current;
    const serverId = serverJourneyIdRef.current;
    if (!draft || !serverId || draft.pendingPoints.length === 0) return;

    try {
      await apiAddRoutePoints(
        serverId,
        draft.pendingPoints.map((p) => ({
          latitude:   p.latitude,
          longitude:  p.longitude,
          speedKmh:   p.speedKmh,
          accuracyM:  p.accuracyM,
          recordedAt: p.recordedAt,
        })),
      );
      const updated = await clearPendingPoints(draft);
      journeyDraftRef.current = updated;
    } catch {
      // Keep pending points — will retry on next flush
    }
  }, []);

  // ── Vehicle methods ──────────────────────────────────────────────────────────

  const setActiveVehicle = useCallback((id: string) => {
    setVehicles((prev) => prev.map((v) => ({ ...v, isActive: v.id === id })));
    // Fire-and-forget API call
    apiActivateVehicle(id).catch(() => {});
  }, []);

  const addVehicle = useCallback((v: Omit<Vehicle, 'id'>) => {
    const localId = generateId();
    const newV: Vehicle = { ...v, id: localId };
    setVehicles((prev) => [...prev, newV]);

    // Sync to API in background
    apiCreateVehicle({
      nickname:     v.nickname,
      registration: v.registration,
      make:         v.make,
      model:        v.model,
      year:         v.year,
      colour:       v.colour,
      fuelType:     v.fuelType,
      engine:       v.engine,
      power:        v.power,
      torque:       v.torque,
      zeroToSixty:  v.zeroToSixty,
      topSpeedSpec: v.topSpeed,
      mileage:      v.mileage,
      imageUrl:     v.imageUri,
      isActive:     v.isActive,
    }).then((serverV) => {
      // Replace local ID with server ID
      setVehicles((prev) =>
        prev.map((existing) => existing.id === localId ? apiVehicleToLocal(serverV) : existing)
      );
    }).catch(() => {
      // Vehicle stays in local state — will sync on next load from API
    });
  }, []);

  const updateVehicle = useCallback((id: string, updates: Partial<Vehicle>) => {
    setVehicles((prev) => prev.map((v) => (v.id === id ? { ...v, ...updates } : v)));
    // API update (best-effort)
    apiUpdateVehicle(id, {
      nickname:     updates.nickname,
      registration: updates.registration,
      make:         updates.make,
      model:        updates.model,
      year:         updates.year,
      colour:       updates.colour,
      fuelType:     updates.fuelType,
      engine:       updates.engine,
      power:        updates.power,
      torque:       updates.torque,
      zeroToSixty:  updates.zeroToSixty,
      topSpeedSpec: updates.topSpeed,
      mileage:      updates.mileage,
      imageUrl:     updates.imageUri,
      isActive:     updates.isActive,
    }).catch(() => {});
  }, []);

  const deleteVehicle = useCallback((id: string) => {
    setVehicles((prev) => {
      const filtered = prev.filter((v) => v.id !== id);
      if (filtered.length > 0 && !filtered.some((v) => v.isActive)) {
        return filtered.map((v, i) => ({ ...v, isActive: i === 0 }));
      }
      return filtered;
    });
    apiDeleteVehicle(id).catch(() => {});
  }, []);

  // ── Category methods ─────────────────────────────────────────────────────────

  const addCategory = useCallback((c: Omit<JourneyCategory, 'id'>) => {
    setCategories((prev) => [...prev, { ...c, id: generateId() }]);
  }, []);

  const updateCategory = useCallback((id: string, updates: Partial<JourneyCategory>) => {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  }, []);

  const deleteCategory = useCallback((id: string) => {
    setCategories((prev) => prev.filter((c) => c.id !== id));
    setJourneys((prev) => prev.map((j) => j.categoryId === id ? { ...j, categoryId: undefined } : j));
  }, []);

  // ── Journey methods ──────────────────────────────────────────────────────────

  const addJourney = useCallback((j: Omit<Journey, 'id'>) => {
    const newJ: Journey = { ...j, id: generateId() };
    setJourneys((prev) => [newJ, ...prev]);
    setUserProfile((prev) => ({
      ...prev,
      totalJourneys: prev.totalJourneys + 1,
      totalDistance: Math.round((prev.totalDistance + j.distance) * 10) / 10,
      xp:            prev.xp + (j.xpEarned ?? Math.round(j.distance * 2)),
    }));
  }, []);

  const updateJourney = useCallback((id: string, updates: Partial<Journey>) => {
    setJourneys((prev) => prev.map((j) => (j.id === id ? { ...j, ...updates } : j)));
    // Also update on server (best-effort)
    apiUpdateJourney(id, {
      name:       updates.name,
      notes:      updates.notes,
      categoryId: updates.categoryId,
      privacy:    updates.privacy,
      photos:     updates.photos,
    }).catch(() => {});
  }, []);

  const deleteJourney = useCallback((id: string) => {
    // Optimistic delete — revert if server rejects
    setJourneys((prev) => {
      const snapshot = prev;
      apiDeleteJourney(id).catch(() => {
        setJourneys(snapshot);
      });
      return prev.filter((j) => j.id !== id);
    });
  }, []);

  // ── Drive methods ────────────────────────────────────────────────────────────

  const startDrive = useCallback(() => {
    if (isDriving) return;
    const av = activeVehicleRef.current;
    const startTime = Date.now();
    const now = new Date();

    setCurrentDrive({
      startTime,
      coordinates: [], speedSamples: [], topSpeed: 0, estimatedDistance: 0, currentSpeed: 0,
    });
    setIsDriving(true);

    // Fire-and-forget: create journey on server + draft
    (async () => {
      try {
        const serverJourney = await apiStartJourney({
          vehicleId:       av?.id ?? undefined,
          vehicleSnapshot: av ? snapshotVehicle(av) : undefined,
          name:            'Active Journey',
          date:            now.toISOString().split('T')[0],
          startTimeIso:    now.toISOString(),
        });

        serverJourneyIdRef.current = serverJourney.id;

        const draft: JourneyDraft = {
          draftId:         generateId(),
          journeyId:       serverJourney.id,
          vehicleId:       av?.id ?? null,
          vehicleSnapshot: av ? snapshotVehicle(av) : null,
          startTime,
          routePoints:     [],
          pendingPoints:   [],
          stats:           { distanceKm: 0, topSpeedKmh: 0, speedSamples: [] },
        };
        await saveDraft(draft);
        journeyDraftRef.current = draft;

        // Start periodic flush every 30 s
        if (flushIntervalRef.current) clearInterval(flushIntervalRef.current);
        flushIntervalRef.current = setInterval(() => {
          flushPendingPoints();
        }, 30_000);
      } catch {
        // API unavailable — drive continues in local-only mode
        serverJourneyIdRef.current = null;
      }
    })();
  }, [isDriving, flushPendingPoints]);

  const updateDriveCoordinate = useCallback((data: Coordinate & { speed: number }) => {
    if (!isDriving || isPassengerMode) return;
    const speedKmh = data.speed * 3.6;

    const point: DraftRoutePoint = {
      latitude:   data.latitude,
      longitude:  data.longitude,
      speedKmh,
      accuracyM:  undefined,
      recordedAt: new Date().toISOString(),
    };

    // Update draft synchronously on the ref so retry always has accurate stats.
    // Build the full updated draft in one shot (stats + new route point) and
    // persist it asynchronously via saveDraft — avoids stale-snapshot races
    // that would arise from using the appendRoutePoints return value.
    if (journeyDraftRef.current) {
      const draft = journeyDraftRef.current;
      const lastPt = draft.routePoints[draft.routePoints.length - 1];
      let draftAddedKm = 0;
      if (lastPt) {
        const dLat = (data.latitude - lastPt.latitude) * 111;
        const dLon = (data.longitude - lastPt.longitude)
          * 111 * Math.cos(data.latitude * (Math.PI / 180));
        draftAddedKm = Math.sqrt(dLat * dLat + dLon * dLon);
      }

      const updatedDraft: JourneyDraft = {
        ...draft,
        routePoints:   [...draft.routePoints, point],
        pendingPoints: [...draft.pendingPoints, point],
        stats: {
          distanceKm:   draft.stats.distanceKm + draftAddedKm,
          topSpeedKmh:  Math.max(draft.stats.topSpeedKmh, speedKmh),
          speedSamples: [...draft.stats.speedSamples, speedKmh],
        },
      };

      journeyDraftRef.current = updatedDraft;
      // Best-effort persistence — in-memory ref is the source of truth
      saveDraft(updatedDraft).catch(() => {});
    }

    // Update React state for UI
    setCurrentDrive((prev) => {
      if (!prev) return prev;
      const newCoords = [...prev.coordinates, { latitude: data.latitude, longitude: data.longitude }];
      let addedDistance = 0;
      if (prev.coordinates.length > 0) {
        const last = prev.coordinates[prev.coordinates.length - 1];
        const dLat = (data.latitude - last.latitude) * 111;
        const dLon = (data.longitude - last.longitude) * 111 * Math.cos(data.latitude * (Math.PI / 180));
        addedDistance = Math.sqrt(dLat * dLat + dLon * dLon);
      }
      return {
        ...prev,
        coordinates:       newCoords,
        speedSamples:      [...prev.speedSamples, speedKmh],
        topSpeed:          Math.max(prev.topSpeed, speedKmh),
        estimatedDistance: prev.estimatedDistance + addedDistance,
        currentSpeed:      speedKmh,
      };
    });
  }, [isDriving, isPassengerMode]);

  const endDrive = useCallback(async (): Promise<Journey | null> => {
    if (!isDriving || !currentDrive) return null;

    // Stop batch flush
    if (flushIntervalRef.current) {
      clearInterval(flushIntervalRef.current);
      flushIntervalRef.current = null;
    }

    const endTime    = Date.now();
    const av         = activeVehicleRef.current;
    const durationSec = Math.round((endTime - currentDrive.startTime) / 1000);
    const avgSpeed   = currentDrive.speedSamples.length > 0
      ? Math.round(currentDrive.speedSamples.reduce((a, b) => a + b, 0) / currentDrive.speedSamples.length)
      : 0;
    const xpEarned   = Math.min(500, Math.max(50, Math.round(currentDrive.estimatedDistance * 10)));
    const now        = new Date();
    const localId    = generateId();
    const distance   = Math.round(currentDrive.estimatedDistance * 10) / 10;

    const journeyData: Journey = {
      id:              localId,
      name:            'Unnamed Journey',
      date:            now.toISOString().split('T')[0],
      startTime:       new Date(currentDrive.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      endTime:         now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      duration:        durationSec,
      distance,
      averageSpeed:    avgSpeed,
      topSpeed:        Math.round(currentDrive.topSpeed),
      vehicleId:       av?.id ?? '',
      vehicleSnapshot: av ? snapshotVehicle(av) : undefined,
      notes:           '',
      routeCoordinates: currentDrive.coordinates,
      photos:          [],
      journeyType:     'personal',
      xpEarned,
      privacy:         'private',
    };

    // Update local state immediately
    setJourneys((prev) => [journeyData, ...prev]);
    setUserProfile((prev) => ({
      ...prev,
      totalJourneys: prev.totalJourneys + 1,
      totalDistance: Math.round((prev.totalDistance + distance) * 10) / 10,
      xp:            prev.xp + xpEarned,
    }));
    setIsDriving(false);
    setCurrentDrive(null);

    // Save to server
    const draft    = journeyDraftRef.current;
    const serverId = serverJourneyIdRef.current;

    if (serverId) {
      setSyncStatus('syncing');
      try {
        const completed = await apiCompleteJourney(serverId, {
          endTimeIso:      now.toISOString(),
          durationSeconds: durationSec,
          distanceKm:      distance,
          avgSpeedKmh:     avgSpeed,
          topSpeedKmh:     Math.round(currentDrive.topSpeed),
          notes:           '',
          privacy:         'private',
          xpEarned,
          remainingPoints: (draft?.pendingPoints ?? []).map((p) => ({
            latitude:   p.latitude,
            longitude:  p.longitude,
            speedKmh:   p.speedKmh,
            accuracyM:  p.accuracyM,
            recordedAt: p.recordedAt,
          })),
        });

        // Replace temp local ID with server-assigned ID
        setJourneys((prev) =>
          prev.map((j) => j.id === localId ? { ...j, id: completed.id } : j)
        );

        // Cleanup
        await clearDraft();
        journeyDraftRef.current  = null;
        serverJourneyIdRef.current = null;
        setSyncStatus('idle');
        setUnsyncedJourneyId(null);

        return { ...journeyData, id: completed.id };
      } catch {
        // Save failed — show sync banner, keep draft
        setSyncStatus('error');
        setUnsyncedJourneyId(localId);
      }
    }

    return journeyData;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDriving, currentDrive]);

  /** Retry saving a failed journey from the IndexedDB draft. */
  const retryJourneySync = useCallback(async () => {
    const draft    = journeyDraftRef.current;
    const serverId = serverJourneyIdRef.current;
    if (!draft || !serverId) return;

    setSyncStatus('syncing');
    try {
      const now = new Date();
      const completed = await apiCompleteJourney(serverId, {
        endTimeIso:      now.toISOString(),
        durationSeconds: draft.stats.speedSamples.length > 0
          ? Math.round((Date.now() - draft.startTime) / 1000)
          : 0,
        distanceKm:      draft.stats.distanceKm,
        avgSpeedKmh:     draft.stats.speedSamples.length > 0
          ? Math.round(draft.stats.speedSamples.reduce((a, b) => a + b, 0) / draft.stats.speedSamples.length)
          : 0,
        topSpeedKmh:     draft.stats.topSpeedKmh,
        remainingPoints: (draft.pendingPoints ?? []).map((p) => ({
          latitude:   p.latitude,
          longitude:  p.longitude,
          speedKmh:   p.speedKmh,
          accuracyM:  p.accuracyM,
          recordedAt: p.recordedAt,
        })),
      });

      // Update the journey in state with server ID
      if (unsyncedJourneyId) {
        setJourneys((prev) =>
          prev.map((j) => j.id === unsyncedJourneyId ? { ...j, id: completed.id } : j)
        );
      }

      await clearDraft();
      journeyDraftRef.current    = null;
      serverJourneyIdRef.current = null;
      setSyncStatus('idle');
      setUnsyncedJourneyId(null);
    } catch {
      setSyncStatus('error');
    }
  }, [unsyncedJourneyId]);

  const togglePassengerMode = useCallback(() => setIsPassengerMode((p) => !p), []);
  const updateProfile       = useCallback((updates: Partial<UserProfile>) => setUserProfile((p) => ({ ...p, ...updates })), []);

  // ── Friend methods ───────────────────────────────────────────────────────────

  const sendFriendRequest = useCallback((name: string, _initials: string) => {
    const req: FriendRequest = {
      id: generateId(), fromId: 'me', fromName: 'Me', fromInitials: 'M',
      status: 'pending', createdAt: new Date().toISOString(), isIncoming: false,
    };
    setFriendRequests((p) => [req, ...p]);
    const notif: Notification = {
      id: generateId(), type: 'friend_accepted',
      title: 'Friend request sent', body: `Request sent to ${name}.`,
      createdAt: new Date().toISOString(), read: false,
    };
    setNotifications((p) => [notif, ...p]);
  }, []);

  const acceptFriendRequest = useCallback((id: string) => {
    setFriendRequests((prev) => prev.map((r) => r.id === id ? { ...r, status: 'accepted' } : r));
    const req = friendRequests.find((r) => r.id === id);
    if (req) {
      setFriends((p) => [...p, { id: req.fromId, name: req.fromName, initials: req.fromInitials, status: 'online', location: '' }]);
    }
  }, [friendRequests]);

  const declineFriendRequest = useCallback((id: string) => {
    setFriendRequests((prev) => prev.map((r) => r.id === id ? { ...r, status: 'declined' } : r));
  }, []);

  const removeFriend = useCallback((id: string) => {
    setFriends((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const blockUser = useCallback((id: string, name: string) => {
    setBlockedUsers((p) => [...p, { id, blockedName: name }]);
    setFriends((p) => p.filter((f) => f.id !== id));
  }, []);

  const unblockUser = useCallback((id: string) => {
    setBlockedUsers((p) => p.filter((b) => b.id !== id));
  }, []);

  // ── Convoy methods ───────────────────────────────────────────────────────────

  const addConvoy    = useCallback((c: Omit<Convoy, 'id'>) => { setConvoys((p) => [{ ...c, id: generateId() }, ...p]); }, []);
  const updateConvoy = useCallback((id: string, updates: Partial<Convoy>) => { setConvoys((p) => p.map((c) => c.id === id ? { ...c, ...updates } : c)); }, []);
  const deleteConvoy = useCallback((id: string) => { setConvoys((p) => p.filter((c) => c.id !== id)); }, []);
  const joinConvoy   = useCallback((id: string) => { setConvoys((p) => p.map((c) => c.id === id ? { ...c, isJoined: true, driverCount: c.driverCount + 1 } : c)); }, []);
  const leaveConvoy  = useCallback((id: string) => { setConvoys((p) => p.map((c) => c.id === id ? { ...c, isJoined: false, driverCount: Math.max(0, c.driverCount - 1) } : c)); }, []);

  // ── Group methods ────────────────────────────────────────────────────────────

  const addGroup  = useCallback((g: Omit<Group, 'id' | 'createdAt' | 'memberCount' | 'myRole' | 'isMember'>) => {
    setGroups((p) => [{ ...g, id: generateId(), createdAt: new Date().toISOString(), memberCount: 1, myRole: 'owner', isMember: true }, ...p]);
  }, []);
  const joinGroup  = useCallback((id: string) => { setGroups((p) => p.map((g) => g.id === id ? { ...g, isMember: true, myRole: 'member', memberCount: g.memberCount + 1 } : g)); }, []);
  const leaveGroup = useCallback((id: string) => { setGroups((p) => p.map((g) => g.id === id ? { ...g, isMember: false, myRole: null, memberCount: Math.max(0, g.memberCount - 1) } : g)); }, []);

  // ── Event methods ────────────────────────────────────────────────────────────

  const addEvent = useCallback((e: Omit<DriveOSEvent, 'id' | 'attendeeCount' | 'rsvpStatus'>) => {
    setEvents((p) => [{ ...e, id: generateId(), attendeeCount: 1, rsvpStatus: 'going' }, ...p]);
  }, []);

  const rsvpEvent = useCallback((id: string, status: DriveOSEvent['rsvpStatus']) => {
    setEvents((p) => p.map((e) => e.id === id ? {
      ...e, rsvpStatus: status,
      attendeeCount: status === 'going'
        ? e.attendeeCount + (e.rsvpStatus !== 'going' ? 1 : 0)
        : e.attendeeCount - (e.rsvpStatus === 'going' ? 1 : 0),
    } : e));
  }, []);

  // ── Messaging ────────────────────────────────────────────────────────────────

  const startConversation = useCallback((participantId: string, participantName: string, participantInitials: string): string => {
    const existing = conversations.find((c) => c.participantId === participantId);
    if (existing) return existing.id;
    const newConv: Conversation = {
      id: generateId(), participantId, participantName, participantInitials,
      lastMessage: '', lastMessageAt: new Date().toISOString(), unreadCount: 0,
    };
    setConversations((p) => [newConv, ...p]);
    return newConv.id;
  }, [conversations]);

  const sendMessage = useCallback((conversationId: string, content: string) => {
    const msg: Message = {
      id: generateId(), conversationId, senderId: 'me', senderName: userProfile.name,
      content, createdAt: new Date().toISOString(), isOwn: true,
    };
    setMessages((p) => [...p, msg]);
    setConversations((p) => p.map((c) => c.id === conversationId
      ? { ...c, lastMessage: content, lastMessageAt: msg.createdAt } : c));
  }, [userProfile.name]);

  const markConversationRead = useCallback((id: string) => {
    setConversations((p) => p.map((c) => c.id === id ? { ...c, unreadCount: 0 } : c));
  }, []);

  // ── Notifications ────────────────────────────────────────────────────────────

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((p) => p.map((n) => n.id === id ? { ...n, read: true } : n));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((p) => p.map((n) => ({ ...n, read: true })));
  }, []);

  const unreadNotificationCount = notifications.filter((n) => !n.read).length;

  // ── Context value ────────────────────────────────────────────────────────────

  const value: AppContextValue = {
    vehicles, journeys, userProfile, isPassengerMode, isDriving, currentDrive, activeVehicle,
    isLoading, syncStatus, unsyncedJourneyId, retryJourneySync,
    categories, addCategory, updateCategory, deleteCategory,
    setActiveVehicle, addVehicle, updateVehicle, deleteVehicle,
    addJourney, updateJourney, deleteJourney,
    startDrive, updateDriveCoordinate, endDrive, togglePassengerMode, updateProfile,
    friends, friendRequests, sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend,
    blockedUsers, blockUser, unblockUser,
    convoys, addConvoy, updateConvoy, deleteConvoy, joinConvoy, leaveConvoy,
    groups, addGroup, joinGroup, leaveGroup,
    events, addEvent, rsvpEvent,
    conversations, messages, sendMessage, startConversation, markConversationRead,
    notifications, markNotificationRead, markAllNotificationsRead, unreadNotificationCount,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

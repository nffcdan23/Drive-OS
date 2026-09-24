/**
 * The app's view of the user's data. Loaded from the API (the source of
 * truth), cached per user on the device, and edited optimistically.
 */
import type { LocationKind, SpotCategory, Visibility } from './endpoints';

export type SyncState = 'synced' | 'pending' | 'failed';

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
  /** Signed cover photo URL (expires after an hour), or a local file awaiting upload. */
  imageUri: string | null;
  isActive: boolean;
  syncState?: SyncState;
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

export interface Coordinate { latitude: number; longitude: number }

export interface JourneyCategory { id: string; name: string; icon: string; colour: string; isDefault?: boolean }

export interface Journey {
  id: string;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number; // seconds
  distance: number; // km
  averageSpeed: number; // km/h
  topSpeed: number; // km/h
  vehicleId: string;
  notes: string;
  routeCoordinates: Coordinate[];
  photos: string[];
  categoryId?: string;
  journeyType?: 'personal' | 'convoy';
  xpEarned?: number;
  vehicleSnapshot?: VehicleSnapshot;
  privacy?: Visibility;
  convoyId?: string;
  startedAtIso?: string;
  /** 'pending' while the drive is still uploading from this device. */
  syncState?: SyncState;
  syncError?: string | null;
}

export interface Achievement { id: string; title: string; description: string; icon: string; unlockedAt: string | null }

export interface UserProfile {
  id?: string;
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
  avatarUrl?: string | null;
}

export interface Friend {
  id: string;
  name: string;
  initials: string;
  status: 'online' | 'offline' | 'driving';
  location: string;
  avatarUrl?: string | null;
  level?: number;
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

export interface BlockedUser { id: string; blockedName: string }

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
  isPending?: boolean;
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
    | 'group_request_result' | 'group_news' | 'event_invite' | 'event_reminder'
    | 'achievement_unlocked' | 'system';
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

/** A place the user saved: Home, Work, a favourite, or a Beauty Spot. */
export interface SavedPlace {
  id: string;
  kind: LocationKind;
  category: SpotCategory | null;
  name: string;
  description: string;
  address: string;
  coordinate: Coordinate;
  visibility: Visibility;
  createdAt: string;
  syncState?: SyncState;
}

/** A Beauty Spot shared by someone (or the user's own) near a point. */
export interface NearbySpot {
  id: string;
  ownerId: string;
  name: string;
  category: SpotCategory | null;
  coordinate: Coordinate;
  visibility: Visibility;
  distanceM: number | null;
  isOwn: boolean;
}

export interface ActiveDrive {
  startTime: number;
  coordinates: Coordinate[];
  speedSamples: number[];
  topSpeed: number;
  estimatedDistance: number;
  currentSpeed: number;
}

export interface ProfileStats { friends: number; vehicles: number; journeys: number; totalDistance: number }

/** Everything cached for offline start-up. */
export interface CachedData {
  version: 1;
  savedAt: string;
  profile: UserProfile;
  unitSystem: 'auto' | 'metric' | 'imperial';
  vehicles: Vehicle[];
  journeys: Journey[];
  categories: JourneyCategory[];
  places: SavedPlace[];
  friends: Friend[];
  friendRequests: FriendRequest[];
  blockedUsers: BlockedUser[];
  convoys: Convoy[];
  groups: Group[];
  events: DriveOSEvent[];
  notifications: Notification[];
  profileStats: ProfileStats;
}

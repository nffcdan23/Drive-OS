/**
 * Typed API client for DriveOS.
 *
 * Uses the `customFetch` / `setBaseUrl` / `setAuthTokenGetter` helpers from
 * @workspace/api-client-react so every request automatically carries the
 * device-ID Bearer token and resolves to the correct API origin.
 */
import { Platform } from 'react-native';
import { customFetch, setBaseUrl, setAuthTokenGetter } from '@workspace/api-client-react';
import { getDeviceId } from './deviceId';

// On web, the Replit proxy routes /api → API server (same origin, relative URL).
// On native, prepend the full dev domain so Expo Go can reach the API.
const API_BASE =
  Platform.OS === 'web'
    ? ''
    : `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ''}`;

setBaseUrl(API_BASE || null);

// Send device UUID as the Bearer token on every request
setAuthTokenGetter(() => getDeviceId());

// ─── Internal helper ─────────────────────────────────────────────────────────

function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return customFetch<T>(`/api${path}`, init);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(path: string): Promise<void> {
  return api<void>(path, { method: 'DELETE' });
}

// ─── User Profile ─────────────────────────────────────────────────────────────

export interface ApiUser {
  id: string;
  deviceId: string;
  name: string;
  username: string | null;
  bio: string | null;
  friendCode: string | null;
  unitSystem: string;
  level: number;
  xp: number;
  xpToNextLevel: number;
  totalDistance: number;
  totalJourneys: number;
  createdAt: string;
  updatedAt: string;
}

export const apiGetMe = () => api<ApiUser>('/users/me');
export const apiUpdateMe = (data: Partial<Pick<ApiUser, 'name' | 'username' | 'bio' | 'unitSystem'>>) =>
  put<ApiUser>('/users/me', data);

// ─── Vehicles ─────────────────────────────────────────────────────────────────

export interface ApiVehicle {
  id: string;
  userId: string;
  nickname: string;
  registration: string;
  make: string;
  model: string;
  year: number;
  colour: string;
  fuelType: string;
  engine: string;
  power: string;
  torque: string;
  zeroToSixty: string;
  topSpeedSpec: string;
  mileage: number;
  imageUrl: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateVehicleInput = Omit<ApiVehicle, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;
export type UpdateVehicleInput = Partial<CreateVehicleInput>;

export const apiGetVehicles  = () => api<ApiVehicle[]>('/vehicles');
export const apiCreateVehicle = (data: CreateVehicleInput) => post<ApiVehicle>('/vehicles', data);
export const apiUpdateVehicle = (id: string, data: UpdateVehicleInput) => put<ApiVehicle>(`/vehicles/${id}`, data);
export const apiDeleteVehicle = (id: string) => del(`/vehicles/${id}`);
export const apiActivateVehicle = (id: string) => post<ApiVehicle>(`/vehicles/${id}/activate`, {});

// ─── Journeys ─────────────────────────────────────────────────────────────────

export interface ApiJourney {
  id: string;
  userId: string;
  vehicleId: string | null;
  name: string;
  date: string;
  startTimeIso: string;
  endTimeIso: string | null;
  durationSeconds: number;
  distanceKm: number;
  avgSpeedKmh: number;
  topSpeedKmh: number;
  notes: string;
  photos: string[];
  categoryId: string | null;
  journeyType: string;
  xpEarned: number;
  privacy: string;
  convoyId: string | null;
  vehicleSnapshot: unknown | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutePoint {
  latitude: number;
  longitude: number;
  speedKmh: number;
  accuracyM?: number;
  recordedAt: string; // ISO
}

export interface StartJourneyInput {
  vehicleId?: string;
  vehicleSnapshot?: unknown;
  name?: string;
  date?: string;
  startTimeIso?: string;
  journeyType?: string;
}

export interface CompleteJourneyInput {
  name?: string;
  endTimeIso: string;
  durationSeconds: number;
  distanceKm: number;
  avgSpeedKmh: number;
  topSpeedKmh: number;
  notes?: string;
  categoryId?: string;
  privacy?: string;
  journeyType?: string;
  xpEarned?: number;
  remainingPoints?: RoutePoint[];
}

export const apiGetJourneys     = () => api<ApiJourney[]>('/journeys');
export const apiStartJourney    = (data: StartJourneyInput) => post<ApiJourney>('/journeys', data);
export const apiGetJourney      = (id: string) => api<ApiJourney>(`/journeys/${id}`);
export const apiUpdateJourney   = (id: string, data: Partial<ApiJourney>) => put<ApiJourney>(`/journeys/${id}`, data);
export const apiDeleteJourney   = (id: string) => del(`/journeys/${id}`);
export const apiAddRoutePoints  = (id: string, points: RoutePoint[]) =>
  post<{ saved: number }>(`/journeys/${id}/route-points`, { points });
export const apiCompleteJourney = (id: string, data: CompleteJourneyInput) =>
  post<ApiJourney>(`/journeys/${id}/complete`, data);

// ─── Categories ───────────────────────────────────────────────────────────────

export interface ApiCategory {
  id: string;
  userId: string | null;
  name: string;
  icon: string;
  colour: string;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
}

export const apiGetCategories    = () => api<ApiCategory[]>('/categories');
export const apiCreateCategory   = (data: Pick<ApiCategory, 'name' | 'icon' | 'colour'>) =>
  post<ApiCategory>('/categories', data);
export const apiUpdateCategory   = (id: string, data: Partial<Pick<ApiCategory, 'name' | 'icon' | 'colour'>>) =>
  put<ApiCategory>(`/categories/${id}`, data);
export const apiDeleteCategory   = (id: string) => del(`/categories/${id}`);

// ─── Notifications ────────────────────────────────────────────────────────────

export interface ApiNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export const apiGetNotifications      = () => api<ApiNotification[]>('/notifications');
export const apiMarkNotificationRead  = (id: string) => put<void>(`/notifications/${id}/read`, {});
export const apiMarkAllNotificationsRead = () => post<void>('/notifications/read-all', {});

// ─── Community ────────────────────────────────────────────────────────────────

export interface ApiConvoy {
  id: string;
  ownerId: string;
  name: string;
  destination: string;
  isPrivate: boolean;
  startTime: string;
  status: string;
  description: string;
  maxParticipants: number | null;
  createdAt: string;
}

export interface ApiGroup {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  logoUrl: string | null;
  isPublic: boolean;
  membershipMethod: string;
  primaryLocation: string;
  vehicleInterests: string;
  createdAt: string;
}

export interface ApiEvent {
  id: string;
  organiserId: string;
  groupId: string | null;
  name: string;
  description: string;
  coverUrl: string | null;
  location: string;
  date: string;
  startTime: string;
  endTime: string;
  eventType: string;
  isPublic: boolean;
  capacity: number;
  entryCost: string;
  vehicleCategory: string;
  createdAt: string;
}

export interface ApiFriend {
  id: string;
  name: string;
  username: string | null;
  level: number;
  friendCode: string | null;
}

export interface ApiFriendRequest {
  id: string;
  fromId: string;
  toFriendCode: string;
  status: string;
  createdAt: string;
}

export const apiGetConvoys      = () => api<ApiConvoy[]>('/convoys');
export const apiCreateConvoy    = (data: Partial<ApiConvoy>) => post<ApiConvoy>('/convoys', data);
export const apiUpdateConvoy    = (id: string, data: Partial<ApiConvoy>) => put<ApiConvoy>(`/convoys/${id}`, data);
export const apiDeleteConvoy    = (id: string) => del(`/convoys/${id}`);
export const apiJoinConvoy      = (id: string) => post<void>(`/convoys/${id}/join`, {});
export const apiLeaveConvoy     = (id: string) => post<void>(`/convoys/${id}/leave`, {});

export const apiGetGroups       = () => api<ApiGroup[]>('/groups');
export const apiCreateGroup     = (data: Partial<ApiGroup>) => post<ApiGroup>('/groups', data);
export const apiUpdateGroup     = (id: string, data: Partial<ApiGroup>) => put<ApiGroup>(`/groups/${id}`, data);
export const apiJoinGroup       = (id: string) => post<void>(`/groups/${id}/join`, {});
export const apiLeaveGroup      = (id: string) => post<void>(`/groups/${id}/leave`, {});

export const apiGetEvents       = () => api<ApiEvent[]>('/events');
export const apiCreateEvent     = (data: Partial<ApiEvent>) => post<ApiEvent>('/events', data);
export const apiRsvpEvent       = (id: string, status: 'going' | 'interested' | 'declined') =>
  post<void>(`/events/${id}/rsvp`, { status });

export const apiGetFriends      = () => api<ApiFriend[]>('/friends');
export const apiRemoveFriend    = (friendId: string) => del(`/friends/${friendId}`);
export const apiGetFriendRequests   = () => api<ApiFriendRequest[]>('/friend-requests');
export const apiSendFriendRequest   = (friendCode: string) =>
  post<ApiFriendRequest>('/friend-requests', { friendCode });
export const apiAcceptFriendRequest = (id: string) => put<void>(`/friend-requests/${id}/accept`, {});
export const apiDeclineFriendRequest = (id: string) => put<void>(`/friend-requests/${id}/decline`, {});

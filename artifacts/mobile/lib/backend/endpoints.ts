/**
 * Typed calls to the DriveOS API (artifacts/api-server). Shapes mirror the
 * server's JSON responses; screens use the mapped types in `mappers.ts`.
 */
import type { ApiClient } from './http';

export type Visibility = 'private' | 'friends' | 'public';

export interface ServerSettings {
  unitSystem: 'auto' | 'metric' | 'imperial';
  profileVisibility: Visibility;
  defaultJourneyVisibility: Visibility;
  defaultLocationVisibility: Visibility;
  allowFriendRequests: 'everyone' | 'nobody';
  shareLiveLocationInConvoys: boolean;
  notificationPrefs: Record<string, boolean>;
}

export interface ServerProfile {
  id: string;
  username: string | null;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  friendCode: string;
  xp: number;
  level: number;
  xpIntoLevel: number;
  xpToNextLevel: number;
  totalDistanceKm: number;
  totalJourneys: number;
  createdAt: string;
  settings: ServerSettings | null;
}

export interface ServerStats { friends: number; vehicles: number; journeys: number; totalDistanceKm: number }

export interface ServerAchievement {
  id: string; title: string; description: string; icon: string; xpReward: number; unlockedAt: string | null;
}

export interface ServerVehicle {
  id: string;
  clientRef: string | null;
  nickname: string;
  registration: string;
  make: string;
  model: string;
  year: number | null;
  colour: string;
  fuelType: string;
  engine: string;
  power: string;
  torque: string;
  zeroToSixty: string;
  topSpeedSpec: string;
  mileage: number;
  visibility: Visibility;
  isActive: boolean;
  coverPhotoId: string | null;
  coverPhotoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VehicleFields = Partial<Pick<ServerVehicle,
  'nickname' | 'registration' | 'make' | 'model' | 'year' | 'colour' | 'fuelType' | 'engine' | 'power' |
  'torque' | 'zeroToSixty' | 'topSpeedSpec' | 'mileage' | 'visibility' | 'coverPhotoId'>>;

export interface VehicleLookup {
  registration: string; make: string; colour: string;
  fuelType: 'petrol' | 'diesel' | 'electric' | 'hybrid' | null;
  year: number | null; engine: string; motStatus: string | null; taxStatus: string | null;
}

export interface ServerJourneyRoute {
  routePolyline: string | null;
  pointCount: number;
  startLat: number | null; startLng: number | null; endLat: number | null; endLng: number | null;
}

export interface ServerJourney {
  id: string;
  ownerId: string;
  clientRef: string | null;
  vehicleId: string | null;
  categoryId: string | null;
  convoyId: string | null;
  name: string;
  notes: string;
  status: 'active' | 'completed';
  visibility: Visibility;
  journeyType: 'personal' | 'convoy';
  startedAt: string;
  endedAt: string | null;
  timezone: string;
  durationSeconds: number;
  distanceKm: number;
  avgSpeedKmh: number;
  topSpeedKmh: number;
  xpEarned: number;
  vehicleSnapshot: Record<string, unknown> | null;
  publicRoutePolyline: string | null;
  route: ServerJourneyRoute | null;
  unlockedAchievements?: string[];
}

export interface RoutePointInput {
  recordedAt: string;
  latitude: number;
  longitude: number;
  speedKmh?: number;
  headingDeg?: number | null;
  accuracyM?: number | null;
  altitudeM?: number | null;
}

export interface ServerCategory {
  id: string; ownerId: string | null; name: string; icon: string; colour: string; sortOrder: number;
}

export type LocationKind = 'home' | 'work' | 'favourite_road' | 'meeting_point' | 'car_park' | 'poi' | 'beauty_spot';
export type SpotCategory =
  | 'viewpoint' | 'coastal' | 'mountain_pass' | 'lake' | 'forest' | 'scenic_road' | 'landmark' | 'photo_spot' | 'other';

export interface ServerLocation {
  id: string;
  ownerId: string;
  clientRef: string | null;
  kind: LocationKind;
  category: SpotCategory | null;
  name: string;
  description: string;
  address: string;
  lat: number;
  lng: number;
  routePolyline: string | null;
  visibility: Visibility;
  status: string;
  coverPhotoId: string | null;
  sourceJourneyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LocationFields = Partial<Pick<ServerLocation,
  'kind' | 'category' | 'name' | 'description' | 'address' | 'lat' | 'lng' | 'visibility'>>;

export interface NearbySpot {
  id: string; ownerId: string; name: string; category: SpotCategory | null; description?: string;
  lat: number; lng: number; visibility: Visibility; coverPhotoId: string | null; distanceM?: number;
}

export interface ServerNotification {
  id: string; actorUserId: string | null; type: string; title: string; body: string;
  data: Record<string, unknown>; readAt: string | null; isRead: boolean; createdAt: string;
}

export interface UserCard { id: string; username: string | null; displayName: string; avatarUrl: string | null; level: number }

export interface ServerConvoy {
  id: string; ownerId: string; groupId: string | null; name: string; description: string;
  destinationName: string; destinationLat: number | null; destinationLng: number | null;
  visibility: 'public' | 'friends' | 'private'; startsAt: string;
  status: 'forming' | 'active' | 'completed' | 'cancelled';
  maxParticipants: number | null; participantCount: number; myRole: 'leader' | 'member' | null;
  participants?: Array<UserCard & { role: string }>;
}

export interface ServerGroup {
  id: string; ownerId: string; name: string; description: string; logoUrl: string | null; isPublic: boolean;
  membershipMethod: 'open' | 'request' | 'invite' | 'code'; primaryLocation: string; vehicleInterests: string;
  createdAt: string; memberCount: number; myRole: 'owner' | 'admin' | 'member' | null;
  myStatus: 'active' | 'pending' | 'invited' | null;
}

export interface ServerEvent {
  id: string; organiserId: string; groupId: string | null; name: string; description: string;
  coverUrl: string | null; locationName: string; lat: number | null; lng: number | null;
  startsAt: string; endsAt: string | null; timezone: string; eventType: string;
  visibility: 'public' | 'group' | 'private'; capacity: number | null; entryCost: string; vehicleCategory: string;
  goingCount: number; interestedCount: number; myRsvp: 'going' | 'interested' | 'declined' | 'invited' | null;
}

export interface UploadTicket {
  kind: string; id?: string; bucket: string; path: string; uploadUrl: string; token: string;
}

export interface ServerPhoto {
  id: string; vehicleId: string | null; journeyId: string | null; locationId: string | null;
  caption: string; status: 'pending' | 'ready'; url: string | null; thumbnailUrl: string | null;
}

export const endpoints = (api: ApiClient) => ({
  // Profile & settings
  getMe: () => api.get<ServerProfile>('/me'),
  updateMe: (fields: Partial<Pick<ServerProfile, 'displayName' | 'username' | 'bio'>>) => api.patch<ServerProfile>('/me', fields),
  updateSettings: (fields: Partial<ServerSettings>) => api.patch<ServerProfile>('/me/settings', fields),
  getStats: () => api.get<ServerStats>('/me/stats'),
  getAchievements: () => api.get<ServerAchievement[]>('/me/achievements'),
  deleteAccount: () => api.delete<void>('/me', { confirm: 'DELETE' }),

  // Vehicles
  listVehicles: () => api.get<ServerVehicle[]>('/vehicles'),
  createVehicle: (fields: VehicleFields & { nickname: string; clientRef: string; isActive?: boolean }) =>
    api.post<ServerVehicle>('/vehicles', fields),
  updateVehicle: (id: string, fields: VehicleFields) => api.patch<ServerVehicle>(`/vehicles/${id}`, fields),
  deleteVehicle: (id: string) => api.delete(`/vehicles/${id}`),
  activateVehicle: (id: string) => api.post<ServerVehicle>(`/vehicles/${id}/activate`),
  lookupVehicle: (registration: string) => api.post<VehicleLookup>('/vehicles/lookup', { registration }),

  // Journeys
  listJourneys: () => api.get<ServerJourney[]>('/journeys'),
  getJourney: (id: string) => api.get<ServerJourney>(`/journeys/${id}`),
  startJourney: (input: { clientRef: string; startedAt: string; timezone: string; vehicleId?: string | null; name?: string }) =>
    api.post<ServerJourney>('/journeys', input),
  addRoutePoints: (id: string, points: RoutePointInput[]) =>
    api.post<{ saved: number; status: string }>(`/journeys/${id}/route-points`, { points }),
  completeJourney: (id: string, input: { endedAt: string; distanceKm: number; name?: string; visibility?: Visibility }) =>
    api.post<ServerJourney>(`/journeys/${id}/complete`, input),
  updateJourney: (id: string, fields: { name?: string; notes?: string; categoryId?: string | null; visibility?: Visibility }) =>
    api.patch<ServerJourney>(`/journeys/${id}`, fields),
  deleteJourney: (id: string) => api.delete(`/journeys/${id}`),

  // Categories
  listCategories: () => api.get<ServerCategory[]>('/categories'),
  createCategory: (c: { name: string; icon: string; colour: string }) => api.post<ServerCategory>('/categories', c),
  updateCategory: (id: string, c: Partial<{ name: string; icon: string; colour: string }>) => api.patch<ServerCategory>(`/categories/${id}`, c),
  deleteCategory: (id: string) => api.delete(`/categories/${id}`),

  // Saved locations & Beauty Spots
  listLocations: () => api.get<ServerLocation[]>('/locations'),
  createLocation: (fields: LocationFields & { kind: LocationKind; name: string; lat: number; lng: number; clientRef: string }) =>
    api.post<ServerLocation>('/locations', fields),
  updateLocation: (id: string, fields: LocationFields) => api.patch<ServerLocation>(`/locations/${id}`, fields),
  deleteLocation: (id: string) => api.delete(`/locations/${id}`),
  nearbySpots: (lat: number, lng: number, radiusM = 25_000) =>
    api.get<NearbySpot[]>(`/locations/nearby?lat=${lat}&lng=${lng}&radius=${radiusM}`),

  // Uploads
  requestUpload: (input: { kind: string; sizeBytes: number; mimeType: string; parentId?: string; withThumbnail?: boolean }) =>
    api.post<UploadTicket>('/uploads', input),
  confirmUpload: (id: string) => api.post<{ id: string; status: string }>(`/uploads/${id}/confirm`),
  confirmImage: (kind: 'avatar' | 'group-logo' | 'event-cover', path: string) =>
    api.post<{ avatarUrl?: string; logoUrl?: string; coverUrl?: string }>('/uploads/image/confirm', { kind, path }),
  listPhotos: (q: { vehicleId?: string; journeyId?: string; locationId?: string }) => {
    const [k, v] = Object.entries(q).find(([, val]) => !!val) ?? ['vehicleId', ''];
    return api.get<ServerPhoto[]>(`/photos?${k}=${encodeURIComponent(String(v))}`);
  },
  deletePhoto: (id: string) => api.delete(`/photos/${id}`),

  // Notifications
  listNotifications: () => api.get<{ items: ServerNotification[]; unreadCount: number }>('/notifications'),
  markNotificationRead: (id: string) => api.post(`/notifications/${id}/read`),
  markAllNotificationsRead: () => api.post('/notifications/read-all'),

  // Friends
  listFriends: () => api.get<Array<UserCard & { since: string }>>('/friends'),
  removeFriend: (userId: string) => api.delete(`/friends/${userId}`),
  listFriendRequests: () => api.get<{
    incoming: Array<{ id: string; createdAt: string; user: UserCard }>;
    outgoing: Array<{ id: string; createdAt: string; user: UserCard }>;
  }>('/friend-requests'),
  sendFriendRequest: (friendCode: string) => api.post<{ id: string; status: 'pending' | 'accepted' }>('/friend-requests', { friendCode }),
  acceptFriendRequest: (id: string) => api.post(`/friend-requests/${id}/accept`),
  declineFriendRequest: (id: string) => api.post(`/friend-requests/${id}/decline`),
  cancelFriendRequest: (id: string) => api.delete(`/friend-requests/${id}`),
  listBlocks: () => api.get<UserCard[]>('/blocks'),
  block: (userId: string) => api.post('/blocks', { userId }),
  unblock: (userId: string) => api.delete(`/blocks/${userId}`),

  // Convoys
  listConvoys: () => api.get<ServerConvoy[]>('/convoys'),
  createConvoy: (c: { name: string; description?: string; destinationName?: string; visibility: 'public' | 'friends' | 'private'; startsAt: string; maxParticipants?: number | null }) =>
    api.post<ServerConvoy>('/convoys', c),
  updateConvoy: (id: string, c: Record<string, unknown>) => api.patch<ServerConvoy>(`/convoys/${id}`, c),
  deleteConvoy: (id: string) => api.delete(`/convoys/${id}`),
  joinConvoy: (id: string) => api.post<ServerConvoy>(`/convoys/${id}/join`),
  joinConvoyByCode: (code: string) => api.post<ServerConvoy>('/convoys/join', { code }),
  leaveConvoy: (id: string) => api.post(`/convoys/${id}/leave`),

  // Groups
  listGroups: () => api.get<ServerGroup[]>('/groups'),
  createGroup: (g: { name: string; description?: string; isPublic?: boolean; membershipMethod?: string; primaryLocation?: string; vehicleInterests?: string }) =>
    api.post<ServerGroup>('/groups', g),
  joinGroup: (id: string) => api.post<ServerGroup>(`/groups/${id}/join`),
  joinGroupByCode: (code: string) => api.post<ServerGroup>('/groups/join', { code }),
  leaveGroup: (id: string) => api.post(`/groups/${id}/leave`),

  // Events
  listEvents: () => api.get<ServerEvent[]>('/events'),
  createEvent: (e: Record<string, unknown>) => api.post<ServerEvent>('/events', e),
  rsvpEvent: (id: string, status: 'going' | 'interested' | 'declined') => api.put<ServerEvent>(`/events/${id}/rsvp`, { status }),
  withdrawRsvp: (id: string) => api.delete(`/events/${id}/rsvp`),
});

export type Endpoints = ReturnType<typeof endpoints>;

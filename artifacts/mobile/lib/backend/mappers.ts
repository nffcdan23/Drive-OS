/** Server responses → the app's model. */
import type {
  NearbySpot as ServerNearbySpot, ServerCategory, ServerConvoy, ServerEvent, ServerGroup, ServerJourney,
  ServerLocation, ServerNotification, ServerProfile, ServerStats, ServerVehicle, UserCard,
} from './endpoints';
import { decodePolyline } from './geo';
import type {
  Convoy, DriveOSEvent, EventType, Friend, FriendRequest, Group, Journey, JourneyCategory, NearbySpot,
  Notification, ProfileStats, SavedPlace, UserProfile, Vehicle, VehicleSnapshot,
} from './model';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  return (parts[0]?.[0] ?? '?').toUpperCase();
}

const FUELS = ['petrol', 'diesel', 'electric', 'hybrid'] as const;

export function toVehicle(v: ServerVehicle): Vehicle {
  return {
    id: v.id,
    nickname: v.nickname,
    registration: v.registration,
    make: v.make,
    model: v.model,
    year: v.year ?? 0,
    colour: v.colour,
    fuelType: (FUELS as readonly string[]).includes(v.fuelType) ? (v.fuelType as Vehicle['fuelType']) : 'petrol',
    engine: v.engine,
    power: v.power,
    torque: v.torque,
    zeroToSixty: v.zeroToSixty,
    topSpeed: v.topSpeedSpec,
    mileage: v.mileage,
    fuelPercentage: 0,
    imageUri: v.coverPhotoUrl,
    isActive: v.isActive,
    syncState: 'synced',
  };
}

/** Editable vehicle fields in the API's naming (only those present). */
export function vehicleFields(v: Partial<Vehicle>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (from: keyof Vehicle, to: string) => { if (v[from] !== undefined) out[to] = v[from]; };
  copy('nickname', 'nickname');
  copy('registration', 'registration');
  copy('make', 'make');
  copy('model', 'model');
  if (v.year !== undefined) out.year = v.year > 0 ? v.year : null;
  copy('colour', 'colour');
  copy('fuelType', 'fuelType');
  copy('engine', 'engine');
  copy('power', 'power');
  copy('torque', 'torque');
  copy('zeroToSixty', 'zeroToSixty');
  copy('topSpeed', 'topSpeedSpec');
  if (v.mileage !== undefined) out.mileage = Math.max(0, Math.round(v.mileage));
  if (typeof out.nickname === 'string' && !(out.nickname as string).trim()) delete out.nickname;
  return out;
}

const timeOf = (iso: string | null, tz?: string) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
  } catch {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
};

export function toJourney(j: ServerJourney): Journey {
  const polyline = j.route?.routePolyline ?? j.publicRoutePolyline;
  return {
    id: j.id,
    name: j.name,
    date: j.startedAt.slice(0, 10),
    startTime: timeOf(j.startedAt, j.timezone),
    endTime: timeOf(j.endedAt, j.timezone),
    duration: j.durationSeconds,
    distance: j.distanceKm,
    averageSpeed: j.avgSpeedKmh,
    topSpeed: j.topSpeedKmh,
    vehicleId: j.vehicleId ?? '',
    notes: j.notes,
    routeCoordinates: decodePolyline(polyline),
    photos: [],
    categoryId: j.categoryId ?? undefined,
    journeyType: j.journeyType,
    xpEarned: j.xpEarned,
    vehicleSnapshot: (j.vehicleSnapshot as unknown as VehicleSnapshot | null) ?? undefined,
    privacy: j.visibility,
    convoyId: j.convoyId ?? undefined,
    startedAtIso: j.startedAt,
    syncState: 'synced',
  };
}

export function toProfile(p: ServerProfile, achievements: UserProfile['achievements'] = []): UserProfile {
  return {
    id: p.id,
    name: p.displayName,
    username: p.username ?? undefined,
    bio: p.bio || undefined,
    friendCode: p.friendCode,
    avatarUrl: p.avatarUrl,
    level: p.level,
    xp: p.xp,
    xpToNextLevel: p.xpToNextLevel,
    totalDistance: p.totalDistanceKm,
    totalJourneys: p.totalJourneys,
    achievements,
  };
}

export const toStats = (s: ServerStats): ProfileStats =>
  ({ friends: s.friends, vehicles: s.vehicles, journeys: s.journeys, totalDistance: s.totalDistanceKm });

export const toCategory = (c: ServerCategory): JourneyCategory =>
  ({ id: c.id, name: c.name, icon: c.icon, colour: c.colour, isDefault: c.ownerId === null });

export function toPlace(l: ServerLocation): SavedPlace {
  return {
    id: l.id, kind: l.kind, category: l.category, name: l.name, description: l.description, address: l.address,
    coordinate: { latitude: l.lat, longitude: l.lng }, visibility: l.visibility, createdAt: l.createdAt, syncState: 'synced',
  };
}

export const toNearbySpot = (s: ServerNearbySpot, myId: string | undefined): NearbySpot => ({
  id: s.id, ownerId: s.ownerId, name: s.name, category: s.category, coordinate: { latitude: s.lat, longitude: s.lng },
  visibility: s.visibility, distanceM: s.distanceM ?? null, isOwn: s.ownerId === myId,
});

export const toFriend = (f: UserCard): Friend => ({
  id: f.id, name: f.displayName, initials: initials(f.displayName), status: 'offline', location: '',
  avatarUrl: f.avatarUrl, level: f.level,
});

export function toFriendRequests(r: {
  incoming: Array<{ id: string; createdAt: string; user: UserCard }>;
  outgoing: Array<{ id: string; createdAt: string; user: UserCard }>;
}): FriendRequest[] {
  const map = (x: { id: string; createdAt: string; user: UserCard }, isIncoming: boolean): FriendRequest => ({
    id: x.id, fromId: x.user.id, fromName: x.user.displayName, fromInitials: initials(x.user.displayName),
    status: 'pending', createdAt: x.createdAt, isIncoming,
  });
  return [...r.incoming.map((x) => map(x, true)), ...r.outgoing.map((x) => map(x, false))];
}

export function toConvoy(c: ServerConvoy & { leaderName?: string }): Convoy {
  return {
    id: c.id, name: c.name, leaderId: c.ownerId, leaderName: c.leaderName ?? 'Convoy leader',
    destination: c.destinationName, driverCount: c.participantCount, isPrivate: c.visibility !== 'public',
    startTime: c.startsAt, status: c.status, description: c.description,
    maxParticipants: c.maxParticipants ?? undefined, isOwn: c.myRole === 'leader', isJoined: c.myRole !== null,
  };
}

export function toGroup(g: ServerGroup): Group {
  return {
    id: g.id, name: g.name, description: g.description, logoUri: g.logoUrl, isPublic: g.isPublic,
    memberCount: g.memberCount, membershipMethod: g.membershipMethod,
    myRole: g.myStatus === 'active' ? g.myRole : null, isMember: g.myStatus === 'active', isPending: g.myStatus === 'pending',
    primaryLocation: g.primaryLocation, vehicleInterests: g.vehicleInterests, createdAt: g.createdAt,
  };
}

export function toEvent(e: ServerEvent & { organiserName?: string }): DriveOSEvent {
  return {
    id: e.id, name: e.name, description: e.description, coverUri: e.coverUrl, location: e.locationName,
    date: e.startsAt.slice(0, 10), startTime: timeOf(e.startsAt, e.timezone), endTime: timeOf(e.endsAt, e.timezone),
    eventType: e.eventType as EventType, isPublic: e.visibility === 'public', groupId: e.groupId,
    capacity: e.capacity ?? 0, attendeeCount: e.goingCount, organiser: e.organiserName ?? 'Organiser',
    vehicleCategory: e.vehicleCategory,
    rsvpStatus: e.myRsvp === 'invited' ? null : e.myRsvp, entryCost: e.entryCost,
  };
}

export const toNotification = (n: ServerNotification): Notification => ({
  id: n.id, type: n.type as Notification['type'], title: n.title, body: n.body, createdAt: n.createdAt, read: n.isRead,
});

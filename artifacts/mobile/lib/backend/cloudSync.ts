/**
 * CloudSync — the signed-in user's data, kept in step with the API.
 *
 * Supabase (through the API) is the source of truth. This class:
 *   1. shows the user's cached data at once (namespaced per user id),
 *   2. refreshes everything from the API and replaces the cache,
 *   3. applies edits immediately and queues them in the outbox when the
 *      server can't be reached, replaying them later in order,
 *   4. records drives on the device and uploads them (see journeyRecorder),
 *      from the Drive screen and, while a drive is in progress, from
 *      background location updates (see driveTracking),
 *   5. reports connection and sync status so the app can show it.
 *
 * It has no React Native dependencies, so the same code runs in the app and
 * in the Node tests against staging.
 */
import type { Endpoints, LocationKind, SpotCategory, Visibility } from './endpoints';
import { ApiError, describeError, isRetryable, type ConnectionState } from './http';
import {
  JourneyStore, acceptDriveFix, activeDriveMs, isLongEnoughToSave, lastRecordedFix, newJourneyRecord, noteFixTime, recordFix,
  setRecordPaused, syncJourneyRecord, type FixRef, type GpsFix, type JourneyRecord,
} from './journeyRecorder';
import type { BackgroundTracking, DriveTracker } from './driveTracking';
import { decayPresence, type DriveState, type FriendPresenceStatus, type PresenceEvent } from './presence';
import {
  friendStatus, toCategory, toConvoy, toEvent, toFriend, toFriendRequests, toGroup, toJourney, toNearbySpot, toNotification,
  toPlace, toProfile, toStats, toVehicle, vehicleFields,
} from './mappers';
import type {
  BlockedUser, CachedData, Friend, Journey, JourneyCategory, NearbySpot, SavedPlace, UserProfile, Vehicle, VehicleSnapshot,
} from './model';
import { Outbox, isLocalId, type OutboxOp, type OutboxState, type Rejection } from './outbox';
import { readJson, userKey, writeJson, type KeyValueStore } from './storage';
import { uploadAvatar, uploadVehiclePhoto, type PreparedFile } from './uploads';

export interface SyncStatus {
  connection: ConnectionState | 'unknown';
  /** Changes waiting in the outbox. */
  pendingChanges: number;
  /** Drives recorded on this device that haven't finished uploading. */
  pendingJourneys: number;
  refreshing: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Changes the server refused; shown to the user until dismissed. */
  rejected: Rejection[];
  /** Whether the drive in progress is also recorded in the background. */
  backgroundTracking: BackgroundTracking;
}

export interface CloudSyncDeps {
  ep: Endpoints;
  store: KeyValueStore;
  userId: string;
  publishableKey: string;
  /** Turns a local image into an upload body (resized in the app). */
  prepareFile: (uri: string, purpose: 'photo' | 'avatar') => Promise<PreparedFile>;
  newId: () => string;
  timezone: () => string;
  fetchImpl?: typeof fetch;
  /** Clock (injectable for tests). */
  now?: () => number;
  /** Background location recording during drives (none in the Node tests against staging). */
  tracker?: DriveTracker;
  /** Wait before retrying a friends refresh that failed after an action (ms). */
  friendsRetryMs?: number;
}

/** A friends refresh that failed after a successful action is retried after this long. */
const FRIENDS_RETRY_MS = 3_000;

/** How the friend list shows a presence status (Away as offline for now). */
const shownAs = (s: FriendPresenceStatus | null) => friendStatus(s ? { status: s, lastSeenAt: null } : null);

export function emptyData(): CachedData {
  return {
    version: 1, savedAt: new Date(0).toISOString(),
    profile: { name: 'Driver', level: 1, xp: 0, xpToNextLevel: 1000, totalDistance: 0, totalJourneys: 0, achievements: [] },
    unitSystem: 'auto', vehicles: [], journeys: [], categories: [], places: [], friends: [], friendRequests: [],
    blockedUsers: [], convoys: [], groups: [], events: [], notifications: [],
    profileStats: { friends: 0, vehicles: 0, journeys: 0, totalDistance: 0 },
  };
}

const PERSIST_POINTS_EVERY_MS = 5_000;
const FLUSH_POINTS_EVERY_MS = 30_000;
/** Parked or paused, the drive is still saved this often (it records when the last fix came). */
const PERSIST_HEARTBEAT_EVERY_MS = 60_000;
/**
 * On a relaunch, a drive whose background updates are still running is
 * carried on if a fix arrived within this long; otherwise it is finished as
 * an interrupted drive.
 */
export const RESUME_DRIVE_WITHIN_MS = 15 * 60_000;

export class CloudSync {
  data: CachedData = emptyData();
  status: SyncStatus = {
    connection: 'unknown', pendingChanges: 0, pendingJourneys: 0, refreshing: false,
    lastSyncedAt: null, lastError: null, rejected: [], backgroundTracking: 'off',
  };
  readonly outbox: Outbox;
  private readonly journeys: JourneyStore;
  private active: JourneyRecord | null = null;
  private pending: JourneyRecord[] = [];
  /** clientRef → server id for drives uploaded during this session. */
  private journeyIds = new Map<string, string>();
  private lastPointPersist = 0;
  private lastPointFlush = 0;
  /** The newest fix accepted for the drive in progress (for de-duplication). */
  private lastFix: FixRef | null = null;
  private passenger = false;
  private fixListeners = new Set<(fix: GpsFix) => void>();
  private driveListeners = new Set<(drive: DriveState) => void>();
  private activityListeners = new Set<() => void>();
  private lastDriveState: DriveState = { driving: false, journeyId: null };
  private detachTracker: (() => void) | null = null;
  private journeySync: Promise<void> | null = null;
  private activePush: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private wiped = false;
  /** Bumped whenever a change reaches the server (to detect refresh races). */
  private completedChanges = 0;
  /**
   * Bumped whenever a friend action (send, accept, decline, remove) succeeds.
   * Friends data fetched before the latest action is out of date and is never
   * applied over what the action showed.
   */
  private friendsVersion = 0;
  /** Friend actions in flight, by action and target: a second tap joins the first. */
  private friendActions = new Map<string, Promise<unknown>>();
  private friendsRetry: ReturnType<typeof setTimeout> | null = null;
  private friendsSettled: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CloudSyncDeps) {
    this.outbox = new Outbox(deps.store, deps.userId, (op) => this.execute(op));
    this.journeys = new JourneyStore(deps.store, deps.userId);
    this.outbox.subscribe((s: OutboxState) => {
      this.setStatus({ pendingChanges: s.pending, rejected: s.rejected, ...(s.lastError ? { lastError: s.lastError } : {}) });
    });
  }

  get userId() { return this.deps.userId; }
  private now() { return this.deps.now ? this.deps.now() : Date.now(); }
  private get ep() { return this.deps.ep; }
  private get cacheKey() { return userKey(this.deps.userId, 'cache/v1'); }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() { if (!this.disposed) for (const fn of this.listeners) fn(); }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  /** Called by the HTTP client after every request. */
  reportConnection(state: ConnectionState, detail?: string) {
    if (state === this.status.connection && !detail) return;
    let lastError = this.status.lastError;
    if (detail) lastError = detail;
    else if (state === 'online' && !this.status.pendingChanges) lastError = null;
    this.setStatus({ connection: state, lastError });
  }

  private update(fn: (d: CachedData) => CachedData) {
    this.data = fn(this.data);
    this.emit();
    this.scheduleCacheWrite();
  }

  private scheduleCacheWrite() {
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => { void this.writeCache(); }, 300);
  }

  async writeCache() {
    if (this.cacheTimer) { clearTimeout(this.cacheTimer); this.cacheTimer = null; }
    if (this.disposed) return;
    await writeJson(this.deps.store, this.cacheKey, { ...this.data, savedAt: new Date().toISOString() });
  }

  // ─── Start-up ─────────────────────────────────────────────────────────────

  /** Loads the cache, outbox and unfinished drives from the device. */
  async start(): Promise<void> {
    const cached = await readJson<CachedData | null>(this.deps.store, this.cacheKey, null);
    if (cached?.version === 1) this.data = cached;
    await this.outbox.load();
    // Background fixes come here from now on; any recorded while the app had
    // no screens are saved to the device first, so loading below includes them.
    const tracker = this.deps.tracker;
    this.detachTracker?.();
    this.detachTracker = tracker ? await tracker.attach(this.deps.userId, (fixes) => { for (const f of fixes) this.addFix(f); }) : null;
    this.active = await this.journeys.loadActive();
    this.pending = await this.journeys.loadPending();
    const session = tracker ? await tracker.running().catch(() => null) : null;
    if (this.active) {
      const rec = this.active;
      if (session && session.userId === this.deps.userId && session.clientRef === rec.clientRef && this.isRecent(rec)) {
        // Still being recorded in the background (the system relaunched the
        // app, or it was reopened moments after closing): carry on with it.
        this.lastFix = lastRecordedFix(rec);
        this.lastPointFlush = this.now();
        this.status = { ...this.status, backgroundTracking: 'on' };
        void this.pushActive();
      } else {
        // A drive that was still "active" when the app was killed is finished
        // now (or thrown away, if it had under 10 s of active, unpaused driving).
        await tracker?.stop().catch(() => {});
        const last = rec.points[rec.points.length - 1];
        rec.endedAt = last?.recordedAt ?? rec.startedAt;
        this.active = null;
        await this.journeys.saveActive(null);
        if (isLongEnoughToSave(activeDriveMs(rec, this.now()))) {
          this.pending.push(rec);
          await this.journeys.savePending(this.pending);
        } else if (rec.serverId) {
          await this.queue({ kind: 'journey.delete', id: rec.serverId });
        }
      }
    } else {
      // Background updates with no drive to record: never leave them running.
      await tracker?.stop().catch(() => {});
    }
    this.data = this.withPendingJourneys(this.data);
    this.setStatus({ pendingJourneys: this.pending.length, lastSyncedAt: cached?.savedAt ?? null });
    this.notifyDrive();
  }

  /** Full refresh: upload what's waiting, then reload everything. */
  async sync(): Promise<void> {
    await this.outbox.flush();
    await this.syncJourneys();
    await this.refresh();
  }

  /** Reloads all data from the API. Sections that fail keep their cached value. */
  async refresh(): Promise<void> {
    if (this.status.refreshing) return;
    // If a queued change reaches the server while the lists are being fetched,
    // the fetched data may predate it; fetch again so it can't briefly vanish.
    // Likewise a friend action completing mid-refresh: its lists are fetched again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = this.completedChanges;
      const friendsBefore = this.friendsVersion;
      await this.refreshOnce();
      if (this.completedChanges === before && this.friendsVersion === friendsBefore) return;
    }
  }

  private async refreshOnce(): Promise<void> {
    this.setStatus({ refreshing: true });
    const ep = this.ep;
    const friendsVersion = this.friendsVersion;
    const [
      me, achievements, stats, vehicles, journeys, categories, places, friends, requests, blocks,
      convoys, groups, events, notifications,
    ] = await Promise.allSettled([
      ep.getMe(), ep.getAchievements(), ep.getStats(), ep.listVehicles(), ep.listJourneys(), ep.listCategories(),
      ep.listLocations(), ep.listFriends(), ep.listFriendRequests(), ep.listBlocks(), ep.listConvoys(),
      ep.listGroups(), ep.listEvents(), ep.listNotifications(),
    ]);
    const ok = <T>(r: PromiseSettledResult<T>): T | undefined => (r.status === 'fulfilled' ? r.value : undefined);
    const failures = [me, vehicles, journeys].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    // A friend action finished while these were fetched: keep what it showed
    const friendsCurrent = this.friendsVersion === friendsVersion;
    this.update((d) => {
      const next: CachedData = { ...d };
      const m = ok(me);
      if (m) {
        next.profile = toProfile(m, ok(achievements)?.map((a) => ({
          id: a.id, title: a.title, description: a.description, icon: a.icon, unlockedAt: a.unlockedAt,
        })) ?? d.profile.achievements);
        if (m.settings) next.unitSystem = m.settings.unitSystem;
      }
      const s = ok(stats); if (s && friendsCurrent) next.profileStats = toStats(s);
      const v = ok(vehicles); if (v) next.vehicles = v.map(toVehicle);
      const j = ok(journeys); if (j) next.journeys = j.map(toJourney);
      const c = ok(categories); if (c) next.categories = c.map(toCategory);
      const p = ok(places); if (p) next.places = p.map(toPlace);
      const f = ok(friends); if (f && friendsCurrent) next.friends = this.friendsFromServer(f);
      const fr = ok(requests); if (fr && friendsCurrent) next.friendRequests = toFriendRequests(fr);
      const b = ok(blocks); if (b) next.blockedUsers = b.map((x): BlockedUser => ({ id: x.id, blockedName: x.displayName }));
      const cv = ok(convoys); if (cv) next.convoys = cv.map(toConvoy);
      const g = ok(groups); if (g) next.groups = g.map(toGroup);
      const e = ok(events); if (e) next.events = e.map(toEvent);
      const n = ok(notifications); if (n) next.notifications = n.items.map(toNotification);
      return this.withPendingJourneys(this.withPendingChanges(next));
    });

    this.setStatus({
      refreshing: false,
      ...(failures.length
        ? { lastError: describeError(failures[0]!.reason) }
        : { lastSyncedAt: new Date().toISOString(), lastError: this.status.pendingChanges ? this.status.lastError : null }),
    });
    await this.writeCache();
  }

  /** Re-applies queued (not yet uploaded) edits on top of server data. */
  private withPendingChanges(d: CachedData): CachedData {
    const out = { ...d, vehicles: [...d.vehicles], places: [...d.places], journeys: [...d.journeys], categories: [...d.categories] };
    const local = (id: string) => this.outbox.resolve(id);
    for (const op of this.outbox.queued) {
      switch (op.kind) {
        case 'profile.update':
          out.profile = { ...out.profile, ...profileFromFields(op.fields) };
          break;
        case 'settings.update':
          if (op.fields.unitSystem) out.unitSystem = op.fields.unitSystem as CachedData['unitSystem'];
          break;
        case 'vehicle.create':
          if (!out.vehicles.some((v) => v.id === op.id)) out.vehicles.push(vehicleFromCreate(op.id, op.fields));
          break;
        case 'vehicle.photo':
          out.vehicles = out.vehicles.map((v) => (v.id === op.id || v.id === local(op.id) ? { ...v, imageUri: op.uri, syncState: 'pending' } : v));
          break;
        case 'vehicle.photoRemove':
          out.vehicles = out.vehicles.map((v) => (v.id === op.id || v.id === local(op.id) ? { ...v, imageUri: null, syncState: 'pending' } : v));
          break;
        case 'vehicle.update':
          out.vehicles = out.vehicles.map((v) => (v.id === op.id || v.id === local(op.id) ? { ...v, ...vehicleFromFields(op.fields), syncState: 'pending' } : v));
          break;
        case 'vehicle.delete':
          out.vehicles = out.vehicles.filter((v) => v.id !== op.id && v.id !== local(op.id));
          break;
        case 'vehicle.activate':
          out.vehicles = out.vehicles.map((v) => ({ ...v, isActive: v.id === op.id || v.id === local(op.id) }));
          break;
        case 'location.create':
          if (!out.places.some((p) => p.id === op.id)) out.places.unshift(placeFromCreate(op.id, op.fields));
          break;
        case 'location.update':
          out.places = out.places.map((p) => (p.id === op.id || p.id === local(op.id) ? { ...p, ...placeFromFields(op.fields), syncState: 'pending' } : p));
          break;
        case 'location.delete':
          out.places = out.places.filter((p) => p.id !== op.id && p.id !== local(op.id));
          break;
        case 'journey.update':
          out.journeys = out.journeys.map((j) => (j.id === op.id ? { ...j, ...journeyFromFields(op.fields) } : j));
          break;
        case 'journey.delete':
          out.journeys = out.journeys.filter((j) => j.id !== op.id);
          break;
        default:
          break;
      }
    }
    return out;
  }

  private withPendingJourneys(d: CachedData): CachedData {
    const placeholders = this.pending.map((r) => this.placeholderJourney(r));
    const serverIds = new Set(d.journeys.map((j) => j.id));
    const kept = placeholders.filter((p) => !serverIds.has(this.journeyIds.get(p.id.slice(6)) ?? ''));
    const withoutOld = d.journeys.filter((j) => !j.id.startsWith('local:'));
    return { ...d, journeys: [...kept, ...withoutOld].sort((a, b) => (b.startedAtIso ?? b.date).localeCompare(a.startedAtIso ?? a.date)) };
  }

  private placeholderJourney(r: JourneyRecord): Journey {
    const start = new Date(r.startedAt);
    const end = r.endedAt ? new Date(r.endedAt) : new Date();
    const duration = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
    const speeds = r.points.map((p) => p.speedKmh).filter((s) => s > 0);
    return {
      id: `local:${r.clientRef}`,
      name: r.name ?? 'Unnamed Journey',
      date: r.startedAt.slice(0, 10),
      startTime: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      endTime: end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      duration,
      distance: Math.round(r.clientDistanceKm * 10) / 10,
      averageSpeed: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0,
      topSpeed: Math.round(r.topSpeedKmh),
      vehicleId: r.vehicleId ?? '',
      notes: '',
      routeCoordinates: r.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
      photos: [],
      journeyType: 'personal',
      xpEarned: 0,
      vehicleSnapshot: (r.vehicleSnapshot as unknown as VehicleSnapshot) ?? undefined,
      privacy: 'private',
      startedAtIso: r.startedAt,
      syncState: r.rejected ? 'failed' : 'pending',
      syncError: r.lastError,
    };
  }

  // ─── Outbox execution ─────────────────────────────────────────────────────

  private async execute(op: OutboxOp): Promise<string | void> {
    const result = await this.executeOp(op);
    this.completedChanges++;
    return result;
  }

  private async executeOp(op: OutboxOp): Promise<string | void> {
    const ep = this.ep;
    switch (op.kind) {
      case 'profile.update': {
        const p = await ep.updateMe(op.fields as never);
        this.update((d) => ({ ...d, profile: { ...toProfile(p, d.profile.achievements) } }));
        return;
      }
      case 'settings.update':
        await ep.updateSettings(op.fields as never);
        return;
      case 'profile.avatar': {
        const url = await uploadAvatar(this.uploadDeps, await this.deps.prepareFile(op.uri, 'avatar'));
        this.update((d) => ({ ...d, profile: { ...d.profile, avatarUrl: url } }));
        return;
      }
      case 'vehicle.create': {
        const v = await ep.createVehicle({ ...(op.fields as { nickname: string }), clientRef: op.id });
        this.update((d) => ({ ...d, vehicles: d.vehicles.map((x) => (x.id === op.id ? { ...toVehicle(v), imageUri: x.imageUri } : x)) }));
        this.remapVehicleId(op.id, v.id);
        return v.id;
      }
      case 'vehicle.update': {
        const v = await ep.updateVehicle(op.id, op.fields);
        this.update((d) => ({ ...d, vehicles: d.vehicles.map((x) => (x.id === v.id ? { ...toVehicle(v), imageUri: v.coverPhotoUrl ?? x.imageUri } : x)) }));
        return;
      }
      case 'vehicle.delete':
        await ignoreNotFound(ep.deleteVehicle(op.id));
        return;
      case 'vehicle.activate':
        await ep.activateVehicle(op.id);
        return;
      case 'vehicle.photo': {
        // The vehicle shows one photo: the previous cover is deleted once the
        // new one is in place (its file is then removed from Storage).
        const previous = (await ep.getVehicle(op.id)).coverPhotoId;
        const vehicle = await uploadVehiclePhoto(this.uploadDeps, op.id, await this.deps.prepareFile(op.uri, 'photo'));
        this.update((d) => ({ ...d, vehicles: d.vehicles.map((x) => (x.id === vehicle.id ? toVehicle(vehicle) : x)) }));
        if (previous && previous !== vehicle.coverPhotoId) await ignoreNotFound(ep.deletePhoto(previous));
        return;
      }
      case 'vehicle.photoRemove': {
        const current = (await ep.getVehicle(op.id)).coverPhotoId;
        // Deleting the photo clears the cover and queues its file for removal.
        if (current) await ignoreNotFound(ep.deletePhoto(current));
        this.update((d) => ({ ...d, vehicles: d.vehicles.map((x) => (x.id === op.id ? { ...x, imageUri: null, coverPhotoId: null, syncState: 'synced' } : x)) }));
        return;
      }
      case 'location.create': {
        const l = await ep.createLocation({ ...(op.fields as { kind: LocationKind; name: string; lat: number; lng: number }), clientRef: op.id });
        this.update((d) => ({ ...d, places: d.places.map((p) => (p.id === op.id ? toPlace(l) : p)) }));
        return l.id;
      }
      case 'location.update': {
        const l = await ep.updateLocation(op.id, op.fields);
        this.update((d) => ({ ...d, places: d.places.map((p) => (p.id === l.id ? toPlace(l) : p)) }));
        return;
      }
      case 'location.delete':
        await ignoreNotFound(ep.deleteLocation(op.id));
        return;
      case 'journey.update':
        await ep.updateJourney(op.id, op.fields);
        return;
      case 'journey.delete':
        await ignoreNotFound(ep.deleteJourney(op.id));
        return;
      case 'category.create': {
        // Categories have no idempotency key, so a retry after a lost response
        // adopts the category created by the first attempt instead of duplicating it.
        const fields = op.fields as { name: string; icon: string; colour: string };
        const c = (await ep.listCategories()).find((x) => x.ownerId !== null && x.name === fields.name && x.icon === fields.icon && x.colour === fields.colour)
          ?? await ep.createCategory(fields);
        this.update((d) => ({ ...d, categories: d.categories.map((x) => (x.id === op.id ? toCategory(c) : x)) }));
        return c.id;
      }
      case 'category.update':
        await ep.updateCategory(op.id, op.fields);
        return;
      case 'category.delete':
        await ignoreNotFound(ep.deleteCategory(op.id));
        return;
    }
  }

  private get uploadDeps() {
    return { ep: this.ep, publishableKey: this.deps.publishableKey, fetchImpl: this.deps.fetchImpl };
  }

  private remapVehicleId(localId: string, serverId: string) {
    for (const r of [this.active, ...this.pending]) if (r && r.vehicleId === localId) r.vehicleId = serverId;
  }

  private async queue(op: OutboxOp) {
    await this.outbox.enqueue(op);
    void this.outbox.flush();
  }

  // ─── Profile & settings ──────────────────────────────────────────────────

  async updateProfile(p: Partial<UserProfile>) {
    const fields: Record<string, unknown> = {};
    if (p.name !== undefined && p.name.trim()) fields.displayName = p.name.trim();
    if (p.username !== undefined) fields.username = p.username?.trim() ? p.username.trim() : null;
    if (p.bio !== undefined) fields.bio = p.bio ?? '';
    this.update((d) => ({ ...d, profile: { ...d.profile, ...p } }));
    if (Object.keys(fields).length) await this.queue({ kind: 'profile.update', fields });
  }

  async setUnitSystem(unitSystem: CachedData['unitSystem']) {
    this.update((d) => ({ ...d, unitSystem }));
    await this.queue({ kind: 'settings.update', fields: { unitSystem } });
  }

  async setAvatar(uri: string) {
    this.update((d) => ({ ...d, profile: { ...d.profile, avatarUrl: uri } }));
    await this.queue({ kind: 'profile.avatar', uri });
  }

  // ─── Vehicles ─────────────────────────────────────────────────────────────

  async addVehicle(v: Omit<Vehicle, 'id'>): Promise<string> {
    const id = `local:${this.deps.newId()}`;
    const makeActive = v.isActive || this.data.vehicles.length === 0;
    const vehicle: Vehicle = { ...v, id, isActive: makeActive, syncState: 'pending' };
    this.update((d) => ({
      ...d,
      vehicles: [...d.vehicles.map((x) => (makeActive ? { ...x, isActive: false } : x)), vehicle],
    }));
    await this.outbox.enqueue({ kind: 'vehicle.create', id, fields: { ...vehicleFields(v), nickname: v.nickname?.trim() || `${v.make} ${v.model}`.trim() || 'My car', isActive: makeActive } });
    if (v.imageUri && isLocalFile(v.imageUri)) await this.outbox.enqueue({ kind: 'vehicle.photo', id, uri: v.imageUri });
    void this.outbox.flush();
    return id;
  }

  async updateVehicle(id: string, updates: Partial<Vehicle>) {
    this.update((d) => ({ ...d, vehicles: d.vehicles.map((v) => (v.id === id ? { ...v, ...updates } : v)) }));
    const fields = vehicleFields(updates);
    if (Object.keys(fields).length) await this.outbox.enqueue({ kind: 'vehicle.update', id, fields });
    if (updates.imageUri && isLocalFile(updates.imageUri)) await this.outbox.enqueue({ kind: 'vehicle.photo', id, uri: updates.imageUri });
    else if ('imageUri' in updates && updates.imageUri === null) await this.outbox.enqueue({ kind: 'vehicle.photoRemove', id });
    void this.outbox.flush();
  }

  async deleteVehicle(id: string) {
    this.update((d) => {
      const rest = d.vehicles.filter((v) => v.id !== id);
      if (rest.length && !rest.some((v) => v.isActive)) rest[0] = { ...rest[0]!, isActive: true };
      return { ...d, vehicles: rest };
    });
    await this.queue({ kind: 'vehicle.delete', id });
  }

  async setActiveVehicle(id: string) {
    this.update((d) => ({ ...d, vehicles: d.vehicles.map((v) => ({ ...v, isActive: v.id === id })) }));
    await this.queue({ kind: 'vehicle.activate', id });
  }

  lookupVehicle(registration: string) { return this.ep.lookupVehicle(registration); }

  // ─── Saved places & Beauty Spots ─────────────────────────────────────────

  async addPlace(input: {
    kind: LocationKind; name: string; coordinate: { latitude: number; longitude: number };
    description?: string; category?: SpotCategory | null; visibility?: Visibility;
  }): Promise<string> {
    const id = `local:${this.deps.newId()}`;
    // Home and Work are always private (the API enforces this too).
    const visibility = input.kind === 'home' || input.kind === 'work' ? 'private' : input.visibility;
    const place: SavedPlace = {
      id, kind: input.kind, category: input.category ?? null, name: input.name, description: input.description ?? '',
      address: '', coordinate: input.coordinate, visibility: visibility ?? 'private', createdAt: new Date().toISOString(),
      syncState: 'pending',
    };
    this.update((d) => ({ ...d, places: [place, ...d.places] }));
    await this.queue({
      kind: 'location.create', id,
      fields: {
        kind: input.kind, name: input.name, lat: input.coordinate.latitude, lng: input.coordinate.longitude,
        ...(input.description ? { description: input.description } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(visibility ? { visibility } : {}),
      },
    });
    return id;
  }

  async updatePlace(id: string, updates: Partial<Pick<SavedPlace, 'name' | 'description' | 'visibility' | 'category'>>) {
    this.update((d) => ({ ...d, places: d.places.map((p) => (p.id === id ? { ...p, ...updates } : p)) }));
    await this.queue({ kind: 'location.update', id, fields: { ...updates } });
  }

  async deletePlace(id: string) {
    this.update((d) => ({ ...d, places: d.places.filter((p) => p.id !== id) }));
    await this.queue({ kind: 'location.delete', id });
  }

  /** Beauty Spots near a point: public ones, friends' and the user's own. Online only. */
  async nearbySpots(lat: number, lng: number, radiusM = 25_000): Promise<NearbySpot[]> {
    const spots = await this.ep.nearbySpots(lat, lng, radiusM);
    return spots.map((s) => toNearbySpot(s, this.data.profile.id));
  }

  // ─── Categories ───────────────────────────────────────────────────────────

  async addCategory(c: Omit<JourneyCategory, 'id'>) {
    const id = `local:${this.deps.newId()}`;
    this.update((d) => ({ ...d, categories: [...d.categories, { ...c, id }] }));
    await this.queue({ kind: 'category.create', id, fields: { name: c.name, icon: c.icon, colour: c.colour } });
  }

  async updateCategory(id: string, u: Partial<JourneyCategory>) {
    this.update((d) => ({ ...d, categories: d.categories.map((c) => (c.id === id ? { ...c, ...u } : c)) }));
    const fields: Record<string, unknown> = {};
    for (const k of ['name', 'icon', 'colour'] as const) if (u[k] !== undefined) fields[k] = u[k];
    await this.queue({ kind: 'category.update', id, fields });
  }

  async deleteCategory(id: string) {
    this.update((d) => ({
      ...d,
      categories: d.categories.filter((c) => c.id !== id),
      journeys: d.journeys.map((j) => (j.categoryId === id ? { ...j, categoryId: undefined } : j)),
    }));
    await this.queue({ kind: 'category.delete', id });
  }

  // ─── Journeys ─────────────────────────────────────────────────────────────

  /** The server id of a journey the screen may still know by its local id. */
  resolveJourneyId(id: string): string {
    if (id.startsWith('local:')) return this.journeyIds.get(id.slice(6)) ?? id;
    return id;
  }

  async updateJourney(id: string, updates: Partial<Journey>) {
    const serverId = this.resolveJourneyId(id);
    this.update((d) => ({ ...d, journeys: d.journeys.map((j) => (j.id === id || j.id === serverId ? { ...j, ...updates } : j)) }));
    if (serverId.startsWith('local:')) {
      // Still uploading: keep the new name with the drive.
      const rec = this.pending.find((r) => `local:${r.clientRef}` === serverId);
      if (rec && updates.name) { rec.name = updates.name; await this.journeys.savePending(this.pending); }
      return;
    }
    const fields: Record<string, unknown> = {};
    if (updates.name !== undefined) fields.name = updates.name;
    if (updates.notes !== undefined) fields.notes = updates.notes;
    // `categoryId: undefined` means "remove the category", so check the key, not the value.
    if ('categoryId' in updates) {
      const category = updates.categoryId ? this.outbox.resolve(updates.categoryId) : null;
      fields.categoryId = category && !isLocalId(category) ? category : null;
    }
    if (updates.privacy !== undefined) fields.visibility = updates.privacy;
    if (Object.keys(fields).length) await this.queue({ kind: 'journey.update', id: serverId, fields });
  }

  async deleteJourney(id: string) {
    const serverId = this.resolveJourneyId(id);
    this.update((d) => ({ ...d, journeys: d.journeys.filter((j) => j.id !== id && j.id !== serverId) }));
    if (serverId.startsWith('local:')) {
      await this.discardPendingJourney(serverId);
      return;
    }
    await this.queue({ kind: 'journey.delete', id: serverId });
  }

  /** Throws away a drive that hasn't uploaded (e.g. one the server rejected). */
  async discardPendingJourney(localId: string) {
    this.pending = this.pending.filter((r) => `local:${r.clientRef}` !== localId);
    await this.journeys.savePending(this.pending);
    this.update((d) => ({ ...d, journeys: d.journeys.filter((j) => j.id !== localId) }));
    this.setStatus({ pendingJourneys: this.pending.length });
  }

  get isDriving() { return !!this.active; }
  get activeRecord() { return this.active; }
  get isDrivePaused() { return !!this.active?.pausedAt; }

  /** Whether a drive's last sign of life is recent enough to carry it on after a relaunch */
  private isRecent(rec: JourneyRecord): boolean {
    const times = [rec.startedAt, rec.lastFixAt, rec.pausedAt, rec.points[rec.points.length - 1]?.recordedAt]
      .filter((t): t is string => !!t).map((t) => Date.parse(t));
    return this.now() - Math.max(...times) <= RESUME_DRIVE_WITHIN_MS;
  }

  /**
   * Called with every fix accepted for the drive in progress, from either the
   * Drive screen or the background, in order and without duplicates: the
   * live route on screen is built from these.
   */
  onDriveFix(fn: (fix: GpsFix) => void): () => void {
    this.fixListeners.add(fn);
    return () => { this.fixListeners.delete(fn); };
  }

  /** Whether a drive is in progress, and its server id once it has one (for presence). */
  get driveState(): DriveState {
    return { driving: !!this.active, journeyId: this.active?.serverId ?? null };
  }

  /**
   * Called when driveState changes: a drive started, ended, was discarded or
   * picked up after a relaunch, or its journey was created on the server.
   */
  onDriveChange(fn: (drive: DriveState) => void): () => void {
    this.driveListeners.add(fn);
    return () => { this.driveListeners.delete(fn); };
  }

  /** Called for every GPS fix delivered during a drive (screen or background), accepted or not. */
  onDriveActivity(fn: () => void): () => void {
    this.activityListeners.add(fn);
    return () => { this.activityListeners.delete(fn); };
  }

  private notifyDrive() {
    const next = this.driveState;
    if (next.driving === this.lastDriveState.driving && next.journeyId === this.lastDriveState.journeyId) return;
    this.lastDriveState = next;
    for (const fn of this.driveListeners) fn(next);
  }

  /** Passenger mode: nothing is recorded while it's on (it isn't saved, like the setting itself). */
  setPassengerMode(on: boolean): void {
    this.passenger = on;
  }

  /** Saves the drive in progress now (the app is going to the background). */
  async saveActiveNow(): Promise<void> {
    if (!this.active) return;
    this.lastPointPersist = this.now();
    await this.journeys.saveActive(this.active);
  }

  /** Active (unpaused) time of the drive in progress, as the drive timer counts it */
  activeDriveMs(): number | null {
    return this.active ? activeDriveMs(this.active, this.now()) : null;
  }

  /** The drive was paused or resumed: noted on the record so it survives a restart */
  setDrivePaused(paused: boolean): void {
    const rec = this.active;
    if (!rec) return;
    setRecordPaused(rec, paused, this.now());
    void this.journeys.saveActive(rec);
  }

  /**
   * Ends the drive in progress without saving it: nothing is added to the
   * drive history, nothing is left on the device, and the journey created on
   * the server when the drive started is deleted (queued, so it goes through
   * once back online).
   */
  async discardDrive(): Promise<void> {
    const rec = this.active;
    if (!rec) return;
    this.active = null;
    this.notifyDrive();
    await this.stopTracking();
    await this.journeys.saveActive(null);
    // The start-of-drive upload may still be creating the server journey
    if (this.activePush) await this.activePush;
    let serverId = rec.serverId;
    if (!serverId) {
      // Creating is idempotent on clientRef, so this finds the journey if the
      // first request reached the server but its reply never arrived.  Offline,
      // that first request can't have arrived either, so there's nothing to do.
      try {
        serverId = (await this.ep.startJourney({
          clientRef: rec.clientRef, startedAt: rec.startedAt, timezone: rec.timezone, vehicleId: null,
        })).id;
      } catch {
        serverId = null;
      }
    }
    if (serverId) await this.queue({ kind: 'journey.delete', id: serverId });
  }

  async startDrive(vehicle: Vehicle | null): Promise<void> {
    if (this.active) return;
    const snapshot = vehicle ? {
      vehicleId: vehicle.id, make: vehicle.make, model: vehicle.model, nickname: vehicle.nickname, year: vehicle.year,
      registration: vehicle.registration, imageUri: null, power: vehicle.power, engine: vehicle.engine,
    } : null;
    this.active = newJourneyRecord({
      clientRef: this.deps.newId(), startedAt: new Date(this.now()), timezone: this.deps.timezone(),
      vehicleId: vehicle?.id ?? null, vehicleSnapshot: snapshot,
    });
    this.lastPointFlush = this.now();
    this.lastFix = null;
    const rec = this.active;
    this.notifyDrive();
    await this.journeys.saveActive(rec);
    // Record in the background too, for as long as the drive lasts.
    void this.startTracking(rec);
    // Create the journey on the server straight away when online.
    void this.pushActive();
  }

  private async startTracking(rec: JourneyRecord) {
    const tracker = this.deps.tracker;
    if (!tracker) return;
    const result = await tracker.start({ userId: this.deps.userId, clientRef: rec.clientRef }).catch(() => 'unavailable' as const);
    if (this.active !== rec) {
      // The drive ended while the updates were starting.
      await tracker.stop().catch(() => {});
      return;
    }
    this.setStatus({ backgroundTracking: result });
  }

  private async stopTracking() {
    if (this.status.backgroundTracking !== 'off') this.setStatus({ backgroundTracking: 'off' });
    await this.deps.tracker?.stop().catch(() => {});
  }

  /**
   * Feeds a GPS fix, from the Drive screen or the background; returns true
   * when it was kept after thinning.  A fix already delivered by the other
   * source, an older one, or one arriving while paused or in passenger mode
   * is ignored.
   */
  addFix(fix: GpsFix): boolean {
    const rec = this.active;
    if (!rec) return false;
    const now = this.now();
    noteFixTime(rec, fix);
    for (const fn of this.activityListeners) fn();
    if (this.passenger || !acceptDriveFix(rec, this.lastFix, fix)) {
      if (now - this.lastPointPersist >= PERSIST_HEARTBEAT_EVERY_MS) {
        this.lastPointPersist = now;
        void this.journeys.saveActive(rec);
      }
      return false;
    }
    this.lastFix = fix;
    const kept = recordFix(rec, fix);
    if (now - this.lastPointPersist >= (kept ? PERSIST_POINTS_EVERY_MS : PERSIST_HEARTBEAT_EVERY_MS)) {
      this.lastPointPersist = now;
      void this.journeys.saveActive(rec);
    }
    for (const fn of this.fixListeners) fn(fix);
    if (now - this.lastPointFlush >= FLUSH_POINTS_EVERY_MS) {
      this.lastPointFlush = now;
      void this.pushActive();
    }
    return kept;
  }

  /** Uploads the drive in progress; never more than one upload at a time. */
  private pushActive(): Promise<void> {
    if (this.activePush) return this.activePush;
    const rec = this.active;
    if (!rec) return Promise.resolve();
    this.activePush = syncJourneyRecord(this.ep, rec, {
      resolveId: (id) => this.outbox.resolve(id),
      save: async (r) => {
        if (this.active !== r) return;
        this.notifyDrive(); // the journey now has its server id
        await this.journeys.saveActive(r);
      },
    }).then(() => undefined, () => {
      // Points stay on the device and go up with the next flush or at the end.
    }).finally(() => { this.activePush = null; });
    return this.activePush;
  }

  /** Ends the drive; returns the journey (server copy when upload succeeded). */
  async endDrive(): Promise<Journey | null> {
    const rec = this.active;
    if (!rec) return null;
    // Backstop for the Drive screen's own check: under 10 s of active driving
    // never saves
    if (!isLongEnoughToSave(activeDriveMs(rec, this.now()))) {
      await this.discardDrive();
      return null;
    }
    // No more fixes from here on.
    await this.stopTracking();
    // Let an upload that's already running finish first (it shares the record).
    if (this.activePush) await this.activePush;
    rec.endedAt = new Date(this.now()).toISOString();
    this.active = null;
    this.notifyDrive();
    this.pending.push(rec);
    await this.journeys.savePending(this.pending);
    await this.journeys.saveActive(null);
    this.update((d) => this.withPendingJourneys(d));
    this.setStatus({ pendingJourneys: this.pending.length });
    await this.syncJourneys();
    const serverId = this.journeyIds.get(rec.clientRef);
    const id = serverId ?? `local:${rec.clientRef}`;
    return this.data.journeys.find((j) => j.id === id) ?? this.placeholderJourney(rec);
  }

  /** Uploads finished drives waiting on this device. */
  syncJourneys(): Promise<void> {
    if (!this.journeySync) {
      this.journeySync = this.runJourneySync().finally(() => { this.journeySync = null; });
    }
    return this.journeySync;
  }

  private async runJourneySync() {
    for (const rec of [...this.pending]) {
      if (rec.rejected) continue;
      try {
        const journey = await syncJourneyRecord(this.ep, rec, {
          resolveId: (id) => this.outbox.resolve(id),
          save: () => this.journeys.savePending(this.pending),
        });
        if (!journey) continue;
        this.journeyIds.set(rec.clientRef, journey.id);
        this.completedChanges++;
        this.pending = this.pending.filter((r) => r !== rec);
        await this.journeys.savePending(this.pending);
        this.update((d) => {
          const others = d.journeys.filter((j) => j.id !== `local:${rec.clientRef}` && j.id !== journey.id);
          return { ...d, journeys: [toJourney(journey), ...others] };
        });
        this.setStatus({ pendingJourneys: this.pending.length });
        // XP, level and totals changed on the server.
        void this.refreshProfile();
      } catch (err) {
        rec.attempts++;
        rec.lastError = describeError(err);
        if (!isRetryable(err) && err instanceof ApiError && err.status !== 401) rec.rejected = true;
        await this.journeys.savePending(this.pending);
        this.update((d) => this.withPendingJourneys(d));
        if (isRetryable(err)) break;
      }
    }
  }

  private async refreshProfile() {
    try {
      const [me, stats] = await Promise.all([this.ep.getMe(), this.ep.getStats()]);
      this.update((d) => ({ ...d, profile: toProfile(me, d.profile.achievements), profileStats: toStats(stats) }));
      const achievements = await this.ep.getAchievements();
      this.update((d) => ({ ...d, profile: { ...d.profile, achievements: achievements.map((a) => ({ id: a.id, title: a.title, description: a.description, icon: a.icon, unlockedAt: a.unlockedAt })) } }));
    } catch {
      // The next full refresh picks it up.
    }
  }

  // ─── Social & community (online only; errors are thrown to the screen) ────

  private async refreshSection<T>(load: () => Promise<T>, apply: (d: CachedData, v: T) => CachedData) {
    const v = await load();
    this.update((d) => apply(d, v));
  }

  /** Friends from the API, noting when their presence was received (for decayPresence). */
  private friendsFromServer(list: Parameters<typeof toFriend>[0][]): Friend[] {
    const now = this.now();
    return list.map((f) => ({ ...toFriend(f), presenceAt: f.presence ? now : null }));
  }

  /**
   * A live update from the Realtime inbox, merged into the same friend list
   * the snapshot fills. Updates for anyone not in the list are ignored (the
   * next snapshot brings new friends).
   */
  applyPresenceEvent(e: PresenceEvent): void {
    if (!this.data.friends.some((f) => f.id === e.userId)) return;
    const now = this.now();
    this.update((d) => {
      if (e.type === 'unfriended') return { ...d, friends: d.friends.filter((f) => f.id !== e.userId) };
      return {
        ...d,
        friends: d.friends.map((f): Friend => {
          if (f.id !== e.userId) return f;
          if (e.type === 'hidden') return { ...f, status: 'offline', presence: null, lastSeenAt: null, presenceAt: null };
          return { ...f, status: shownAs(e.status), presence: e.status, lastSeenAt: e.lastSeenAt, presenceAt: now };
        }),
      };
    });
  }

  /** Re-derives what each friend's status shows now, as time passes with no update. */
  decayFriendPresence(): void {
    const now = this.now();
    const shown = (f: Friend) => shownAs(decayPresence(f.presence, f.presenceAt, now));
    if (!this.data.friends.some((f) => f.presence && shown(f) !== f.status)) return;
    this.update((d) => ({ ...d, friends: d.friends.map((f) => (f.presence && shown(f) !== f.status ? { ...f, status: shown(f) } : f)) }));
  }

  /**
   * Reloads friends, requests and stats.  Whatever loaded is applied in one go,
   * unless a friend action finished meanwhile (then it's older than what the
   * action showed, and dropped).  Rejects if any of the three failed.
   */
  async refreshFriends(): Promise<void> {
    const version = this.friendsVersion;
    const [friends, requests, stats] = await Promise.allSettled([
      this.ep.listFriends(), this.ep.listFriendRequests(), this.ep.getStats(),
    ]);
    if (this.friendsVersion === version) {
      this.update((d) => ({
        ...d,
        ...(friends.status === 'fulfilled' ? { friends: this.friendsFromServer(friends.value) } : {}),
        ...(requests.status === 'fulfilled' ? { friendRequests: toFriendRequests(requests.value) } : {}),
        ...(stats.status === 'fulfilled' ? { profileStats: toStats(stats.value) } : {}),
      }));
    }
    const failed = [friends, requests, stats].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason;
  }

  /** One call per action and target at a time: a second tap joins the first. */
  private friendAction<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.friendActions.get(key) as Promise<T> | undefined;
    if (running) return running;
    const action = run().finally(() => this.friendActions.delete(key));
    this.friendActions.set(key, action);
    return action;
  }

  /**
   * A friend action reached the server.  Its result shows at once (`apply`);
   * the lists then catch up in the background, and a failure there never makes
   * the action itself look failed (one retry follows shortly).
   */
  private friendActionDone(apply?: (d: CachedData) => CachedData) {
    this.friendsVersion++;
    if (apply) this.update(apply);
    if (this.friendsRetry) clearTimeout(this.friendsRetry);
    this.friendsRetry = null;
    this.friendsSettled = this.refreshFriends().catch(() => new Promise<void>((resolve) => {
      if (this.disposed) return resolve();
      this.friendsRetry = setTimeout(() => {
        this.friendsRetry = null;
        this.refreshFriends().catch(() => {}).finally(resolve);
      }, this.deps.friendsRetryMs ?? FRIENDS_RETRY_MS);
    }));
  }

  /** Resolves once the lists have caught up with the latest friend action. */
  whenFriendsSettled(): Promise<void> { return this.friendsSettled; }

  /**
   * Asks the driver with this code to be friends.  'accepted' when they had
   * already asked (or asked at the same moment): you're friends now.
   */
  sendFriendRequest(friendCode: string): Promise<'pending' | 'accepted'> {
    const code = friendCode.trim().toUpperCase();
    return this.friendAction(`send:${code}`, async () => {
      let status: 'pending' | 'accepted';
      try {
        status = (await this.ep.sendFriendRequest(code)).status;
      } catch (err) {
        // Our own request is already waiting (sent from another device, or
        // the reply to an earlier send was lost): it stands, so this is sent
        if (err instanceof ApiError && err.code === 'request_pending') status = 'pending';
        else throw err;
      }
      this.friendActionDone();
      return status;
    });
  }

  acceptFriendRequest(id: string): Promise<void> {
    return this.friendAction(`answer:${id}`, async () => {
      const request = this.data.friendRequests.find((r) => r.id === id);
      try {
        await this.ep.acceptFriendRequest(id);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        // It's no longer pending (they cancelled it, or it was answered on
        // another device): take it off the list, and say so
        this.friendActionDone((d) => ({ ...d, friendRequests: d.friendRequests.filter((r) => r.id !== id) }));
        throw new ApiError(404, 'request_gone', 'That friend request is no longer pending.');
      }
      this.friendActionDone((d) => ({
        ...d,
        friendRequests: d.friendRequests.filter((r) => r.id !== id),
        friends: request && !d.friends.some((f) => f.id === request.fromId)
          ? [...d.friends, { id: request.fromId, name: request.fromName, initials: request.fromInitials, status: 'offline', presence: null, lastSeenAt: null, location: '' }]
          : d.friends,
      }));
    });
  }

  declineFriendRequest(id: string): Promise<void> {
    return this.friendAction(`answer:${id}`, async () => {
      try {
        await this.ep.declineFriendRequest(id);
      } catch (err) {
        // Already gone: declining it is done either way
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      this.friendActionDone((d) => ({ ...d, friendRequests: d.friendRequests.filter((r) => r.id !== id) }));
    });
  }

  removeFriend(userId: string): Promise<void> {
    return this.friendAction(`remove:${userId}`, async () => {
      try {
        await this.ep.removeFriend(userId);
      } catch (err) {
        // Already removed (by them, or on another device)
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      this.friendActionDone((d) => ({ ...d, friends: d.friends.filter((f) => f.id !== userId) }));
    });
  }
  async blockUser(userId: string) {
    await this.ep.block(userId);
    await this.refreshSection(() => this.ep.listBlocks(), (d, b) => ({ ...d, blockedUsers: b.map((x) => ({ id: x.id, blockedName: x.displayName })) }));
    await this.refreshFriends();
  }
  async unblockUser(userId: string) {
    await this.ep.unblock(userId);
    await this.refreshSection(() => this.ep.listBlocks(), (d, b) => ({ ...d, blockedUsers: b.map((x) => ({ id: x.id, blockedName: x.displayName })) }));
  }

  refreshConvoys() { return this.refreshSection(() => this.ep.listConvoys(), (d, c) => ({ ...d, convoys: c.map(toConvoy) })); }
  refreshGroups() { return this.refreshSection(() => this.ep.listGroups(), (d, g) => ({ ...d, groups: g.map(toGroup) })); }
  refreshEvents() { return this.refreshSection(() => this.ep.listEvents(), (d, e) => ({ ...d, events: e.map(toEvent) })); }

  async markNotificationRead(id: string) {
    this.update((d) => ({ ...d, notifications: d.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)) }));
    await this.ep.markNotificationRead(id);
  }
  async markAllNotificationsRead() {
    this.update((d) => ({ ...d, notifications: d.notifications.map((n) => ({ ...n, read: true })) }));
    await this.ep.markAllNotificationsRead();
  }

  // ─── Sign-out & account deletion ──────────────────────────────────────────

  /** True when signing out now would lose changes not yet on the server. */
  get hasUnsyncedWork() { return this.status.pendingChanges > 0 || this.pending.length > 0 || !!this.active; }

  /** Removes everything this user has cached on the device. */
  async wipeLocal() {
    this.wiped = true;
    this.disposed = true;
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    // Signing out mid-drive: the drive is deleted below, so stop recording it.
    this.active = null;
    this.notifyDrive();
    this.detachTracker?.();
    this.detachTracker = null;
    await this.deps.tracker?.stop().catch(() => {});
    await this.outbox.clear();
    await this.journeys.clearAll();
    await this.deps.store.removeItem(this.cacheKey);
  }

  /**
   * Stops cache writes and notifications. Subscribers remove themselves;
   * React may re-run the provider's effect on the same instance (development
   * double-mount, Fast Refresh), which calls resume().
   */
  dispose() {
    this.disposed = true;
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    if (this.friendsRetry) clearTimeout(this.friendsRetry);
    // Background updates keep running (the drive goes on); with no listener,
    // their fixes are saved to the device for the next start().
    this.detachTracker?.();
    this.detachTracker = null;
  }

  resume() {
    if (!this.wiped) this.disposed = false;
  }
}

async function ignoreNotFound(p: Promise<unknown>) {
  try { await p; } catch (err) { if (!(err instanceof ApiError && err.status === 404)) throw err; }
}

const isLocalFile = (uri: string) => /^(file|content|ph|assets-library|blob|data):/.test(uri);

function profileFromFields(f: Record<string, unknown>): Partial<UserProfile> {
  const out: Partial<UserProfile> = {};
  if (typeof f.displayName === 'string') out.name = f.displayName;
  if (f.username !== undefined) out.username = (f.username as string | null) ?? undefined;
  if (typeof f.bio === 'string') out.bio = f.bio;
  return out;
}

function vehicleFromFields(f: Record<string, unknown>): Partial<Vehicle> {
  const out: Record<string, unknown> = { ...f };
  if ('topSpeedSpec' in f) { out.topSpeed = f.topSpeedSpec; delete out.topSpeedSpec; }
  if ('year' in f) out.year = (f.year as number | null) ?? 0;
  return out as Partial<Vehicle>;
}

function vehicleFromCreate(id: string, f: Record<string, unknown>): Vehicle {
  return {
    id, nickname: String(f.nickname ?? ''), registration: String(f.registration ?? ''), make: String(f.make ?? ''),
    model: String(f.model ?? ''), year: (f.year as number | null) ?? 0, colour: String(f.colour ?? ''),
    fuelType: (f.fuelType as Vehicle['fuelType']) ?? 'petrol', engine: String(f.engine ?? ''), power: String(f.power ?? ''),
    torque: String(f.torque ?? ''), zeroToSixty: String(f.zeroToSixty ?? ''), topSpeed: String(f.topSpeedSpec ?? ''),
    mileage: Number(f.mileage ?? 0), fuelPercentage: 0, imageUri: null, isActive: f.isActive === true, syncState: 'pending',
  };
}

function placeFromCreate(id: string, f: Record<string, unknown>): SavedPlace {
  return {
    id, kind: f.kind as LocationKind, category: (f.category as SpotCategory | undefined) ?? null, name: String(f.name ?? ''),
    description: String(f.description ?? ''), address: '', coordinate: { latitude: Number(f.lat), longitude: Number(f.lng) },
    visibility: (f.visibility as Visibility | undefined) ?? (f.kind === 'beauty_spot' ? 'private' : 'private'),
    createdAt: new Date().toISOString(), syncState: 'pending',
  };
}

function placeFromFields(f: Record<string, unknown>): Partial<SavedPlace> {
  const out: Partial<SavedPlace> = {};
  if (typeof f.name === 'string') out.name = f.name;
  if (typeof f.description === 'string') out.description = f.description;
  if (f.visibility) out.visibility = f.visibility as Visibility;
  if (f.category !== undefined) out.category = f.category as SpotCategory | null;
  return out;
}

function journeyFromFields(f: Record<string, unknown>): Partial<Journey> {
  const out: Partial<Journey> = {};
  if (typeof f.name === 'string') out.name = f.name;
  if (typeof f.notes === 'string') out.notes = f.notes;
  if (f.visibility) out.privacy = f.visibility as Visibility;
  if (f.categoryId !== undefined) out.categoryId = (f.categoryId as string | null) ?? undefined;
  return out;
}

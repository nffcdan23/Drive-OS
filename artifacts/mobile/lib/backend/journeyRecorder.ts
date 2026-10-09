/**
 * Journey recording and upload.
 *
 * The screen shows every GPS fix (about one a second), but only a thinned
 * set of points is stored and uploaded: at most one every 3 s, and only after
 * moving 25 m or turning more than 15°. Fixes worse than 100 m accuracy are
 * dropped (the server ignores them for distance anyway).
 *
 * Each drive is a JourneyRecord kept on the device (per user) until the
 * server has it. Uploading is idempotent end to end: the journey is created
 * with a client reference, points are sent in batches the server
 * de-duplicates, and completion can be repeated safely. So a drive recorded
 * offline, or interrupted by a crash, uploads later without duplicates.
 */
import { msToKmh } from '../units';
import { bearingDeg, distanceM, turnDeg } from './geo';
import type { Endpoints, RoutePointInput, ServerJourney, Visibility } from './endpoints';
import { ApiError } from './http';
import { readJson, readJsonChecked, userKey, writeJson, type CheckedRead, type KeyValueStore } from './storage';

export const THINNING = {
  minIntervalMs: 3_000,
  minDistanceM: 25,
  minTurnDeg: 15,
  /** A turn only counts after moving this far (GPS jitter when crawling). */
  turnMinMoveM: 5,
  /** In slow traffic, still keep a point this often once moved a little. */
  maxGapMs: 60_000,
  maxAccuracyM: 100,
} as const;

const BATCH_SIZE = 500; // API limit is 1000 per request
const CLOCK_SKEW_MS = 4 * 60_000; // API allows 5 minutes

export interface GpsFix {
  latitude: number;
  longitude: number;
  /** metres per second, or null when unknown */
  speedMs: number | null;
  headingDeg?: number | null;
  accuracyM?: number | null;
  altitudeM?: number | null;
  timestamp: number;
}

export interface RecordedPoint {
  recordedAt: string;
  latitude: number;
  longitude: number;
  speedKmh: number;
  headingDeg: number | null;
  accuracyM: number | null;
  altitudeM: number | null;
}

/** Decides whether a fix is worth storing, given the points kept so far. */
export function shouldKeepPoint(kept: RecordedPoint[], fix: GpsFix): boolean {
  if (fix.accuracyM != null && fix.accuracyM > THINNING.maxAccuracyM) return false;
  const last = kept[kept.length - 1];
  if (!last) return true;
  const dt = fix.timestamp - Date.parse(last.recordedAt);
  if (dt < THINNING.minIntervalMs) return false;
  const moved = distanceM(last, fix);
  if (moved >= THINNING.minDistanceM) return true;
  const prev = kept[kept.length - 2];
  if (prev && moved >= THINNING.turnMinMoveM && distanceM(prev, last) >= THINNING.turnMinMoveM) {
    if (turnDeg(bearingDeg(prev, last), bearingDeg(last, fix)) > THINNING.minTurnDeg) return true;
  }
  return dt >= THINNING.maxGapMs && moved >= THINNING.turnMinMoveM;
}

export function toPoint(fix: GpsFix): RecordedPoint {
  return {
    recordedAt: new Date(fix.timestamp).toISOString(),
    latitude: fix.latitude,
    longitude: fix.longitude,
    speedKmh: Math.min(msToKmh(fix.speedMs), 350),
    headingDeg: fix.headingDeg != null && fix.headingDeg >= 0 ? fix.headingDeg % 360 : null,
    accuracyM: fix.accuracyM ?? null,
    altitudeM: fix.altitudeM ?? null,
  };
}

export interface JourneyRecord {
  /** Idempotency key sent to the API; also the local journey id. */
  clientRef: string;
  startedAt: string;
  endedAt: string | null;
  timezone: string;
  /** Server vehicle id, or a `local:` id resolved when uploading. */
  vehicleId: string | null;
  vehicleSnapshot: Record<string, unknown> | null;
  name: string | null;
  /** Who can see the drive, when chosen before it finished uploading. */
  visibility?: Visibility | null;
  points: RecordedPoint[];
  uploadedCount: number;
  serverId: string | null;
  /** On-device estimate, used only when the server has too few points. */
  clientDistanceKm: number;
  topSpeedKmh: number;
  attempts: number;
  lastError: string | null;
  /** Set when the server rejected the journey; kept until the user discards it. */
  rejected: boolean;
  /**
   * Time spent paused so far (ms), and when the current pause began.  Only
   * used to tell how long the drive has actually been driven; the saved
   * journey's own duration is unchanged.  Optional so records saved by older
   * builds still load.
   */
  pausedMs?: number;
  pausedAt?: string | null;
  /**
   * When the last GPS fix for this drive arrived (kept or not), saved now and
   * then.  Tells a relaunch whether the drive was still being tracked moments
   * ago (resume it) or went quiet long ago (finish it).  Optional for older
   * records.
   */
  lastFixAt?: string | null;
}

/**
 * Drives with less active time than this are never saved.  Active time is
 * what the Drive screen's timer counts: time paused doesn't count.
 */
export const MIN_DRIVE_MS = 10_000;

/**
 * How long a drive has been actively driven at `endMs` (or was, once ended):
 * start to end, minus the time spent paused, including a pause still open.
 * The same rule as the on-screen drive timer, computed from timestamps so it
 * survives the app being killed.
 */
export function activeDriveMs(
  rec: Pick<JourneyRecord, 'startedAt' | 'endedAt' | 'pausedMs' | 'pausedAt'>,
  endMs: number,
): number {
  const end = rec.endedAt ? Date.parse(rec.endedAt) : endMs;
  const openPause = rec.pausedAt ? Math.max(0, end - Date.parse(rec.pausedAt)) : 0;
  return Math.max(0, end - Date.parse(rec.startedAt) - (rec.pausedMs ?? 0) - openPause);
}

/** Records a pause starting or ending on a drive record */
export function setRecordPaused(rec: JourneyRecord, paused: boolean, atMs: number): void {
  if (paused && !rec.pausedAt) {
    rec.pausedAt = new Date(atMs).toISOString();
  } else if (!paused && rec.pausedAt) {
    rec.pausedMs = (rec.pausedMs ?? 0) + Math.max(0, atMs - Date.parse(rec.pausedAt));
    rec.pausedAt = null;
  }
}

/** Whether a drive with this much active time may be saved (10 s exactly is allowed) */
export function isLongEnoughToSave(durationMs: number): boolean {
  return durationMs >= MIN_DRIVE_MS;
}

export function newJourneyRecord(input: {
  clientRef: string; startedAt: Date; timezone: string; vehicleId: string | null; vehicleSnapshot: Record<string, unknown> | null;
}): JourneyRecord {
  return {
    clientRef: input.clientRef, startedAt: input.startedAt.toISOString(), endedAt: null, timezone: input.timezone,
    vehicleId: input.vehicleId, vehicleSnapshot: input.vehicleSnapshot, name: null, points: [], uploadedCount: 0,
    serverId: null, clientDistanceKm: 0, topSpeedKmh: 0, attempts: 0, lastError: null, rejected: false,
    pausedMs: 0, pausedAt: null,
  };
}

// ─── One gate for every fix source ──────────────────────────────────────────
//
// During a drive the same GPS fixes can arrive twice: from the Drive screen's
// foreground watcher and from the background location task (two location
// managers fed by the same GPS).  Both go through acceptDriveFix, so a fix is
// counted once whichever source delivers it first.

/** Fixes this close together in time are the same fix delivered twice. */
export const DUPLICATE_FIX_MS = 500;
/** Fixes vaguer than this don't extend the live route (the Drive screen's limit). */
export const LIVE_MAX_ACCURACY_M = 120;

export type FixRef = Pick<GpsFix, 'latitude' | 'longitude' | 'timestamp'>;

/** The newest fix a record already has, as the starting point for acceptDriveFix. */
export function lastRecordedFix(rec: JourneyRecord): FixRef | null {
  const p = rec.points[rec.points.length - 1];
  return p ? { latitude: p.latitude, longitude: p.longitude, timestamp: Date.parse(p.recordedAt) } : null;
}

/** Notes that the drive's location updates are alive (see JourneyRecord.lastFixAt). */
export function noteFixTime(rec: JourneyRecord, fix: GpsFix): void {
  if (!Number.isFinite(fix.timestamp)) return;
  if (!rec.lastFixAt || fix.timestamp > Date.parse(rec.lastFixAt)) rec.lastFixAt = new Date(fix.timestamp).toISOString();
}

/**
 * Whether a fix belongs on the drive: not a repeat or an older fix than the
 * last one accepted (`last`), not while paused, and not hopelessly vague.
 */
export function acceptDriveFix(rec: JourneyRecord, last: FixRef | null, fix: GpsFix): boolean {
  if (rec.endedAt || rec.pausedAt) return false;
  if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude) || !Number.isFinite(fix.timestamp)) return false;
  if (last && fix.timestamp <= last.timestamp + DUPLICATE_FIX_MS) return false;
  return fix.accuracyM == null || fix.accuracyM <= LIVE_MAX_ACCURACY_M;
}

/** Adds a fix to a record if it passes thinning; returns true when stored. */
export function recordFix(rec: JourneyRecord, fix: GpsFix): boolean {
  if (!shouldKeepPoint(rec.points, fix)) return false;
  const point = toPoint(fix);
  const last = rec.points[rec.points.length - 1];
  if (last) rec.clientDistanceKm += distanceM(last, point) / 1000;
  rec.topSpeedKmh = Math.max(rec.topSpeedKmh, point.speedKmh);
  rec.points.push(point);
  return true;
}

// ─── Storage (per user) ─────────────────────────────────────────────────────

/** Whether a stored value looks like a drive record (enough to work with) */
export function isJourneyRecord(v: unknown): v is JourneyRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<JourneyRecord>;
  return typeof r.clientRef === 'string' && typeof r.startedAt === 'string' && Array.isArray(r.points);
}

/**
 * Drives saved on the device, per user: the one in progress ("active") and
 * finished ones waiting to upload ("pending").
 *
 * readActive / readPending report a failed or unreadable read as such, never
 * as "no drive": callers must not decide anything about a drive they couldn't
 * read, and must not overwrite it.  An unreadable value is copied aside with
 * quarantine() before anything replaces it.
 */
export class JourneyStore {
  constructor(private readonly store: KeyValueStore, private readonly userId: string) {}
  private get activeKey() { return userKey(this.userId, 'journey/active'); }
  private get pendingKey() { return userKey(this.userId, 'journey/pending'); }
  private get quarantineIndexKey() { return userKey(this.userId, 'journey/quarantine'); }

  /** The saved drive in progress; null only when there is none. */
  readActive(): Promise<CheckedRead<JourneyRecord>> {
    return readJsonChecked<JourneyRecord>(this.store, this.activeKey, isJourneyRecord);
  }
  /** Finished drives waiting to upload; an empty list only when there are none. */
  readPending(): Promise<CheckedRead<JourneyRecord[]>> {
    return readJsonChecked<JourneyRecord[]>(this.store, this.pendingKey, (v) => Array.isArray(v) && v.every(isJourneyRecord));
  }
  saveActive(rec: JourneyRecord | null) {
    return rec ? writeJson(this.store, this.activeKey, rec) : this.store.removeItem(this.activeKey);
  }
  savePending(list: JourneyRecord[]) { return writeJson(this.store, this.pendingKey, list); }

  /**
   * Copies an unreadable saved value aside, byte for byte, under its own key
   * (listed in the quarantine index), and checks the copy reads back the
   * same.  Returns the key, or throws when it couldn't be kept.
   */
  async quarantine(what: 'active' | 'pending', raw: string, atMs: number): Promise<string> {
    const key = userKey(this.userId, `journey/quarantine/${what}-${atMs}`);
    await this.store.setItem(key, raw);
    if ((await this.store.getItem(key)) !== raw) throw new Error('quarantine copy did not read back');
    try {
      const index = await readJson<string[]>(this.store, this.quarantineIndexKey, []);
      if (!index.includes(key)) await writeJson(this.store, this.quarantineIndexKey, [...index, key]);
    } catch {
      // The copy itself is kept; only the list of copies is behind.
    }
    return key;
  }

  async clearAll() {
    await this.store.removeItem(this.activeKey);
    await this.store.removeItem(this.pendingKey);
  }
}

/**
 * Pending drives with no two for the same drive: a crash between saving a
 * finished drive to pending and clearing it from active can leave both
 * copies, and the later one may have more points.  Keeps the copy with the
 * most points (then the latest activity), in first-seen order.
 */
export function dedupeDrives(list: readonly JourneyRecord[]): JourneyRecord[] {
  const byRef = new Map<string, JourneyRecord>();
  for (const rec of list) {
    const seen = byRef.get(rec.clientRef);
    if (!seen || moreComplete(rec, seen)) byRef.set(rec.clientRef, seen ? mergeUploadState(rec, seen) : rec);
    else byRef.set(rec.clientRef, mergeUploadState(seen, rec));
  }
  return [...byRef.values()];
}

function moreComplete(a: JourneyRecord, b: JourneyRecord): boolean {
  if (a.points.length !== b.points.length) return a.points.length > b.points.length;
  return lastActivityMs(a) > lastActivityMs(b);
}

/** The kept copy, with whatever the other copy already knows about its upload */
function mergeUploadState(kept: JourneyRecord, other: JourneyRecord): JourneyRecord {
  return {
    ...kept,
    serverId: kept.serverId ?? other.serverId,
    // Taking the other copy's server journey: send every point again (the
    // server ignores ones it already has)
    uploadedCount: kept.serverId ? kept.uploadedCount : 0,
    name: kept.name ?? other.name,
    visibility: kept.visibility ?? other.visibility ?? null,
    endedAt: kept.endedAt ?? other.endedAt,
  };
}

/**
 * The last moment a drive is known to have been under way: its newest point
 * or its newest fix (kept or not), never earlier than its start.  A crashed
 * drive is finished here, so it is never cut down to its start time (and
 * mistaken for a drive too short to save) just because its last fixes
 * weren't stored as points.
 */
export function lastActivityMs(rec: Pick<JourneyRecord, 'startedAt' | 'points' | 'lastFixAt'>): number {
  const times = [rec.startedAt, rec.lastFixAt, rec.points[rec.points.length - 1]?.recordedAt]
    .filter((t): t is string => !!t).map((t) => Date.parse(t)).filter(Number.isFinite);
  return Math.max(...times);
}

// ─── Upload ─────────────────────────────────────────────────────────────────

const toInput = (p: RecordedPoint): RoutePointInput => ({
  recordedAt: p.recordedAt, latitude: p.latitude, longitude: p.longitude, speedKmh: p.speedKmh,
  headingDeg: p.headingDeg, accuracyM: p.accuracyM, altitudeM: p.altitudeM,
});

/**
 * Pushes a record to the server as far as it can go: creates the journey,
 * uploads outstanding points, and — once the drive has ended — completes it.
 * Returns the completed journey, or null while the drive is still going.
 * `save` is called after each step so progress survives a crash.
 * Throws on failure; callers keep the record and retry later.
 */
export async function syncJourneyRecord(
  ep: Endpoints,
  rec: JourneyRecord,
  opts: { resolveId: (id: string | null) => string | null; save: (rec: JourneyRecord) => Promise<void> },
): Promise<ServerJourney | null> {
  if (!rec.serverId) {
    const vehicleId = opts.resolveId(rec.vehicleId);
    let created: ServerJourney;
    try {
      created = await ep.startJourney({
        clientRef: rec.clientRef, startedAt: rec.startedAt, timezone: rec.timezone,
        vehicleId: vehicleId && !vehicleId.startsWith('local:') ? vehicleId : null,
      });
    } catch (err) {
      // The vehicle may have been deleted since: keep the drive without it.
      if (err instanceof ApiError && err.code === 'invalid_vehicle') {
        created = await ep.startJourney({ clientRef: rec.clientRef, startedAt: rec.startedAt, timezone: rec.timezone, vehicleId: null });
      } else {
        throw err;
      }
    }
    rec.serverId = created.id;
    await opts.save(rec);
    if (created.status === 'completed') return created;
  }

  // Points outside the window the API accepts (e.g. after a device clock
  // change) would be rejected every time, so they are skipped.
  const earliest = Date.parse(rec.startedAt) - CLOCK_SKEW_MS;
  while (rec.uploadedCount < rec.points.length) {
    const slice = rec.points.slice(rec.uploadedCount, rec.uploadedCount + BATCH_SIZE);
    const latest = Date.now() + CLOCK_SKEW_MS;
    const batch = slice.filter((p) => { const t = Date.parse(p.recordedAt); return t >= earliest && t <= latest; });
    if (batch.length) {
      const res = await ep.addRoutePoints(rec.serverId!, batch.map(toInput));
      if (res.status !== 'active') {
        // Already completed on the server (e.g. by another attempt).
        rec.uploadedCount = rec.points.length;
        await opts.save(rec);
        return ep.getJourney(rec.serverId!);
      }
    }
    rec.uploadedCount += slice.length;
    await opts.save(rec);
  }

  if (!rec.endedAt) return null;
  const endedAt = new Date(Math.max(Date.parse(rec.endedAt), Date.parse(rec.startedAt))).toISOString();
  return ep.completeJourney(rec.serverId!, {
    endedAt,
    distanceKm: Math.round(rec.clientDistanceKm * 1000) / 1000,
    ...(rec.name ? { name: rec.name } : {}),
    ...(rec.visibility ? { visibility: rec.visibility } : {}),
  });
}

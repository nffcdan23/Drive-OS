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
import { bearingDeg, distanceM, turnDeg } from './geo';
import type { Endpoints, RoutePointInput, ServerJourney } from './endpoints';
import { ApiError } from './http';
import { readJson, userKey, writeJson, type KeyValueStore } from './storage';

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
    speedKmh: fix.speedMs != null && fix.speedMs > 0 ? Math.min(fix.speedMs * 3.6, 350) : 0,
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
}

export function newJourneyRecord(input: {
  clientRef: string; startedAt: Date; timezone: string; vehicleId: string | null; vehicleSnapshot: Record<string, unknown> | null;
}): JourneyRecord {
  return {
    clientRef: input.clientRef, startedAt: input.startedAt.toISOString(), endedAt: null, timezone: input.timezone,
    vehicleId: input.vehicleId, vehicleSnapshot: input.vehicleSnapshot, name: null, points: [], uploadedCount: 0,
    serverId: null, clientDistanceKm: 0, topSpeedKmh: 0, attempts: 0, lastError: null, rejected: false,
  };
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

export class JourneyStore {
  constructor(private readonly store: KeyValueStore, private readonly userId: string) {}
  private get activeKey() { return userKey(this.userId, 'journey/active'); }
  private get pendingKey() { return userKey(this.userId, 'journey/pending'); }

  loadActive() { return readJson<JourneyRecord | null>(this.store, this.activeKey, null); }
  saveActive(rec: JourneyRecord | null) {
    return rec ? writeJson(this.store, this.activeKey, rec) : this.store.removeItem(this.activeKey);
  }
  loadPending() { return readJson<JourneyRecord[]>(this.store, this.pendingKey, []); }
  savePending(list: JourneyRecord[]) { return writeJson(this.store, this.pendingKey, list); }
  async clearAll() {
    await this.store.removeItem(this.activeKey);
    await this.store.removeItem(this.pendingKey);
  }
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
  });
}

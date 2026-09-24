/**
 * Outbox for changes made while offline (or while the server is failing).
 *
 * Edits are applied to the screen immediately and queued here, per user,
 * on the device. The queue is replayed in order whenever the server is
 * reachable. Records created offline get a `local:` id until the server
 * assigns one; later operations on them are rewritten to the server id.
 *
 *   - retryable failures (offline, 5xx, 429) stop the replay and keep the op
 *   - a rejection (4xx) drops the op and is reported to the user, because
 *     retrying a request the server refuses would never succeed
 *   - a signed-out session stops the replay until the user signs in again
 */
import { AuthRequiredError, describeError, isRetryable } from './http';
import { readJson, userKey, writeJson, type KeyValueStore } from './storage';

export type OutboxOp =
  | { kind: 'profile.update'; fields: Record<string, unknown> }
  | { kind: 'settings.update'; fields: Record<string, unknown> }
  | { kind: 'profile.avatar'; uri: string }
  | { kind: 'vehicle.create'; id: string; fields: Record<string, unknown> }
  | { kind: 'vehicle.update'; id: string; fields: Record<string, unknown> }
  | { kind: 'vehicle.delete'; id: string }
  | { kind: 'vehicle.activate'; id: string }
  | { kind: 'vehicle.photo'; id: string; uri: string }
  | { kind: 'location.create'; id: string; fields: Record<string, unknown> }
  | { kind: 'location.update'; id: string; fields: Record<string, unknown> }
  | { kind: 'location.delete'; id: string }
  | { kind: 'journey.update'; id: string; fields: Record<string, unknown> }
  | { kind: 'journey.delete'; id: string }
  | { kind: 'category.create'; id: string; fields: Record<string, unknown> }
  | { kind: 'category.update'; id: string; fields: Record<string, unknown> }
  | { kind: 'category.delete'; id: string };

export interface OutboxEntry { seq: number; op: OutboxOp; attempts: number; lastError: string | null; queuedAt: string }
export interface Rejection { kind: OutboxOp['kind']; message: string; at: string }

export interface OutboxState {
  pending: number;
  lastError: string | null;
  rejected: Rejection[];
  flushing: boolean;
}

/** Performs one op; returns the server id when the op created a record. */
export type OutboxExecutor = (op: OutboxOp) => Promise<string | void>;

export const isLocalId = (id: string | null | undefined): id is string => !!id && id.startsWith('local:');

const entity = (kind: OutboxOp['kind']) => kind.split('.')[0]!;

interface Persisted { seq: number; entries: OutboxEntry[]; idMap: Record<string, string>; rejected: Rejection[] }

export class Outbox {
  private data: Persisted = { seq: 0, entries: [], idMap: {}, rejected: [] };
  private flushing: Promise<void> | null = null;
  private lastError: string | null = null;
  private listeners = new Set<(s: OutboxState) => void>();

  constructor(private readonly store: KeyValueStore, private readonly userId: string, private readonly execute: OutboxExecutor) {}

  private get key() { return userKey(this.userId, 'outbox/v1'); }

  async load(): Promise<void> {
    this.data = await readJson<Persisted>(this.store, this.key, this.data);
    this.emit();
  }

  subscribe(fn: (s: OutboxState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  get state(): OutboxState {
    return { pending: this.data.entries.length, lastError: this.lastError, rejected: this.data.rejected, flushing: !!this.flushing };
  }

  /** The server id for a local id once known (otherwise the id itself). */
  resolve(id: string): string;
  resolve(id: string | null): string | null;
  resolve(id: string | null): string | null {
    if (!id) return id;
    return this.data.idMap[id] ?? id;
  }

  /** Server id → local id, so screens can keep using the id they know. */
  localIdFor(serverId: string): string | null {
    for (const [local, server] of Object.entries(this.data.idMap)) if (server === serverId) return local;
    return null;
  }

  /** Queued ops, oldest first (read-only view). */
  get queued(): readonly OutboxOp[] {
    return this.data.entries.map((e) => e.op);
  }

  hasPendingFor(id: string): boolean {
    return this.data.entries.some((e) => 'id' in e.op && e.op.id === id);
  }

  async enqueue(op: OutboxOp): Promise<void> {
    const entries = this.data.entries;
    const id = 'id' in op ? op.id : null;
    const kind = entity(op.kind);
    const action = op.kind.split('.')[1];

    // Coalesce with what's already queued for the same record.
    if (id && action === 'delete') {
      const created = entries.find((e) => e.op.kind === `${kind}.create` && 'id' in e.op && e.op.id === id);
      // Remove queued edits of this record; if it never reached the server, nothing to delete.
      this.data.entries = entries.filter((e) => !(entity(e.op.kind) === kind && 'id' in e.op && e.op.id === id));
      if (created) { await this.persist(); return; }
    } else if (id && action === 'update' && 'fields' in op) {
      const target = entries.find((e) =>
        (e.op.kind === `${kind}.create` || e.op.kind === `${kind}.update`) && 'id' in e.op && e.op.id === id);
      if (target && 'fields' in target.op) {
        target.op.fields = { ...target.op.fields, ...op.fields };
        await this.persist();
        return;
      }
    } else if (op.kind === 'profile.update' || op.kind === 'settings.update') {
      const target = entries.find((e) => e.op.kind === op.kind);
      if (target && 'fields' in target.op) {
        target.op.fields = { ...target.op.fields, ...op.fields };
        await this.persist();
        return;
      }
    } else if (op.kind === 'vehicle.activate') {
      this.data.entries = entries.filter((e) => e.op.kind !== 'vehicle.activate');
    }

    this.data.entries.push({ seq: ++this.data.seq, op, attempts: 0, lastError: null, queuedAt: new Date().toISOString() });
    await this.persist();
  }

  /** Replays the queue. Safe to call often; concurrent calls share one run. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.run().finally(() => { this.flushing = null; this.emit(); });
      this.emit();
    }
    return this.flushing;
  }

  private async run(): Promise<void> {
    while (this.data.entries.length) {
      const entry = this.data.entries[0]!;
      const op = this.rewrite(entry.op);
      if ('id' in op && isLocalId(op.id) && !op.kind.endsWith('.create')) {
        // Its create was rejected, so this can never apply.
        this.data.entries.shift();
        await this.persist();
        continue;
      }
      try {
        const serverId = await this.execute(op);
        if (serverId && 'id' in entry.op && isLocalId(entry.op.id)) this.data.idMap[entry.op.id] = serverId;
        this.data.entries.shift();
        this.lastError = null;
        await this.persist();
      } catch (err) {
        if (err instanceof AuthRequiredError || isRetryable(err)) {
          entry.attempts++;
          entry.lastError = describeError(err);
          this.lastError = entry.lastError;
          await this.persist();
          return;
        }
        this.data.entries.shift();
        this.data.rejected = [{ kind: entry.op.kind, message: describeError(err), at: new Date().toISOString() }, ...this.data.rejected].slice(0, 20);
        await this.persist();
      }
    }
  }

  /** Swaps local ids for server ids where the create has completed. */
  private rewrite(op: OutboxOp): OutboxOp {
    if ('id' in op && op.kind.endsWith('.create')) return op;
    if ('id' in op) return { ...op, id: this.resolve(op.id) } as OutboxOp;
    return op;
  }

  async dismissRejections(): Promise<void> {
    this.data.rejected = [];
    await this.persist();
  }

  async clear(): Promise<void> {
    this.data = { seq: 0, entries: [], idMap: {}, rejected: [] };
    await this.store.removeItem(this.key);
    this.emit();
  }

  private async persist(): Promise<void> {
    await writeJson(this.store, this.key, this.data);
    this.emit();
  }

  private emit() {
    const s = this.state;
    for (const fn of this.listeners) fn(s);
  }
}

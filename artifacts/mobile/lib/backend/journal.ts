/**
 * The on-device diagnostics journal: a short, timestamped record of what the
 * app decided about drives, so a crash or a lost drive can be traced
 * afterwards.  It records only lifecycle facts:
 *
 *  - launches (in the foreground, or in the background by iOS);
 *  - background location updates starting and stopping;
 *  - the drive in progress (its clientRef and server id);
 *  - recovery decisions after a relaunch, and CloudSync start-up;
 *  - storage reads and writes that failed;
 *  - the last fatal JavaScript error.
 *
 * Never where the phone was: entries carry no coordinates, routes or points
 * (fields with those names are dropped).  Kept on the device only, newest
 * JOURNAL_MAX_ENTRIES entries; nothing is sent anywhere unless the user
 * shares it.
 *
 * No React Native imports, so it is unit-tested under node.
 */
import type { KeyValueStore } from './storage';

export const JOURNAL_KEY = '@driveos/diagnostics/journal';
export const JOURNAL_MAX_ENTRIES = 400;

export type JournalValue = string | number | boolean | null;
export interface JournalEntry {
  /** When it happened (ISO time) */
  t: string;
  event: string;
  [field: string]: JournalValue;
}

/** What the recorders need: a call that never throws */
export interface Journal {
  log(event: string, data?: Record<string, JournalValue | undefined>): void;
}

export const noJournal: Journal = { log() {} };

/** Field names that could carry a location: never written */
const LOCATION_FIELD = /^(lat|lng|lon|latitude|longitude|coords?|coordinates?|points?|route|polyline|position|location)$/i;
const MAX_TEXT = 300;

export class DiagnosticsJournal implements Journal {
  private entries: JournalEntry[] = [];
  private loaded: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private dirty = false;

  constructor(private readonly deps: { store: KeyValueStore; now?: () => number; max?: number }) {}

  private get max() { return this.deps.max ?? JOURNAL_MAX_ENTRIES; }

  log(event: string, data: Record<string, JournalValue | undefined> = {}): void {
    try {
      const entry: JournalEntry = { t: new Date(this.deps.now ? this.deps.now() : Date.now()).toISOString(), event };
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined || LOCATION_FIELD.test(k) || k === 't' || k === 'event') continue;
        if (typeof v === 'string') entry[k] = v.slice(0, MAX_TEXT);
        else if (typeof v === 'number') entry[k] = Number.isFinite(v) ? v : null;
        else entry[k] = v;
      }
      this.entries.push(entry);
      if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
      this.persist();
    } catch {
      // The journal must never be the thing that fails.
    }
  }

  /** The journal so far, oldest first (what was saved earlier included) */
  async read(): Promise<JournalEntry[]> {
    await this.load();
    return [...this.entries];
  }

  /** Waits for pending writes (tests, and before sharing) */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  /**
   * Empties the journal, on the device too, and starts it again with a note
   * of when it was cleared.
   */
  async clear(): Promise<void> {
    await this.load();
    this.entries = [];
    // A write already under way finishes first, so it can't bring entries back
    await this.flush();
    try {
      await this.deps.store.removeItem(JOURNAL_KEY);
    } catch {
      // Left on the device; the next write replaces it with the emptied journal.
    }
    this.log('journal_cleared');
    await this.flush();
  }

  /** Plain text, one entry per line, for sharing from Settings */
  async text(): Promise<string> {
    const lines = (await this.read()).map(({ t, event, ...rest }) => {
      const fields = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
      return [t, event, ...fields].join(' ');
    });
    return lines.join('\n');
  }

  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const raw = await this.deps.store.getItem(JOURNAL_KEY);
          const saved = raw ? (JSON.parse(raw) as unknown) : [];
          if (Array.isArray(saved)) {
            const valid = saved.filter((e): e is JournalEntry => !!e && typeof e === 'object' && typeof e.t === 'string' && typeof e.event === 'string');
            this.entries = [...valid, ...this.entries].slice(-this.max);
          }
        } catch {
          // Unreadable: start again from what's in memory.
        }
      })();
    }
    return this.loaded;
  }

  private persist() {
    this.dirty = true;
    if (this.flushing) return;
    this.flushing = (async () => {
      await this.load();
      while (this.dirty) {
        this.dirty = false;
        try {
          await this.deps.store.setItem(JOURNAL_KEY, JSON.stringify(this.entries));
        } catch {
          // Can't save it now; the next entry tries again.
        }
      }
    })().finally(() => { this.flushing = null; });
  }
}

/** A fatal JavaScript error as it is saved for the journal (small: written synchronously as the app dies) */
export function fatalErrorRecord(error: unknown, at: number, appState: string | null): Record<string, string> {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    crashedAt: new Date(at).toISOString(),
    message: `${e.name}: ${e.message}`.slice(0, 500),
    stack: (e.stack ?? '').slice(0, 1200),
    appState: appState ?? 'unknown',
  };
}

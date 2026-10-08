/**
 * The diagnostics report shared from Settings → Help & Support →
 * Diagnostics: the app's version and build, when it was made, a short summary
 * of drive state, the orphan journeys the last check reported, and the
 * diagnostics journal (lib/backend/journal).
 *
 * Never in it: locations, routes, coordinates, passwords, tokens, keys or
 * email addresses.  The journal never records them in the first place; the
 * report drops any field with such a name again, and scrubs the finished text
 * of anything that looks like one (a JWT, a bearer token, a key, a
 * `password=`, an email address, a number with the precision of a
 * coordinate), in case one ever slipped into an error message.
 *
 * No React Native imports, so it is unit-tested under node.
 */
import type { JournalEntry, JournalValue } from './journal';

export interface DiagnosticsApp {
  name: string;
  version: string | null;
  build: string | null;
  bundleId: string | null;
  platform: string;
  osVersion: string | null;
}

/** A server journey still active with no drive on the phone (from CloudSync's orphan check; report only) */
export interface DiagnosticsOrphan {
  serverId: string;
  clientRef: string | null;
  name: string;
  startedAt: string;
  firstPointAt: string | null;
  lastPointAt: string | null;
  pointCount: number;
  spanS: number;
  quietH: number;
  outcome: string;
}

export interface DiagnosticsState {
  /** The drive in progress (its clientRef), if any */
  driveInProgress: string | null;
  pendingDrives: number;
  /** A saved drive that couldn't be read or saved yet (being retried) */
  unsettled: boolean;
  /** The last orphan check this session; null if none has run */
  orphans: readonly DiagnosticsOrphan[] | null;
}

/** Field names that could carry a location or sign-in data: never in the report */
const SENSITIVE_FIELD =
  /^(lat|lng|lon|latitude|longitude|coords?|coordinates?|points?|route|polyline|position|location|password|passwd|pwd|token|access_?token|refresh_?token|secret|api_?key|authorization|auth|session|email|user_?id|phone)$/i;

/** Removes anything that looks like a secret, an email address or a coordinate from report text */
export function redactDiagnostics(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]')
    .replace(/\b(sb_(?:secret|publishable)_|sk\.|pk\.)[A-Za-z0-9._-]{8,}/g, '[key]')
    .replace(
      /\b(password|passwd|pwd|token|access_token|refresh_token|secret|api[_-]?key|apikey|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      '$1$2[redacted]',
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    // Five or more decimal places is coordinate precision (timestamps and stats have fewer)
    .replace(/-?\b\d{1,3}\.\d{5,}\b/g, '[number]');
}

function field(k: string, v: JournalValue): string {
  return `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`;
}

export function entryLine(e: JournalEntry): string {
  const { t, event, ...rest } = e;
  const fields = Object.entries(rest).filter(([k]) => !SENSITIVE_FIELD.test(k)).map(([k, v]) => field(k, v));
  return [t, event, ...fields].join(' ');
}

export function buildDiagnosticsReport(input: {
  app: DiagnosticsApp;
  generatedAt: Date;
  state: DiagnosticsState;
  entries: readonly JournalEntry[];
}): string {
  const { app, state, entries } = input;
  const lines: string[] = [];
  lines.push(`${app.name} diagnostics`);
  lines.push(`Generated: ${input.generatedAt.toISOString()}`);
  lines.push(`App: ${app.name} ${app.version ?? '?'} (build ${app.build ?? '?'})${app.bundleId ? ` ${app.bundleId}` : ''}`);
  lines.push(`Device: ${app.platform}${app.osVersion ? ` ${app.osVersion}` : ''}`);
  lines.push('Contains no locations, routes or sign-in details.');
  lines.push('');
  lines.push('Drive state');
  lines.push(`  Drive in progress: ${state.driveInProgress ?? 'none'}`);
  lines.push(`  Drives waiting to upload: ${state.pendingDrives}`);
  lines.push(`  Saved drive unreadable/unsaved (retrying): ${state.unsettled ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('Orphan journeys (server journeys still active with no drive on this phone; report only)');
  if (!state.orphans) lines.push('  Not checked yet this session (checked when the app syncs online).');
  else if (!state.orphans.length) lines.push('  None found.');
  else {
    for (const o of state.orphans) {
      lines.push(
        `  ${o.outcome} serverId=${o.serverId} clientRef=${o.clientRef ?? '-'} name=${JSON.stringify(o.name)} started=${o.startedAt}`
        + ` firstPoint=${o.firstPointAt ?? '-'} lastPoint=${o.lastPointAt ?? '-'} points=${o.pointCount} spanS=${o.spanS} quietH=${o.quietH}`,
      );
    }
  }
  lines.push('');
  lines.push(`Journal (${entries.length} entries, oldest first)`);
  if (!entries.length) lines.push('  (empty)');
  for (const e of entries) lines.push(entryLine(e));
  return redactDiagnostics(lines.join('\n'));
}

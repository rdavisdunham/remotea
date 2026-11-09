/**
 * What the collector has delivered (collector.py's state.json), under the
 * server's config dir. The rule that matters (C14): a source's fingerprint is
 * recorded only once Eridani acknowledged the report that carried it. A
 * report that was enqueued but evicted, refused or lost in a crash leaves the
 * source unrecorded, so the next scan sends it again.
 */
import fs from 'fs';
import path from 'path';
import type { Terminals } from './report';
import type { CollectorMode } from '../config';

export const COLLECTOR_STATE_FILE = 'eridani-collector.json';
/** Delivered fingerprints per mode: a parity ack says nothing about what Eridani stored. */
export const COLLECTOR_STATE_FILES: Record<Exclude<CollectorMode, 'off'>, string> = {
  parity: COLLECTOR_STATE_FILE,
  authoritative: 'eridani-collector-authoritative.json',
};

export interface SourceRecord {
  version: unknown;
  fingerprint: string;
  settled: boolean;
  last_active: string | null;
  /** `${tool}:${session_id}`: the link entity this source reports as. */
  entity?: string;
}

export interface CollectorStateData {
  sessions: Record<string, SourceRecord>;
  remotea: Terminals;
}

export class CollectorState {
  data: CollectorStateData;
  /** Reports enqueued but not yet acknowledged, by entity. */
  private readonly pending = new Map<string, { source: string; record: SourceRecord }>();

  constructor(private readonly file: string | null) {
    this.data = { sessions: {}, remotea: { installed: false, live: {}, groups: {} } };
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CollectorStateData>;
      if (raw && typeof raw === 'object') {
        this.data.sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
        if (raw.remotea && typeof raw.remotea === 'object') this.data.remotea = { ...this.data.remotea, ...raw.remotea };
      }
    } catch {
      /* first run, or unreadable: start over (everything is re-sent once) */
    }
  }

  /**
   * Adds the session → workspace map from another mode's state file (each mode keeps its own), so every session
   * ever seen in a remotea terminal still counts as one after a mode switch. Entries already here win.
   */
  rememberTerminalsFrom(file: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CollectorStateData>;
      const groups = raw?.remotea?.groups;
      if (groups && typeof groups === 'object') this.data.remotea.groups = { ...groups, ...this.data.remotea.groups };
    } catch {
      /* no other file */
    }
  }

  get(source: string): SourceRecord | undefined {
    return this.data.sessions[source];
  }

  pendingFingerprint(entity: string): string | undefined {
    return this.pending.get(entity)?.record.fingerprint;
  }

  /** A report is on its way; it counts once `delivered` is called for the same revision. */
  expect(entity: string, source: string, record: SourceRecord): void {
    this.pending.set(entity, { source, record: { ...record, entity } });
  }

  /** Eridani acknowledged the report for `entity` at `revision`. Returns true when it advanced the state. */
  delivered(entity: string, revision: string): boolean {
    const p = this.pending.get(entity);
    if (!p || p.record.fingerprint !== revision) return false;
    this.pending.delete(entity);
    this.data.sessions[p.source] = p.record;
    this.save();
    return true;
  }

  /** The report for `entity` will not arrive (evicted, refused): forget it so the next scan resends. */
  dirty(entity: string): void {
    this.pending.delete(entity);
    let changed = false;
    for (const [source, rec] of Object.entries(this.data.sessions)) {
      if (rec.entity === entity) {
        delete this.data.sessions[source];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

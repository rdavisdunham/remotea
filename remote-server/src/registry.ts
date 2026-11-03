/**
 * The session registry — the server-side source of truth every device syncs
 * against: which sessions exist, which workspace group each belongs to,
 * which devices hid them, and what was closed (tombstones).
 *
 * Layout is deliberately NOT here. Splits, windows and monitors are each
 * device's own business; the registry only answers "what exists" and "where
 * does it belong", so a laptop and a multi-monitor desktop can arrange the
 * same sessions differently.
 *
 * Tombstones are what make "closed elsewhere" distinguishable from "lost in a
 * server restart": a session the registry still lists (state `lost`) comes
 * back; a tombstoned one never does, not even when a slow client tries to
 * re-create it.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  INBOX_GROUP_ID,
  type DeviceId,
  type GroupId,
  type GroupRecord,
  type LostInfo,
  type RemoteSurfaceId,
  type SessionRecord,
  type Tombstone,
} from '../../src/shared/remote-host-protocol';

export interface RegistryData {
  v: 1;
  epoch: string;
  groups: Record<string, GroupRecord>;
  sessions: Record<string, SessionRecord>;
  tombstones: Record<string, Tombstone>;
  devices: Record<string, { name: string; lastSeen: number }>;
}

export interface RegistryOptions {
  file: string | null;
  bootId: string;
  now?: () => number;
  /** Exited sessions nobody closed are dropped after this long. */
  exitedRetentionMs?: number;
  tombstoneRetentionMs?: number;
  saveDebounceMs?: number;
}

const DAY = 24 * 60 * 60 * 1000;

const sKey = (id: string) => `s:${id}`;
const gKey = (id: string) => `g:${id}`;

export function emptyRegistry(): RegistryData {
  return { v: 1, epoch: crypto.randomUUID(), groups: {}, sessions: {}, tombstones: {}, devices: {} };
}

export class Registry {
  readonly data: RegistryData;
  private readonly now: () => number;
  private saveTimer: NodeJS.Timeout | null = null;

  private constructor(data: RegistryData, private readonly opts: RegistryOptions) {
    this.data = data;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Load (or create) the registry for a fresh server boot. Every session the
   * previous boot left `live` lost its process with that boot: it becomes
   * `lost`, keeping cwd/title/agent so a client can respawn and resume it.
   */
  static load(opts: RegistryOptions): Registry {
    let data: RegistryData | null = null;
    if (opts.file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(opts.file, 'utf8')) as RegistryData;
        if (parsed && parsed.v === 1 && typeof parsed.epoch === 'string') data = parsed;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && opts.file) {
          // Keep the unreadable file for inspection rather than overwriting it.
          try {
            fs.renameSync(opts.file, `${opts.file}.corrupt-${Date.now()}`);
          } catch {
            /* ignore */
          }
        }
      }
    }
    const reg = new Registry(data ?? emptyRegistry(), opts);
    for (const s of Object.values(reg.data.sessions)) {
      s.hiddenBy ??= [];
      if (s.state === 'live' && s.bootId !== opts.bootId) s.state = 'lost';
    }
    reg.prune();
    reg.saveSoon();
    return reg;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  get epoch(): string {
    return this.data.epoch;
  }

  session(id: string): SessionRecord | undefined {
    return this.data.sessions[id];
  }

  group(id: string): GroupRecord | undefined {
    return this.data.groups[id];
  }

  sessions(): SessionRecord[] {
    return Object.values(this.data.sessions);
  }

  groups(): GroupRecord[] {
    return Object.values(this.data.groups);
  }

  sessionTombstone(id: string): Tombstone | undefined {
    return this.data.tombstones[sKey(id)];
  }

  groupTombstone(id: string): Tombstone | undefined {
    return this.data.tombstones[gKey(id)];
  }

  lostInfo(id: string): LostInfo | undefined {
    const s = this.data.sessions[id];
    if (!s) return undefined;
    return { cwd: s.lastCwd ?? s.cwd, title: s.title, cmd: s.cmd, agent: s.agent };
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  touchDevice(id: DeviceId, name: string): void {
    this.data.devices[id] = { name, lastSeen: this.now() };
    this.saveSoon();
  }

  deviceName(id: DeviceId): string {
    return this.data.devices[id]?.name ?? id;
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  /**
   * Create or update a group. Returns the record and whether anything changed
   * (so the caller only broadcasts real changes). A tombstoned group is not
   * resurrected: returns null and the caller falls back to the inbox.
   */
  upsertGroup(id: GroupId, meta: { name: string; color?: string }, by: DeviceId): { group: GroupRecord; changed: boolean } | null {
    if (this.groupTombstone(id)) return null;
    const now = this.now();
    const existing = this.data.groups[id];
    if (!existing) {
      const group: GroupRecord = { id, name: meta.name, color: meta.color, createdBy: by, createdAt: now, updatedAt: now };
      this.data.groups[id] = group;
      this.saveSoon();
      return { group, changed: true };
    }
    const changed = existing.name !== meta.name || (existing.color ?? undefined) !== (meta.color ?? undefined);
    if (changed) {
      existing.name = meta.name;
      existing.color = meta.color;
      existing.updatedAt = now;
      this.saveSoon();
    }
    return { group: existing, changed };
  }

  /** The group a new or moved session should land in: its own, else the inbox. */
  resolveGroup(id: GroupId | null | undefined, meta: { name: string; color?: string } | undefined, by: DeviceId): { groupId: GroupId; created?: GroupRecord } {
    if (id && id !== INBOX_GROUP_ID) {
      const res = this.upsertGroup(id, meta ?? { name: this.data.groups[id]?.name ?? 'Workspace' }, by);
      if (res) return { groupId: id, created: res.changed ? res.group : undefined };
    }
    const inbox = this.upsertGroup(INBOX_GROUP_ID, { name: this.data.groups[INBOX_GROUP_ID]?.name ?? 'Inbox' }, by)!;
    return { groupId: INBOX_GROUP_ID, created: inbox.changed ? inbox.group : undefined };
  }

  /**
   * Close a group: tombstone it and every session in it — including sessions
   * some device had hidden, since closing a workspace means closing its work.
   * Returns the ids of the sessions that were removed.
   */
  closeGroup(id: GroupId, by: DeviceId): RemoteSurfaceId[] {
    const now = this.now();
    const removed: RemoteSurfaceId[] = [];
    for (const s of Object.values(this.data.sessions)) {
      if (s.groupId !== id) continue;
      delete this.data.sessions[s.id];
      this.data.tombstones[sKey(s.id)] = { kind: 'session', at: now, by, reason: 'group-closed' };
      removed.push(s.id);
    }
    if (id !== INBOX_GROUP_ID) {
      delete this.data.groups[id];
      this.data.tombstones[gKey(id)] = { kind: 'group', at: now, by, reason: 'closed' };
    }
    this.saveSoon();
    return removed;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  addSession(rec: SessionRecord): void {
    this.data.sessions[rec.id] = rec;
    this.saveSoon();
  }

  /** Apply a patch; returns the updated record, or undefined for an unknown id. */
  updateSession(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const s = this.data.sessions[id];
    if (!s) return undefined;
    Object.assign(s, patch);
    this.saveSoon();
    return s;
  }

  /**
   * Close a session everywhere. Idempotent: an unknown or already-closed id
   * still gets (or keeps) its tombstone, so a create racing this close cannot
   * bring it back. Returns the record that was removed, if there was one.
   */
  closeSession(id: RemoteSurfaceId, by: DeviceId, reason: Tombstone['reason'] = 'closed'): SessionRecord | undefined {
    const s = this.data.sessions[id];
    delete this.data.sessions[id];
    if (!this.data.tombstones[sKey(id)]) {
      this.data.tombstones[sKey(id)] = { kind: 'session', at: this.now(), by, reason };
    }
    this.saveSoon();
    return s;
  }

  setHidden(id: string, device: DeviceId, hidden: boolean): SessionRecord | undefined {
    const s = this.data.sessions[id];
    if (!s) return undefined;
    const has = s.hiddenBy.includes(device);
    if (hidden && !has) s.hiddenBy.push(device);
    else if (!hidden && has) s.hiddenBy = s.hiddenBy.filter((d) => d !== device);
    else return s;
    this.saveSoon();
    return s;
  }

  // ── Maintenance & persistence ────────────────────────────────────────────

  /** Drop long-exited sessions and old tombstones. Returns the session ids dropped. */
  prune(): RemoteSurfaceId[] {
    const now = this.now();
    const exitedTtl = this.opts.exitedRetentionMs ?? 7 * DAY;
    const tombTtl = this.opts.tombstoneRetentionMs ?? 30 * DAY;
    const dropped: RemoteSurfaceId[] = [];
    for (const s of Object.values(this.data.sessions)) {
      if (s.state === 'exited' && s.exitedAt && now - s.exitedAt > exitedTtl && (!s.chatReminder || (!!s.chatReminder.firedAt && s.chatAttention?.seenBy[s.chatReminder.createdBy] === s.chatAttention?.revision))) {
        this.closeSession(s.id, 'server', 'closed');
        dropped.push(s.id);
      }
    }
    for (const [key, t] of Object.entries(this.data.tombstones)) {
      if (now - t.at > tombTtl) delete this.data.tombstones[key];
    }
    if (dropped.length) this.saveSoon();
    return dropped;
  }

  saveSoon(): void {
    if (!this.opts.file) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, this.opts.saveDebounceMs ?? 250);
    this.saveTimer.unref?.();
  }

  /** Atomic write: temp file + rename, so a crash mid-write never truncates the registry. */
  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const file = this.opts.file;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

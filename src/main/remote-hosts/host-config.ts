/**
 * Remote hosts, this device's identity, and actions queued while offline —
 * each in its own file under the app data dir.
 *
 * Hosts live in `remote-hosts.json`, not settings.json: settings flow to the
 * renderer, and a host's token must not. The token is encrypted with
 * Electron's `safeStorage` (DPAPI on Windows) and only decrypted in main at
 * connect time. The token gives a shell on the remote machine, so it is
 * treated like an SSH private key.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { hostIdFromName, HOST_ID_RE } from '../../shared/remote-shell-spec';
import { DEVICE_ID_RE, GROUP_ID_RE, SURFACE_ID_RE } from '../../shared/remote-host-protocol';
import { classifyHostUrl, UNENCRYPTED_ACK_LABEL } from '../../shared/host-url';
import type { HostSaveRequest, OutboxSummary } from '../../shared/remote-hosts-types';

export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

export interface StoredHost {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** base64 of safeStorage.encryptString(token). */
  tokenEnc?: string;
  /** Pinned on first successful connect; a different server at this URL fails closed. */
  serverId?: string;
  /** The user chose "Don't ask again" on the agent-hooks prompt for this host. */
  hooksPromptDeclined?: boolean;
  /** The plain ws:// URL the user acknowledged as unencrypted on its network (see shared/host-url). */
  unencryptedAckUrl?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function validateHostUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('Not a valid URL (expected ws://host:7717)');
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('URL must start with ws:// or wss://');
  if (!u.hostname) throw new Error('URL needs a host');
  if (u.username || u.password) throw new Error('Put the token in the token field, not the URL');
  return u.toString().replace(/\/$/, '');
}

/**
 * A plain ws:// URL to anything but this computer or a Tailscale address
 * carries the token and every keystroke unencrypted across that network: it
 * is used only once the user acknowledged exactly that (`acknowledged`, or an
 * earlier acknowledgement of this same URL, `ackedUrl`). Loopback, Tailscale
 * and wss:// pass without one. `url` is already validated.
 */
export function assertHostUrlAcknowledged(url: string, acknowledged: boolean | undefined, ackedUrl?: string): void {
  const c = classifyHostUrl(url);
  if (!c?.needsAck || acknowledged || ackedUrl === url) return;
  throw new Error(`ws:// to ${c.host} is unencrypted on this network. Use the host's Tailscale address (100.x or *.ts.net) or wss://, or confirm "${UNENCRYPTED_ACK_LABEL}".`);
}

export class HostStore {
  private hosts: StoredHost[];

  constructor(private readonly file: string, private readonly box: SecretBox) {
    const raw = readJson<{ hosts?: StoredHost[] }>(file);
    this.hosts = (raw?.hosts ?? []).filter((h) => HOST_ID_RE.test(h.id) && typeof h.url === 'string');
  }

  list(): StoredHost[] {
    return this.hosts.map((h) => ({ ...h }));
  }

  get(id: string): StoredHost | undefined {
    const h = this.hosts.find((x) => x.id === id);
    return h ? { ...h } : undefined;
  }

  token(id: string): string | null {
    const h = this.hosts.find((x) => x.id === id);
    if (!h?.tokenEnc) return null;
    try {
      return this.box.decryptString(Buffer.from(h.tokenEnc, 'base64'));
    } catch {
      return null;
    }
  }

  /** Create or update a host. Returns the stored record and whether the connection details changed. */
  save(req: HostSaveRequest): { host: StoredHost; reconnect: boolean } {
    const name = req.name.trim().slice(0, 80) || 'Remote';
    const url = validateHostUrl(req.url);
    let host = req.id ? this.hosts.find((h) => h.id === req.id) : undefined;
    assertHostUrlAcknowledged(url, req.acknowledgeUnencrypted, host?.unencryptedAckUrl);
    let reconnect = false;
    if (!host) {
      host = { id: hostIdFromName(name, new Set(this.hosts.map((h) => h.id))), name, url, enabled: req.enabled ?? true };
      this.hosts.push(host);
      reconnect = true;
    } else {
      if (host.url !== url) {
        // A new address may be a new server: drop the pin and learn it again.
        host.url = url;
        delete host.serverId;
        reconnect = true;
      }
      host.name = name;
      if (req.enabled !== undefined && req.enabled !== host.enabled) {
        host.enabled = req.enabled;
        reconnect = true;
      }
    }
    // Remember the acknowledgement for this exact URL (editing the name later does not ask again); any other URL drops it.
    if (classifyHostUrl(url)?.needsAck) host.unencryptedAckUrl = url;
    else delete host.unencryptedAckUrl;
    if (req.token !== undefined) {
      const token = req.token.trim();
      if (!token) {
        delete host.tokenEnc;
      } else {
        if (!this.box.isEncryptionAvailable()) throw new Error('Secure storage is not available on this machine');
        host.tokenEnc = this.box.encryptString(token).toString('base64');
      }
      reconnect = true;
    }
    this.persist();
    return { host: { ...host }, reconnect };
  }

  pinServer(id: string, serverId: string): void {
    const h = this.hosts.find((x) => x.id === id);
    if (!h || h.serverId === serverId) return;
    h.serverId = serverId;
    this.persist();
  }

  declineHooksPrompt(id: string): void {
    const h = this.hosts.find((x) => x.id === id);
    if (!h || h.hooksPromptDeclined) return;
    h.hooksPromptDeclined = true;
    this.persist();
  }

  remove(id: string): boolean {
    const before = this.hosts.length;
    this.hosts = this.hosts.filter((h) => h.id !== id);
    if (this.hosts.length === before) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    writeJsonAtomic(this.file, { v: 1, hosts: this.hosts });
  }
}

/** This app install's identity on every server. Survives updates and session resets. */
export function loadDevice(file: string): { id: string; name: string } {
  const raw = readJson<{ id?: string; name?: string }>(file);
  if (raw?.id && DEVICE_ID_RE.test(raw.id)) return { id: raw.id, name: raw.name || os.hostname() };
  const device = { id: `dev-${crypto.randomBytes(8).toString('hex')}`, name: os.hostname() };
  writeJsonAtomic(file, device);
  return device;
}

export type PendingIntent =
  | { t: 'close'; id: string }
  | { t: 'groupClose'; id: string }
  | { t: 'hide'; id: string }
  | { t: 'unhide'; id: string }
  | { t: 'sessionUpdate'; id: string; groupId?: string | null; group?: { name: string; color?: string }; title?: string | null }
  | { t: 'groupUpsert'; id: string; name: string; color?: string };

type SessionUpdateIntent = Extract<PendingIntent, { t: 'sessionUpdate' }>;

function validIntent(i: unknown): i is PendingIntent {
  if (!i || typeof i !== 'object') return false;
  const x = i as { t?: unknown; id?: unknown; name?: unknown };
  if (typeof x.id !== 'string') return false;
  switch (x.t) {
    case 'groupClose': return GROUP_ID_RE.test(x.id);
    case 'groupUpsert': return GROUP_ID_RE.test(x.id) && typeof x.name === 'string';
    case 'close':
    case 'hide':
    case 'unhide':
    case 'sessionUpdate': return SURFACE_ID_RE.test(x.id);
    default: return false;
  }
}

/**
 * Where an intent stands. Only `pending` is ever sent. `uncertain` is not
 * terminal either: it was sent and the host did not answer within the request
 * deadline while the connection stayed up, so it may or may not have been
 * applied. It is never resent blind: the registry mirror (any broadcast) or
 * the next welcome snapshot settles it first, and only an intent that
 * snapshot shows unapplied goes back to `pending`. The others are terminal
 * and kept a while so the UI can say what happened:
 *   failed     the server refused it (ack ok:false), or it was sent too many
 *              times without ever being acknowledged;
 *   expired    still unapplied after INTENT_TTL_MS;
 *   superseded a newer intent about the same target replaced it before it
 *              was confirmed (the newer one carries everything still wanted).
 * An applied intent is not a state: its entry is removed.
 */
export type IntentState = 'pending' | 'uncertain' | 'failed' | 'expired' | 'superseded';

/** Not settled yet: still wanted, laid over the registry, and open to being superseded by a newer intent. */
function isOpen(e: { state: IntentState }): boolean {
  return e.state === 'pending' || e.state === 'uncertain';
}

export interface OutboxEntry {
  /** Stable id: survives restarts and resends. */
  iid: string;
  /** Monotonic per outbox file: a later intent wins over an earlier one about the same target. */
  seq: number;
  intent: PendingIntent;
  state: IntentState;
  createdAt: number;
  /** How many times it was written to a connected socket. */
  attempts: number;
  lastSentAt?: number;
  /** When its ack deadline passed with the connection still up (state `uncertain`). */
  uncertainAt?: number;
  /** When it reached a terminal state. */
  doneAt?: number;
  error?: string;
  /** iid of the newer intent that replaced this one. */
  supersededBy?: string;
}

/** Unapplied intents older than this are given up on (and reported), not replayed. */
export const INTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sent this many times and never acknowledged: something about it breaks the connection. */
export const INTENT_MAX_ATTEMPTS = 10;
/** Terminal entries are kept this long, and at most this many per host, for the UI. */
const DONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_KEEP_MAX = 50;
const OUTBOX_VERSION = 2;

/** The target an intent is about: a newer intent with the same key supersedes an older one. */
export function intentKey(i: PendingIntent): string {
  switch (i.t) {
    case 'close': return `s:${i.id}:close`;
    case 'hide':
    case 'unhide': return `s:${i.id}:vis`;
    case 'sessionUpdate': return `s:${i.id}:meta`;
    case 'groupClose': return `g:${i.id}:close`;
    case 'groupUpsert': return `g:${i.id}:meta`;
  }
}

/**
 * Last writer wins per FIELD for session metadata: a rename queued after a
 * move keeps the move. `newer`'s fields override `older`'s.
 */
function mergeSessionUpdate(older: SessionUpdateIntent, newer: SessionUpdateIntent): SessionUpdateIntent {
  const out: SessionUpdateIntent = { t: 'sessionUpdate', id: newer.id };
  const groupFrom = newer.groupId !== undefined ? newer : older;
  if (groupFrom.groupId !== undefined) {
    out.groupId = groupFrom.groupId;
    if (groupFrom.group) out.group = groupFrom.group;
  }
  const title = newer.title !== undefined ? newer.title : older.title;
  if (title !== undefined) out.title = title;
  return out;
}

interface OutboxFile {
  v: number;
  seq: number;
  hosts: Record<string, OutboxEntry[]>;
}

function validEntry(e: unknown): e is OutboxEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Partial<OutboxEntry>;
  return typeof x.iid === 'string' && Number.isSafeInteger(x.seq) && validIntent(x.intent)
    && (x.state === 'pending' || x.state === 'uncertain' || x.state === 'failed' || x.state === 'expired' || x.state === 'superseded')
    && typeof x.createdAt === 'number' && Number.isSafeInteger(x.attempts);
}

/**
 * The durable outbox of registry changes this device made (close, hide,
 * rename, move, group edits). Replayed right after a welcome and BEFORE
 * reconciling, so a tab closed on the train is closed on the server, not
 * re-placed from the registry when the laptop reconnects.
 *
 * An entry is on disk before it is sent (connected or not), and is removed
 * only when the server acknowledges it, or when a welcome snapshot already
 * shows its effect (applied, but the ack was lost with the connection).
 * Until then every reconnect resends it. Every server operation it maps to is
 * idempotent, so a resend after an unseen application changes nothing.
 *
 * File: `{ v: 2, seq, hosts: { [hostId]: OutboxEntry[] } }`. The first
 * format, `{ [hostId]: PendingIntent[] }`, is migrated on load.
 */
export class PendingIntents {
  private byHost: Record<string, OutboxEntry[]> = {};
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly file: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    const raw = readJson<unknown>(file);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const r = raw as Partial<OutboxFile> & Record<string, unknown>;
    if (r.v === OUTBOX_VERSION && r.hosts && typeof r.hosts === 'object') {
      this.seq = Number.isSafeInteger(r.seq) ? (r.seq as number) : 0;
      for (const [host, list] of Object.entries(r.hosts)) {
        if (!HOST_ID_RE.test(host) || !Array.isArray(list)) continue;
        const entries = list.filter(validEntry).sort((a, b) => a.seq - b.seq);
        for (const e of entries) this.seq = Math.max(this.seq, e.seq);
        if (entries.length) this.byHost[host] = entries;
      }
      return;
    }
    // v1: { [hostId]: PendingIntent[] }, already coalesced, oldest first.
    const createdAt = this.now();
    for (const [host, list] of Object.entries(r)) {
      if (!HOST_ID_RE.test(host) || !Array.isArray(list)) continue;
      for (const intent of list) if (validIntent(intent)) this.enqueue(host, intent, createdAt);
    }
    if (Object.keys(this.byHost).length) this.persist();
  }

  /** Record an intent, on disk before this returns. Supersedes older pending intents about the same target. */
  add(hostId: string, intent: PendingIntent): OutboxEntry {
    const entry = this.enqueue(hostId, intent, this.now());
    this.persist();
    return { ...entry };
  }

  private enqueue(hostId: string, intent: PendingIntent, createdAt: number): OutboxEntry {
    const list = (this.byHost[hostId] ??= []);
    const seq = ++this.seq;
    const iid = `int-${seq}-${crypto.randomBytes(4).toString('hex')}`;
    let effective: PendingIntent = intent;
    const key = intentKey(intent);
    for (const e of list) {
      if (!isOpen(e)) continue;
      const k = intentKey(e.intent);
      const sameTarget = k === key;
      // Closing a session (or group) makes every other pending change to it moot.
      const mootByClose = (intent.t === 'close' && k.startsWith(`s:${intent.id}:`))
        || (intent.t === 'groupClose' && k.startsWith(`g:${intent.id}:`));
      if (!sameTarget && !mootByClose) continue;
      if (effective.t === 'sessionUpdate' && e.intent.t === 'sessionUpdate') effective = mergeSessionUpdate(e.intent, effective);
      e.state = 'superseded';
      e.supersededBy = iid;
      e.doneAt = createdAt;
    }
    const entry: OutboxEntry = { iid, seq, intent: effective, state: 'pending', createdAt, attempts: 0 };
    list.push(entry);
    this.prune(hostId);
    return entry;
  }

  /** Pending (sendable) entries of a host, oldest first. Expires the ones past their TTL first. */
  pending(hostId: string): OutboxEntry[] {
    this.expire(hostId);
    return (this.byHost[hostId] ?? []).filter((e) => e.state === 'pending').map((e) => ({ ...e }));
  }

  /** Pending and uncertain entries of a host (everything a snapshot may settle), oldest first. */
  unsettled(hostId: string): OutboxEntry[] {
    this.expire(hostId);
    return (this.byHost[hostId] ?? []).filter(isOpen).map((e) => ({ ...e }));
  }

  /**
   * Entry `iid` was sent and its ack deadline passed with the connection still
   * up: it may have been applied. It is not resent until a snapshot settles
   * it (see retryUncertain). False when it was no longer pending.
   */
  markUncertain(hostId: string, iid: string): boolean {
    const e = this.find(hostId, iid);
    if (!e || e.state !== 'pending') return false;
    e.state = 'uncertain';
    e.uncertainAt = this.now();
    this.persist();
    return true;
  }

  /**
   * A full registry snapshot (a welcome) was reconciled and still does not
   * show these uncertain entries' effects: they were not applied, so they go
   * back to pending and are resent. Returns how many.
   */
  retryUncertain(hostId: string): number {
    let n = 0;
    for (const e of this.byHost[hostId] ?? []) {
      if (e.state !== 'uncertain') continue;
      e.state = 'pending';
      delete e.uncertainAt;
      n++;
    }
    if (n) this.persist();
    return n;
  }

  /** Every entry of a host, terminal ones included, oldest first. */
  entries(hostId: string): OutboxEntry[] {
    return (this.byHost[hostId] ?? []).map((e) => ({ ...e }));
  }

  get(hostId: string, iid: string): OutboxEntry | undefined {
    const e = this.find(hostId, iid);
    return e ? { ...e } : undefined;
  }

  /**
   * About to write entry `iid` to the socket: count the attempt, on disk
   * first. False (send nothing) when it is no longer pending, or has used up
   * its attempts (it is then failed).
   */
  beginSend(hostId: string, iid: string): boolean {
    const e = this.find(hostId, iid);
    if (!e || e.state !== 'pending') return false;
    if (e.attempts >= INTENT_MAX_ATTEMPTS) {
      this.finish(e, 'failed', `no acknowledgement after ${e.attempts} attempts`);
      this.persist();
      return false;
    }
    e.attempts++;
    e.lastSentAt = this.now();
    this.persist();
    return true;
  }

  /**
   * The server acknowledged entry `iid` (or a snapshot proved it). Applied:
   * the entry is removed, whatever its state. Refused: a pending or uncertain
   * entry fails.
   * Never touches another entry; an ack for an older intent says nothing
   * about a newer one.
   */
  settle(hostId: string, iid: string, result: { ok: boolean; error?: string }): void {
    const list = this.byHost[hostId];
    const e = list?.find((x) => x.iid === iid);
    if (!list || !e) return;
    if (result.ok) {
      this.byHost[hostId] = list.filter((x) => x !== e);
      this.prune(hostId);
    } else {
      if (!isOpen(e)) return;
      this.finish(e, 'failed', result.error || 'refused by the server');
    }
    this.persist();
  }

  /** Forget a host's terminal (failed / expired / superseded) entries: the user has seen them. */
  clearDone(hostId: string): void {
    const list = this.byHost[hostId];
    if (!list) return;
    this.byHost[hostId] = list.filter(isOpen);
    this.prune(hostId);
    this.persist();
  }

  /** What the UI is told (HostStatus.outbox). */
  summary(hostId: string): OutboxSummary {
    const list = this.byHost[hostId] ?? [];
    const failed: OutboxSummary['failed'] = [];
    for (const e of list) {
      if (e.state === 'failed' || e.state === 'expired') {
        failed.push({ iid: e.iid, t: e.intent.t, id: e.intent.id, state: e.state, error: e.error, at: e.doneAt ?? e.createdAt });
      }
    }
    const uncertain = list.filter((e) => e.state === 'uncertain').length;
    return { pending: list.filter(isOpen).length, ...(uncertain ? { uncertain } : {}), failed };
  }

  /** The intents still wanted (pending or uncertain), oldest first. */
  peek(hostId: string): PendingIntent[] {
    return (this.byHost[hostId] ?? []).filter(isOpen).map((e) => e.intent);
  }

  private find(hostId: string, iid: string): OutboxEntry | undefined {
    return this.byHost[hostId]?.find((e) => e.iid === iid);
  }

  private finish(e: OutboxEntry, state: Exclude<IntentState, 'pending'>, error?: string): void {
    e.state = state;
    e.doneAt = this.now();
    if (error) e.error = error;
  }

  private expire(hostId: string): void {
    const cutoff = this.now() - INTENT_TTL_MS;
    let changed = false;
    for (const e of this.byHost[hostId] ?? []) {
      if (isOpen(e) && e.createdAt < cutoff) {
        this.finish(e, 'expired', 'not applied within 30 days');
        changed = true;
      }
    }
    if (this.prune(hostId) || changed) this.persist();
  }

  /** Drop old terminal entries (and an empty host); true when anything went. */
  private prune(hostId: string): boolean {
    const list = this.byHost[hostId];
    if (!list) return false;
    const cutoff = this.now() - DONE_KEEP_MS;
    let done = list.filter((e) => !isOpen(e) && (e.doneAt ?? e.createdAt) >= cutoff);
    if (done.length > DONE_KEEP_MAX) done = done.slice(done.length - DONE_KEEP_MAX);
    const keep = new Set(done);
    const next = list.filter((e) => isOpen(e) || keep.has(e));
    if (next.length) this.byHost[hostId] = next;
    else delete this.byHost[hostId];
    return next.length !== list.length || !next.length;
  }

  private persist(): void {
    const file: OutboxFile = { v: OUTBOX_VERSION, seq: this.seq, hosts: this.byHost };
    writeJsonAtomic(this.file, file);
  }
}

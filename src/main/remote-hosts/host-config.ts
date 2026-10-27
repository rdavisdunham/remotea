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
import type { HostSaveRequest } from '../../shared/remote-hosts-types';

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

function validIntent(i: PendingIntent): boolean {
  if (i.t === 'groupClose' || i.t === 'groupUpsert') return GROUP_ID_RE.test(i.id);
  return SURFACE_ID_RE.test(i.id);
}

/**
 * Changes made while a host was unreachable, replayed right after the next
 * welcome and BEFORE reconciling — so a tab closed on the train is closed on
 * the server, not re-placed from the registry when the laptop reconnects.
 */
export class PendingIntents {
  private byHost: Record<string, PendingIntent[]>;

  constructor(private readonly file: string) {
    const raw = readJson<Record<string, PendingIntent[]>>(file) ?? {};
    this.byHost = {};
    for (const [host, list] of Object.entries(raw)) {
      if (HOST_ID_RE.test(host) && Array.isArray(list)) this.byHost[host] = list.filter(validIntent);
    }
  }

  add(hostId: string, intent: PendingIntent): void {
    const list = (this.byHost[hostId] ??= []);
    // Later intents about the same target supersede earlier ones (hide then unhide = unhide).
    const key = (i: PendingIntent) => `${i.t === 'groupClose' || i.t === 'groupUpsert' ? 'g' : 's'}:${i.id}:${i.t === 'hide' || i.t === 'unhide' ? 'vis' : i.t}`;
    const k = key(intent);
    this.byHost[hostId] = [...list.filter((i) => key(i) !== k), intent];
    writeJsonAtomic(this.file, this.byHost);
  }

  take(hostId: string): PendingIntent[] {
    const list = this.byHost[hostId] ?? [];
    if (list.length) {
      delete this.byHost[hostId];
      writeJsonAtomic(this.file, this.byHost);
    }
    return list;
  }

  peek(hostId: string): PendingIntent[] {
    return [...(this.byHost[hostId] ?? [])];
  }
}

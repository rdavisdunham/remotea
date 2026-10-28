/**
 * Server configuration, token and identity, all under ~/.config/remotea
 * (or $REMOTEA_CONFIG_DIR). The directory is 0700 and every file 0600: the
 * token is effectively shell access to this machine.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export interface ServerConfig {
  port: number;
  /** Respawn lost sessions' agents with their resume command. */
  resumeAgents: boolean;
  /** IPs or interface names (e.g. "tailscale0"); never 0.0.0.0 by default. */
  bind: string[];
  scrollback: number;
  snapshotScrollback: number;
  ringBytes: number;
  exitedRetentionDays: number;
  tombstoneDays: number;
  /**
   * Loopback port for the hook bridge: agents' hooks (wmux-hook.js and the
   * wmux plugins) report status here, and the server relays it to the apps.
   * 0 turns the bridge off.
   */
  hookPort: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 7717,
  resumeAgents: true,
  bind: ['127.0.0.1', 'tailscale0'],
  scrollback: 5000,
  snapshotScrollback: 5000,
  ringBytes: 1024 * 1024,
  exitedRetentionDays: 7,
  tombstoneDays: 30,
  hookPort: 7718,
};

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.REMOTEA_CONFIG_DIR || path.join(os.homedir(), '.config', 'remotea');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* not ours to fix */
  }
}

export function loadConfig(dir: string): ServerConfig {
  ensureDir(dir);
  const file = path.join(dir, 'config.json');
  let user: Partial<ServerConfig> = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServerConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { mode: 0o600 });
    } else {
      throw new Error(`cannot read ${file}: ${(err as Error).message}`);
    }
  }
  return { ...DEFAULT_CONFIG, ...user };
}

function readOrCreate(file: string, make: () => string): string {
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return v;
  } catch {
    /* create below */
  }
  const value = make();
  fs.writeFileSync(file, value + '\n', { mode: 0o600 });
  return value;
}

export function ensureToken(dir: string): string {
  ensureDir(dir);
  return readOrCreate(path.join(dir, 'token'), () => crypto.randomBytes(32).toString('base64url'));
}

export function rotateToken(dir: string): string {
  ensureDir(dir);
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dir, 'token'), token + '\n', { mode: 0o600 });
  return token;
}

/**
 * The secret behind per-session hook tokens. Never leaves this directory: a
 * session sees only HMAC(secret, its own id), which lets it report status for
 * itself and nothing else — unlike the main token, which is shell access.
 */
export function ensureHookSecret(dir: string): string {
  ensureDir(dir);
  return readOrCreate(path.join(dir, 'hook-secret'), () => crypto.randomBytes(32).toString('base64url'));
}

export function ensureServerId(dir: string): string {
  ensureDir(dir);
  return readOrCreate(path.join(dir, 'server-id'), () => crypto.randomUUID());
}

/**
 * Resolve bind entries to IPv4 addresses. Interface names that are not up
 * yet (tailscale0 right after a WSL cold boot) are returned in `pending`
 * so the caller can retry them.
 */
export function resolveBind(entries: string[], ifaces = os.networkInterfaces()): { addresses: string[]; pending: string[] } {
  const addresses: string[] = [];
  const pending: string[] = [];
  for (const entry of entries) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(entry) || entry.includes(':')) {
      addresses.push(entry);
      continue;
    }
    const v4 = (ifaces[entry] ?? []).find((a) => a.family === 'IPv4' && !a.internal);
    if (v4) addresses.push(v4.address);
    else pending.push(entry);
  }
  return { addresses: [...new Set(addresses)], pending };
}

// ── Eridani link (eridani-link.ts) ─────────────────────────────────────────

/**
 * 'parity' (stage B default): reports carry `parity: true`; Eridani compares
 * them with what the Python collector stored and keeps nothing.
 * 'authoritative' (stage E cutover): reports are stored; the Python collector
 * is meant to be off (status --json turns v2, which it does not read).
 * 'off': no collector at all.
 */
export type CollectorMode = 'parity' | 'authoritative' | 'off';
/** The one command that stops the Python collector (its install.sh enables this timer). */
export const LEGACY_TIMER_HINT = 'systemctl --user disable --now eridani-collector.timer';
export const COLLECTOR_MODES: readonly CollectorMode[] = ['parity', 'authoritative', 'off'];

export function parseCollectorMode(v: unknown): CollectorMode {
  return v === 'authoritative' || v === 'off' ? v : 'parity';
}

export interface EridaniConfig {
  enabled: boolean;
  /** wss://…/api/v1/external/agents/link */
  url: string;
  /** Machine name sent with every session report; defaults to the hostname. */
  machine?: string;
  /** See CollectorMode; 'parity' unless switched with `remotea eridani collector`. */
  collector: CollectorMode;
}

export const ERIDANI_FILE = 'eridani.json';
export const ERIDANI_TOKEN_FILE = 'eridani-token';
/** `remotea eridani collect` drops this; the running server picks it up and scans. */
export const ERIDANI_COLLECT_REQUEST = 'eridani-collect-request';
export const ERIDANI_KEY_RE = /^eri_bot_[A-Za-z0-9_-]{8,256}$/;

/**
 * Why a link URL is refused, or null. The key travels in the handshake on
 * every reconnect, so cleartext `ws://` is allowed only to this machine
 * (a local test); everything else must be `wss://` (L10, stage F).
 */
export function linkUrlError(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'the link URL is not a URL';
  }
  if (u.protocol === 'wss:') return null;
  if (u.protocol !== 'ws:') return 'the link URL starts with wss://';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? null : 'ws:// is allowed only for localhost, 127.0.0.1 or ::1; use wss://';
}

/** The link's config, or null when it was never set up (or is unreadable). */
export function loadEridaniConfig(dir: string): EridaniConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, ERIDANI_FILE), 'utf8')) as Partial<EridaniConfig>;
    if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string') return null;
    return {
      enabled: raw.enabled === true,
      url: raw.url,
      machine: typeof raw.machine === 'string' && raw.machine.trim() ? raw.machine.trim().slice(0, 100) : undefined,
      collector: parseCollectorMode(raw.collector),
    };
  } catch {
    return null;
  }
}

/** The file as written, unknown keys included (execution targets live beside the link settings). */
export function readEridaniFile(dir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, ERIDANI_FILE), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writeEridaniFile(dir: string, data: Record<string, unknown>): void {
  ensureDir(dir);
  const file = path.join(dir, ERIDANI_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Write the link settings; every other key in the file (targets) is kept. */
export function saveEridaniConfig(dir: string, cfg: EridaniConfig): void {
  writeEridaniFile(dir, { ...readEridaniFile(dir), ...cfg });
}

export function readEridaniToken(dir: string): string | null {
  try {
    const v = fs.readFileSync(path.join(dir, ERIDANI_TOKEN_FILE), 'utf8').trim();
    return ERIDANI_KEY_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeEridaniToken(dir: string, key: string): void {
  if (!ERIDANI_KEY_RE.test(key)) throw new Error('an Eridani link key starts with eri_bot_');
  ensureDir(dir);
  const file = path.join(dir, ERIDANI_TOKEN_FILE);
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function forgetEridaniToken(dir: string): void {
  fs.rmSync(path.join(dir, ERIDANI_TOKEN_FILE), { force: true });
}

/**
 * What the link depends on: its settings and the key file. The runtime
 * restarts the link when this changes. Execution targets are not in it:
 * dispatch reads them from the file on every spawn, so `remotea eridani
 * targets add` never drops the connection.
 */
export function eridaniConfigStamp(dir: string): string {
  const cfg = loadEridaniConfig(dir);
  let key = '-';
  try {
    const st = fs.statSync(path.join(dir, ERIDANI_TOKEN_FILE));
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    /* no key */
  }
  return `${cfg ? JSON.stringify([cfg.enabled, cfg.url, cfg.machine ?? null, cfg.collector]) : '-'}|${key}`;
}

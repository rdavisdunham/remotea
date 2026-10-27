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
  /** IPs or interface names (e.g. "tailscale0"); never 0.0.0.0 by default. */
  bind: string[];
  scrollback: number;
  snapshotScrollback: number;
  ringBytes: number;
  exitedRetentionDays: number;
  tombstoneDays: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 7717,
  bind: ['127.0.0.1', 'tailscale0'],
  scrollback: 5000,
  snapshotScrollback: 5000,
  ringBytes: 1024 * 1024,
  exitedRetentionDays: 7,
  tombstoneDays: 30,
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

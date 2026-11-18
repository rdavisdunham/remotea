/**
 * Build identity (S-S5): which commit the running server was built from.
 *
 * The package version (0.1.0) never changes and a dist directory proves
 * nothing, so `npm run build` runs scripts/build-info.mjs after tsc. It
 * writes dist/build-info.json:
 *
 *   { "name": "remotea-server", "sha": "<git rev-parse HEAD>", "dirty": false, "built_at": "<ISO>" }
 *
 * `sha` is "unknown" when git could not say (a tarball build); a missing or
 * foreign file reads as unknown too (a build from before this script, or the
 * sources run directly under vitest). Read once when the server starts: a
 * rebuild without a restart does not change what the running server reports,
 * which is the point. `remotea status` shows both the running server's build
 * (SERVER_INFO_FILE, written at start) and the one on disk.
 *
 * The hook version is the installed helper's content hash, so a stale
 * `remotea hooks install` shows up next to the build.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ERIDANI_CAPS_VERSION, ERIDANI_PROTO } from '../../src/shared/eridani-link-protocol';

export const UNKNOWN_SHA = 'unknown';
export const BUILD_INFO_FILE = 'build-info.json';
/** Written by the server at start, in the config dir: what is running now. */
export const SERVER_INFO_FILE = 'server-info.json';

export interface BuildInfo {
  /** 40 hex, or "unknown". */
  sha: string;
  /** Uncommitted changes in the checkout at build time; null when unknown. */
  dirty: boolean | null;
  /** ISO time of the build; null when unknown. */
  builtAt: string | null;
}

export const UNKNOWN_BUILD: BuildInfo = Object.freeze({ sha: UNKNOWN_SHA, dirty: null, builtAt: null });

/** dist/remote-server/src/build-info.js → dist/build-info.json. */
export function defaultBuildInfoFile(): string {
  return path.join(__dirname, '..', '..', BUILD_INFO_FILE);
}

/** The build this code came from; UNKNOWN_BUILD when the file is missing, foreign or malformed. */
export function loadBuildInfo(file: string = defaultBuildInfoFile()): BuildInfo {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!raw || raw.name !== 'remotea-server') return UNKNOWN_BUILD;
    const sha = typeof raw.sha === 'string' && /^[0-9a-f]{40}$/.test(raw.sha) ? raw.sha : UNKNOWN_SHA;
    return {
      sha,
      dirty: sha !== UNKNOWN_SHA && typeof raw.dirty === 'boolean' ? raw.dirty : null,
      builtAt: typeof raw.built_at === 'string' && raw.built_at.length <= 40 ? raw.built_at : null,
    };
  } catch {
    return UNKNOWN_BUILD;
  }
}

/** The first 12 hex of a file's sha256, or null when it cannot be read. */
export function fileVersion(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export interface HookVersion {
  /** The helper `remotea hooks install` copied (what the agents run); null when not installed. */
  installed: string | null;
  /** The helper this checkout ships. */
  bundled: string | null;
  /** installed === bundled; null when either is missing. */
  current: boolean | null;
}

/** The installed hook helper's version and whether it matches the one this build ships. */
export function hookVersion(p: { cliDir: string; sourceDir: string }): HookVersion {
  const installed = fileVersion(path.join(p.cliDir, 'remotea-hook.js'));
  const bundled = fileVersion(path.join(p.sourceDir, 'remotea-hook.js'));
  return { installed, bundled, current: installed && bundled ? installed === bundled : null };
}

/** What the running server writes at start (SERVER_INFO_FILE). */
export interface ServerInfo {
  pid: number;
  bootId: string;
  startedAt: number;
  version: string;
  build: BuildInfo;
  proto: number;
  capsVersion: number;
  /** S-Q5 (optional): what the CLI may ask of this server; `drain` = SIGUSR2 drains (`remotea upgrade`). */
  features?: string[];
}

/** What this build's server-info.json says it supports (`remotea upgrade` checks for `drain` before signalling). */
export const SERVER_FEATURES: readonly string[] = ['drain'];

export function serverInfo(o: { bootId: string; version: string; build: BuildInfo; now?: number; pid?: number }): ServerInfo {
  return { pid: o.pid ?? process.pid, bootId: o.bootId, startedAt: o.now ?? Date.now(), version: o.version, build: o.build, proto: ERIDANI_PROTO, capsVersion: ERIDANI_CAPS_VERSION, features: [...SERVER_FEATURES] };
}

export function writeServerInfo(dir: string, info: ServerInfo): void {
  const file = path.join(dir, SERVER_INFO_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The running server's info, or null when none was written or its process is gone. */
export function readServerInfo(dir: string, alive: (pid: number) => boolean = pidAlive): ServerInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, SERVER_INFO_FILE), 'utf8')) as ServerInfo;
    if (!info || typeof info.pid !== 'number' || !info.build || typeof info.build.sha !== 'string') return null;
    return alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

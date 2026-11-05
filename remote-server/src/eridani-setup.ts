/**
 * `remotea eridani setup`: one re-runnable wizard for everything that used to
 * be assembled by hand (task bbdb6440). Each step reads what is there first,
 * changes only what differs, and says so; a second run changes nothing.
 *
 *   1. Link     the link key and URL, written the way `connect` writes them
 *               (proved first with one hello → welcome); prints the host id,
 *               Eridani's caps and this build.
 *   2. Targets  the configured targets, plus git repositories found under
 *               `--scan` folders and the existing targets' parent folders;
 *               `--add-repo` (or a yes at the prompt) adds one with a launch
 *               config and a detected verify entry.
 *   3. MCP      the bot key spawned agents use (`mcpKeyFile`, default
 *               `<config dir>/eridani-mcp-token`, 0600; never the link key),
 *               and, on request, a user-level `eridani` MCP entry for each
 *               installed harness (Claude Code user scope, Codex
 *               config.toml, OpenCode's global config), so hand-started
 *               sessions have the tools too. An existing `eridani` entry is
 *               never overwritten without `--replace`; every write is shown
 *               first, with keys redacted.
 *   4. Hooks    whether the remotea hooks are installed and current; installs
 *               them only with `--hooks` (it edits ~/.claude/settings.json).
 *
 * Then the per-target readiness table (what hello sends: enabled harnesses,
 * launch ready/version/error, verify status, mcp) and a summary of what was
 * changed, what was already right and what was skipped and why.
 *
 * Every answer has a flag, so scripts and tests never see a prompt; a key
 * given as `-` is read from stdin (one line each, in the order code, link
 * key, MCP key), which keeps it out of argv and shell history. Keys are never
 * printed.
 */
import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import {
  ERIDANI_CAPS_VERSION,
  ERIDANI_PROTO,
  STAGE_F_AUTHORITATIVE_CAPS,
  STAGE_F_CAPS,
  type HelloTarget,
} from '../../src/shared/eridani-link-protocol';
import {
  ERIDANI_KEY_RE,
  ERIDANI_TOKEN_FILE,
  ensureServerId,
  linkUrlError,
  loadEridaniConfig,
  readEridaniFile,
  readEridaniToken,
  saveEridaniConfig,
  writeEridaniToken,
  type EridaniConfig,
} from './config';
import { keyFilePath, keyFileSettingOk, mcpStatus, mcpUrlError, mcpUrlFromLink, resolveMcp, writePrivate, type McpStatus } from './eridani-mcp';
import { TARGET_ID_RE, loadTargets, saveTarget, targetError, type ExecutionTarget, type VerifySpec } from './eridani-targets';
import { withTemplate } from './target-template';
import { helloTargets, launchersToProbe, probeKey, type LauncherProbe, type ProbeFn, type ProbeHarness, type SpawnHarness } from './launch-caps';
import { hookVersion, loadBuildInfo, readServerInfo } from './build-info';
import { hooksStatus, installHooks, type HookPaths } from './hooks-install';
import { readLinkStatus } from './eridani-link';

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface SetupOptions {
  url?: string;
  machine?: string;
  /** A setup code from Eridani (`eridani-setup:1:…`), or `-` for stdin. */
  code?: string;
  /** The link key, or `-` for stdin. */
  linkKey?: string;
  /** The MCP bot key, or `-` for stdin. */
  mcpKey?: string;
  noProbe: boolean;
  /** Seconds to wait for the running server to report the link ready. */
  wait: number;
  scan: string[];
  /** `<path>` or `<id>=<path>`. */
  addRepo: string[];
  /** Harnesses for added targets; empty: those whose launcher answers (else claude). */
  harnesses: SpawnHarness[];
  /** `<id>=<command>` for added targets; empty: detected from the repository. */
  verify: string[];
  verifyTimeout: number;
  /** Write the user-level MCP entries without asking. */
  userMcp: boolean;
  /** Never write them (and do not ask). */
  noUserMcp: boolean;
  /** Overwrite an existing `eridani` MCP entry. */
  replace: boolean;
  /** Run `remotea hooks install` when the hooks are missing or stale. */
  hooks: boolean;
  /** Never prompt. */
  yes: boolean;
  dryRun: boolean;
  json: boolean;
}

/**
 * A verify entry's default timeout: 2 h. A full suite on a loaded machine has run past 30 min (Eridani run
 * ad1a1c02 was killed at 1800 s at 94%), and Eridani announces a slow run instead of failing it.
 */
export const DEFAULT_VERIFY_TIMEOUT = 7200;

export const SETUP_USAGE = `usage: remotea eridani setup [--code <code>|-] [--url <wss://…|https://…>] [--machine <name>]
         [--link-key <key>|-] [--mcp-key <key>|-] [--no-probe] [--wait <s>]
         [--scan <dir>]… [--add-repo [<id>=]<path>]… [--claude] [--codex] [--verify <id>=<command>]… [--verify-timeout <s> (default 7200)]
         [--user-mcp | --no-user-mcp] [--replace] [--hooks] [--yes] [--dry-run] [--json]`;

function takeFlag(args: string[], i: number, name: string): string {
  const v = args[i + 1];
  if (v === undefined || (v.startsWith('--') && v !== '-')) throw new Error(`${name} needs a value`);
  return v;
}

export function parseSetupArgs(args: string[]): SetupOptions {
  const o: SetupOptions = {
    noProbe: false, wait: 0, scan: [], addRepo: [], harnesses: [], verify: [], verifyTimeout: DEFAULT_VERIFY_TIMEOUT,
    userMcp: false, noUserMcp: false, replace: false, hooks: false, yes: false, dryRun: false, json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => takeFlag(args, i++, a);
    switch (a) {
      case '--url': o.url = value(); break;
      case '--machine': o.machine = value(); break;
      case '--code': o.code = value(); break;
      case '--link-key': o.linkKey = value(); break;
      case '--mcp-key': o.mcpKey = value(); break;
      case '--no-probe': o.noProbe = true; break;
      case '--wait': {
        o.wait = Number(value());
        if (!(o.wait >= 0 && o.wait <= 600)) throw new Error('--wait takes seconds (0 to 600)');
        break;
      }
      case '--scan': o.scan.push(value()); break;
      case '--add-repo': o.addRepo.push(value()); break;
      case '--claude': o.harnesses.push('claude'); break;
      case '--codex': o.harnesses.push('codex'); break;
      case '--verify': o.verify.push(value()); break;
      case '--verify-timeout': {
        o.verifyTimeout = Number(value());
        if (!(o.verifyTimeout > 0 && o.verifyTimeout <= 6 * 3600)) throw new Error('--verify-timeout takes seconds (≤ 6 h)');
        break;
      }
      case '--user-mcp': o.userMcp = true; break;
      case '--no-user-mcp': o.noUserMcp = true; break;
      case '--replace': o.replace = true; break;
      case '--hooks': o.hooks = true; break;
      case '--yes': case '-y': case '--non-interactive': o.yes = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--json': o.json = true; break;
      default: throw new Error(`unknown setup option ${a}\n${SETUP_USAGE}`);
    }
  }
  if (o.userMcp && o.noUserMcp) throw new Error('--user-mcp and --no-user-mcp contradict each other');
  return o;
}

// ── The one line Eridani can print ─────────────────────────────────────────

export const SETUP_CODE_PREFIX = 'eridani-setup:1:';
const SETUP_CODE_RE = /eridani-setup:1:([A-Za-z0-9_-]+)/;

export interface SetupCode {
  /** The link URL (wss://…/api/v1/external/agents/link) or the Eridani origin. */
  url: string;
  link_key: string;
  mcp_key?: string;
  machine?: string;
}

/** `eridani-setup:1:` + base64url(JSON). What Eridani shows after Enable (see docs/remotea/eridani-link.md § Setup). */
export function encodeSetupCode(c: SetupCode): string {
  return SETUP_CODE_PREFIX + Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Finds and decodes a setup code anywhere in a pasted line. Throws without echoing the line. */
export function parseSetupCode(text: string): SetupCode {
  const m = SETUP_CODE_RE.exec(text);
  if (!m) throw new Error(`that is not an Eridani setup code (it starts with ${SETUP_CODE_PREFIX})`);
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('the setup code is damaged (copy it again from Eridani)');
  }
  const o = raw as Record<string, unknown>;
  if (!o || typeof o.url !== 'string' || typeof o.link_key !== 'string') throw new Error('the setup code has no url or link key');
  if (o.mcp_key !== undefined && typeof o.mcp_key !== 'string') throw new Error('the setup code has a bad MCP key');
  return {
    url: o.url,
    link_key: o.link_key,
    ...(typeof o.mcp_key === 'string' && o.mcp_key ? { mcp_key: o.mcp_key } : {}),
    ...(typeof o.machine === 'string' && o.machine.trim() ? { machine: o.machine.trim() } : {}),
  };
}

const LINK_PATH = '/api/v1/external/agents/link';

/** An Eridani origin (https://host) becomes its link URL; a link URL is kept. */
export function normalizeLinkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim();
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    const ws = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const p = u.pathname === '/' || u.pathname === '' ? LINK_PATH : u.pathname;
    return `${ws}//${u.host}${p}`;
  }
  return url.trim();
}

// ── Prompts ────────────────────────────────────────────────────────────────

export interface Prompter {
  /** False: never ask; every answer takes its default. */
  interactive: boolean;
  text(question: string, def?: string): Promise<string>;
  /** Not echoed. */
  secret(question: string): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
}

export const noPrompter: Prompter = {
  interactive: false,
  text: async (_q, def) => def ?? '',
  secret: async () => '',
  confirm: async (_q, def) => def,
};

/** Read one line from a terminal without echoing it. */
export function readSecret(question: string, stdin: NodeJS.ReadStream = process.stdin, err: NodeJS.WritableStream = process.stderr): Promise<string> {
  err.write(question);
  return new Promise((resolve, reject) => {
    let key = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (e?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      err.write('\n');
      if (e) reject(e);
      else resolve(key.trim());
    };
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') return done();
        if (c === '\x03') return done(new Error('cancelled'));
        if (c === '\x7f' || c === '\b') key = key.slice(0, -1);
        else if (c >= ' ') key += c;
      }
    };
    stdin.on('data', onData);
  });
}

/** Prompts on the terminal (questions on stderr, so stdout stays the report). */
export function ttyPrompter(): Prompter {
  const ask = (q: string): Promise<string> => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
  return {
    interactive: true,
    text: async (q, def) => (await ask(`${q}${def ? ` [${def}]` : ''}: `)) || def || '',
    secret: (q) => readSecret(`${q}: `),
    confirm: async (q, def) => {
      const a = (await ask(`${q} [${def ? 'Y/n' : 'y/N'}] `)).toLowerCase();
      return a ? a.startsWith('y') : def;
    },
  };
}

// ── Dependencies ───────────────────────────────────────────────────────────

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SetupDeps {
  /** The config dir (~/.config/remotea). */
  dir: string;
  /** Whose harness configs to inspect and write. */
  home: string;
  /** PATH (harness detection), XDG_CONFIG_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR. */
  env: NodeJS.ProcessEnv;
  out: NodeJS.WritableStream;
  prompt: Prompter;
  serverRunning: () => Promise<boolean>;
  /** One hello → welcome (eridani-cli.ts probeLink). */
  probeLink: (url: string, key: string, hello: { server_id: string; machine: string; version: string }) => Promise<{ hostId: string | null; caps?: string[] }>;
  /** The launcher probe (launch-caps.ts defaultProbe: the login shell, as a spawn runs it). */
  probe: ProbeFn;
  /** Runs a harness CLI (claude mcp add); never through a shell. */
  run?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>;
  hookPaths: HookPaths;
  /** stdin's lines, for keys given as `-`. */
  stdinLines?: () => Promise<string[]>;
  version: string;
  sleep?: (ms: number) => Promise<void>;
}

function defaultRun(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Read all of stdin once (piped), as trimmed non-empty lines. */
export function stdinLinesOnce(): () => Promise<string[]> {
  let p: Promise<string[]> | null = null;
  return () => {
    p ??= (async () => {
      if (process.stdin.isTTY) return [];
      let data = '';
      for await (const chunk of process.stdin) {
        data += chunk;
        if (data.length > 64 * 1024) break;
      }
      return data.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    })();
    return p;
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────

/** Never print a key: any eri_bot_ key or bearer value becomes a placeholder. */
export function redact(s: string): string {
  return s.replace(/eri_bot_[A-Za-z0-9_-]+/g, 'eri_bot_****').replace(/(Bearer\s+)(?!eri_bot_\*\*\*\*)[^\s"',}]+/g, '$1****');
}

function executable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The program on PATH, or null. */
export function which(bin: string, PATH: string | undefined): string | null {
  for (const d of (PATH ?? '').split(':')) {
    if (d && path.isAbsolute(d) && executable(path.join(d, bin))) return path.join(d, bin);
  }
  return null;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Atomic write that keeps the file's mode minus group/other bits (the file
 * now holds a key), 0600 when new; the first change keeps
 * `<file>.remotea-backup` (0600), as `remotea hooks install` does.
 */
function writeKeepingMode(file: string, content: string): void {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o700;
  } catch {
    /* new file */
  }
  const backup = `${file}.remotea-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  if (fs.existsSync(backup)) fs.chmodSync(backup, 0o600);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.remotea-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** A table with padded columns. */
export function fmtTable(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd());
}

// ── Harness MCP entries ────────────────────────────────────────────────────

export type UserHarness = 'claude' | 'codex' | 'opencode';
export const USER_HARNESSES: readonly UserHarness[] = ['claude', 'codex', 'opencode'];

export type EntryState = 'absent' | 'same' | 'differs' | 'unreadable';

export interface EntryInspection {
  harness: UserHarness;
  file: string;
  state: EntryState;
  /** Why unreadable, or what differs (never a key). */
  detail?: string;
  /** The current entry, redacted, one line per element. */
  current?: string[];
}

/** Where Claude Code keeps user-scope MCP servers. */
export function claudeConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
}

export function codexConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
}

function opencodeDir(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
}

/** OpenCode's global config: the first that exists of opencode.json, opencode.jsonc, config.json; else a new opencode.json. */
export function opencodeConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  const d = opencodeDir(home, env);
  for (const f of ['opencode.json', 'opencode.jsonc', 'config.json']) if (fs.existsSync(path.join(d, f))) return path.join(d, f);
  return path.join(d, 'opencode.json');
}

const bearer = (key: string) => `Bearer ${key}`;

function jsonLines(v: unknown): string[] {
  return redact(JSON.stringify(v, null, 2)).split('\n');
}

// Claude Code: { mcpServers: { eridani: { type: "http", url, headers: { Authorization } } } } in ~/.claude.json.

function claudeEntry(url: string, key: string): Record<string, unknown> {
  return { type: 'http', url, headers: { Authorization: bearer(key) } };
}

function inspectJsonEntry(harness: UserHarness, file: string, pick: (j: Record<string, any>) => unknown, same: (e: Record<string, any>) => boolean, parse: (t: string) => Record<string, any>): EntryInspection {
  const text = readText(file);
  if (text === null || !text.trim()) return { harness, file, state: 'absent' };
  let j: Record<string, any>;
  try {
    j = parse(text);
  } catch (err) {
    return { harness, file, state: 'unreadable', detail: `not JSON (${(err as Error).message.slice(0, 80)})` };
  }
  const e = pick(j);
  if (e === undefined || e === null) return { harness, file, state: 'absent' };
  if (typeof e !== 'object') return { harness, file, state: 'differs', detail: 'not an object', current: jsonLines(e) };
  return same(e as Record<string, any>)
    ? { harness, file, state: 'same', current: jsonLines(e) }
    : { harness, file, state: 'differs', detail: describeDiff(e as Record<string, any>), current: jsonLines(e) };
}

/** What differs, without values: the reader sees which field, never a key. */
function describeDiff(e: Record<string, any>): string {
  const auth = e.headers?.Authorization ?? e.http_headers?.Authorization;
  return auth === undefined ? 'no Authorization header' : 'another url or key';
}

export function inspectClaude(home: string, env: NodeJS.ProcessEnv, url: string, key: string): EntryInspection {
  const file = claudeConfigFile(home, env);
  return inspectJsonEntry('claude', file, (j) => j?.mcpServers?.eridani, (e) => e.type === 'http' && e.url === url && e.headers?.Authorization === bearer(key), (t) => JSON.parse(t));
}

// OpenCode: { mcp: { eridani: { type: "remote", url, headers, enabled } } }.

function opencodeEntry(url: string, key: string): Record<string, unknown> {
  return { type: 'remote', url, headers: { Authorization: bearer(key) }, enabled: true };
}

/** JSON with comments and trailing commas (OpenCode accepts both) → JSON. */
export function stripJsonc(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function inspectOpencode(home: string, env: NodeJS.ProcessEnv, url: string, key: string): EntryInspection {
  const file = opencodeConfigFile(home, env);
  return inspectJsonEntry('opencode', file, (j) => j?.mcp?.eridani, (e) => e.type === 'remote' && e.url === url && e.headers?.Authorization === bearer(key) && e.enabled !== false, (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return JSON.parse(stripJsonc(t));
    }
  });
}

// Codex: a [mcp_servers.eridani] table in config.toml.

const CODEX_TABLE_RE = /^\s*\[\s*mcp_servers\s*\.\s*(?:eridani|"eridani"|'eridani')\s*(\.[^\]]*)?\]\s*(?:#.*)?$/;
const TOML_HEADER_RE = /^\s*\[/;

export type CodexEntry = { kind: 'table'; start: number; end: number } | { kind: 'other' } | null;

/** Where config.toml defines `eridani`: a [mcp_servers.eridani] table (line range), another form, or nowhere. */
export function findCodexEntry(text: string): CodexEntry {
  const lines = text.split('\n');
  let table: string | null = null; // the current [header], null at top level
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = CODEX_TABLE_RE.exec(line);
    if (m) {
      if (m[1]) return { kind: 'other' }; // a subtable with no [mcp_servers.eridani] before it
      let end = i + 1;
      for (; end < lines.length; end++) {
        if (!TOML_HEADER_RE.test(lines[end])) continue;
        const sub = CODEX_TABLE_RE.exec(lines[end]);
        if (!sub?.[1]) break;
      }
      while (end > i + 1 && !lines[end - 1].trim()) end--;
      return { kind: 'table', start: i, end };
    }
    if (TOML_HEADER_RE.test(line)) {
      table = line.trim().replace(/\s+/g, '');
      continue;
    }
    if (table === null && /^\s*mcp_servers\s*(\.\s*["']?eridani["']?\s*[.=]|=.*\beridani\b)/.test(line)) return { kind: 'other' };
    if (table === '[mcp_servers]' && /^\s*["']?eridani["']?\s*[.=]/.test(line)) return { kind: 'other' };
  }
  return null;
}

export function codexBlock(url: string, key: string): string[] {
  return ['[mcp_servers.eridani]', `url = ${JSON.stringify(url)}`, `http_headers = { Authorization = ${JSON.stringify(bearer(key))} }`];
}

function tomlString(block: string, keyRe: string): string | null {
  const m = new RegExp(`^\\s*${keyRe}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(block) ?? new RegExp(`${keyRe}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

export function inspectCodex(home: string, env: NodeJS.ProcessEnv, url: string, key: string): EntryInspection {
  const file = codexConfigFile(home, env);
  const text = readText(file);
  if (text === null) return { harness: 'codex', file, state: 'absent' };
  const at = findCodexEntry(text);
  if (!at) return { harness: 'codex', file, state: 'absent' };
  if (at.kind === 'other') return { harness: 'codex', file, state: 'differs', detail: 'defined outside a [mcp_servers.eridani] table' };
  const lines = text.split('\n').slice(at.start, at.end);
  const block = lines.join('\n');
  const same = tomlString(block, 'url') === url && tomlString(block, '"?Authorization"?') === bearer(key);
  return { harness: 'codex', file, state: same ? 'same' : 'differs', current: lines.map(redact), ...(same ? {} : { detail: tomlString(block, '"?Authorization"?') === null ? 'no Authorization header' : 'another url or key' }) };
}

export function inspectEntry(h: UserHarness, home: string, env: NodeJS.ProcessEnv, url: string, key: string): EntryInspection {
  return h === 'claude' ? inspectClaude(home, env, url, key) : h === 'codex' ? inspectCodex(home, env, url, key) : inspectOpencode(home, env, url, key);
}

/** The new entry, redacted, for the diff. */
function plannedLines(h: UserHarness, url: string, key: string): string[] {
  if (h === 'codex') return codexBlock(url, key).map(redact);
  return jsonLines(h === 'claude' ? claudeEntry(url, key) : opencodeEntry(url, key));
}

function entryLabel(h: UserHarness): string {
  return h === 'claude' ? 'mcpServers.eridani (user scope)' : h === 'codex' ? '[mcp_servers.eridani]' : 'mcp.eridani';
}

/** A diff of the eridani entry only (other servers and settings are never shown); keys redacted. */
export function entryDiff(ins: EntryInspection, next: string[]): string[] {
  const out = [`--- ${ins.file}  ${entryLabel(ins.harness)}${ins.state === 'absent' ? ' (none)' : ''}`, `+++ ${ins.file}  ${entryLabel(ins.harness)}`];
  for (const l of ins.state === 'absent' ? [] : ins.current ?? []) out.push(`- ${l}`);
  for (const l of next) out.push(`+ ${l}`);
  return out;
}

/** Write one harness's entry. Returns a description of the change. */
async function applyEntry(h: UserHarness, ins: EntryInspection, url: string, key: string, d: SetupDeps, bin: string): Promise<string> {
  if (h === 'claude') {
    const run = d.run ?? defaultRun;
    const env = { ...d.env, HOME: d.home };
    if (ins.state !== 'absent') {
      const r = await run(bin, ['mcp', 'remove', '--scope', 'user', 'eridani'], env);
      if (r.code !== 0) throw new Error(`claude mcp remove failed (exit ${r.code}): ${redact((r.stderr || r.stdout).trim()).slice(0, 300)}`);
    }
    const r = await run(bin, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'eridani', url, '--header', `Authorization: ${bearer(key)}`], env);
    if (r.code !== 0) throw new Error(`claude mcp add failed (exit ${r.code}): ${redact((r.stderr || r.stdout).trim()).slice(0, 300)}`);
    const after = inspectClaude(d.home, d.env, url, key);
    if (after.state !== 'same') throw new Error(`claude mcp add ran, but ${after.file} does not hold the expected entry (${after.state})`);
    return `claude: user-scope MCP server eridani (claude mcp add --scope user --transport http eridani ${url} --header "Authorization: Bearer ****")`;
  }
  if (h === 'codex') {
    const text = readText(ins.file) ?? '';
    const at = findCodexEntry(text);
    if (at?.kind === 'other') throw new Error(`${ins.file} defines eridani outside a [mcp_servers.eridani] table; edit it by hand`);
    let next: string;
    if (at) {
      const lines = text.split('\n');
      lines.splice(at.start, at.end - at.start, ...codexBlock(url, key));
      next = lines.join('\n');
    } else {
      const base = text.length && !text.endsWith('\n') ? `${text}\n` : text;
      next = `${base}${base.trim() ? '\n' : ''}${codexBlock(url, key).join('\n')}\n`;
    }
    writeKeepingMode(ins.file, next);
    return `codex: [mcp_servers.eridani] in ${ins.file} (mode 0600)`;
  }
  const text = readText(ins.file);
  let j: Record<string, any> = {};
  if (text !== null && text.trim()) {
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`${ins.file} has comments or trailing commas; add the entry above by hand (remotea does not rewrite it)`);
    }
  } else j = { $schema: 'https://opencode.ai/config.json' };
  const indent = /\n(\t| +)"/.exec(text ?? '')?.[1] ?? 2;
  const next = { ...j, mcp: { ...(j.mcp && typeof j.mcp === 'object' ? j.mcp : {}), eridani: opencodeEntry(url, key) } };
  writeKeepingMode(ins.file, JSON.stringify(next, null, indent) + '\n');
  return `opencode: mcp.eridani in ${ins.file} (mode 0600)`;
}

// ── MCP wiring (status) ────────────────────────────────────────────────────

export interface WiringRow {
  /** `spawn` is the per-spawn --mcp-config / -c path (the key file). */
  harness: 'spawn' | UserHarness;
  state: string;
  detail: string;
}

function mcpEndpoint(dir: string, linkUrl: string | null): { url: string } | { error: string } {
  const file = readEridaniFile(dir);
  if (file.mcpUrl !== undefined) {
    if (typeof file.mcpUrl !== 'string') return { error: 'mcpUrl in eridani.json is not a string' };
    const err = mcpUrlError(file.mcpUrl);
    if (err) return { error: err };
    const u = new URL(file.mcpUrl);
    return { url: u.pathname.endsWith('/') ? u.toString() : `${u.toString()}/` };
  }
  if (!linkUrl) return { error: 'no Eridani link configured' };
  const url = mcpUrlFromLink(linkUrl);
  return url ? { url } : { error: 'cannot derive the MCP URL from the link URL (set mcpUrl in eridani.json)' };
}

function globalKeyFile(dir: string): string {
  const s = readEridaniFile(dir).mcpKeyFile;
  return keyFilePath(dir, keyFileSettingOk(s) ? s : undefined);
}

function readKeyFile(file: string): string | null {
  const t = readText(file)?.trim();
  return t && ERIDANI_KEY_RE.test(t) ? t : null;
}

/** How each harness reaches Eridani's MCP server on this machine (never a key). */
export function mcpWiring(dir: string, o: { home: string; env: NodeJS.ProcessEnv }): WiringRow[] {
  const rows: WiringRow[] = [];
  const spawn = resolveMcp(dir, null);
  const keyFile = globalKeyFile(dir);
  rows.push(spawn.configured
    ? { harness: 'spawn', state: 'ready', detail: `${spawn.url} with the key in ${keyFile}` }
    : { harness: 'spawn', state: 'NOT READY', detail: spawn.reason });
  const ep = mcpEndpoint(dir, loadEridaniConfig(dir)?.url ?? null);
  const key = readKeyFile(keyFile);
  for (const h of USER_HARNESSES) {
    const bin = which(h, o.env.PATH);
    if (!bin) {
      rows.push({ harness: h, state: 'not installed', detail: `\`${h}\` is not on PATH` });
      continue;
    }
    if (!('url' in ep) || !key) {
      const file = h === 'claude' ? claudeConfigFile(o.home, o.env) : h === 'codex' ? codexConfigFile(o.home, o.env) : opencodeConfigFile(o.home, o.env);
      const has = inspectEntry(h, o.home, o.env, '', '').state !== 'absent';
      rows.push({ harness: h, state: has ? 'present' : 'none', detail: `${has ? 'an eridani entry' : 'no eridani entry'} in ${file}; cannot compare (${'error' in ep ? ep.error : 'no valid MCP key file'})` });
      continue;
    }
    const ins = inspectEntry(h, o.home, o.env, ep.url, key);
    rows.push({
      harness: h,
      state: ins.state === 'same' ? 'ready' : ins.state === 'absent' ? 'none' : ins.state === 'differs' ? 'differs' : 'unreadable',
      detail: ins.state === 'same' ? `eridani entry in ${ins.file} (matches the MCP key file)`
        : ins.state === 'absent' ? `no eridani entry in ${ins.file} (remotea eridani setup --user-mcp)`
        : ins.state === 'differs' ? `eridani entry in ${ins.file}: ${ins.detail} (remotea eridani setup --user-mcp --replace)`
        : `${ins.file}: ${ins.detail}`,
    });
  }
  return rows;
}

export function fmtWiring(rows: WiringRow[]): string[] {
  return fmtTable([['HARNESS', 'STATE', 'DETAIL'], ...rows.map((r) => [r.harness, r.state, r.detail])]);
}

// ── Readiness ──────────────────────────────────────────────────────────────

/** launch-caps.ts's error for a launcher with no probe result. */
const NOT_PROBED = 'not probed yet';

/** One row per (target, check): launch per enabled harness, each verify entry, mcp. */
export function fmtReadiness(targets: HelloTarget[]): string[] {
  if (!targets.length) return ['no execution targets (add one with --add-repo, or remotea eridani targets add)'];
  const rows: string[][] = [['TARGET', 'CHECK', 'STATUS', 'DETAIL']];
  for (const t of targets) {
    const enabled = t.enabled ?? t.harnesses;
    if (!enabled.length) rows.push([t.id, 'launch', 'NOT READY', 'no harness enabled']);
    for (const h of enabled) {
      const l = t.launch?.[h];
      const unprobed = !l || (!l.ready && l.error === NOT_PROBED);
      rows.push([t.id, `launch ${h}`, unprobed ? 'not probed' : l.ready ? 'ready' : 'NOT READY', unprobed ? '' : l.ready ? l.version ?? '' : l.error ?? '']);
    }
    const verify = t.verify_status ?? t.verify.map((id) => ({ id, ready: true }));
    if (!verify.length) rows.push([t.id, 'verify', 'none', 'no verify entry: Eridani cannot run checks here']);
    for (const v of verify) rows.push([t.id, `verify ${v.id}`, v.ready ? 'ready' : 'NOT READY', 'reason' in v && v.reason ? v.reason : '']);
    rows.push([t.id, 'mcp', !t.mcp ? 'unknown' : t.mcp.configured ? 'ready' : 'NOT READY', t.mcp?.reason ?? '']);
    // S-Q3: the template's own problems (launch and verify have their rows above).
    if (t.template && !t.template.ready) rows.push([t.id, 'template', 'NOT READY', 'not advertised: Eridani starts nothing here']);
    for (const p of t.template?.problems ?? []) {
      if (p.check === 'launch' || p.check.startsWith('verify.')) continue;
      rows.push([t.id, p.check, p.level === 'fail' ? 'NOT READY' : 'warn', p.reason]);
    }
    if (t.prepare?.length) rows.push([t.id, 'prepare', 'ready', `a new worktree runs ${t.prepare.join(', ')} first`]);
  }
  return fmtTable(rows);
}

/**
 * The environment verify runs with: the installed unit's PATH (install.sh
 * writes `<node dir>:/usr/local/bin:/usr/bin:/bin`), so the readiness here
 * matches what the service will find.
 */
export function serviceEnv(home: string, env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; source: string } {
  const unit = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'remotea.service');
  const text = readText(unit);
  const m = text ? /^\s*Environment="?PATH=([^"\n]*)"?\s*$/m.exec(text) : null;
  const PATH = m ? m[1].trim() : `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  return { env: { PATH, HOME: home, LANG: env.LANG }, source: m ? unit : 'install.sh default' };
}

/** Targets as hello lists them, with mcp and the template check (S-Q3), from the given probes. */
export function localReadiness(dir: string, targets: ExecutionTarget[], probes: ReadonlyMap<string, LauncherProbe>, venv: NodeJS.ProcessEnv): HelloTarget[] {
  return withTemplate(helloTargets(targets, probes, { env: venv }), targets, { env: venv }).map((h) => {
    const t = targets.find((x) => x.id === h.id);
    return t ? { ...h, mcp: mcpStatus(resolveMcp(dir, t)) } : h;
  });
}

// ── Targets ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__']);

/** Git repositories (a `.git` folder, not a worktree's `.git` file) at or under each root, two levels deep. */
export function findRepos(roots: string[], skip: (p: string) => boolean = () => false, depth = 2): string[] {
  const found = new Set<string>();
  const isRepo = (p: string) => {
    try {
      return fs.statSync(path.join(p, '.git')).isDirectory();
    } catch {
      return false;
    }
  };
  const walk = (d: string, left: number) => {
    if (found.size >= 200 || skip(d)) return;
    if (isRepo(d)) {
      found.add(d);
      return;
    }
    if (left <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(d, e.name), left - 1);
    }
  };
  for (const r of roots) walk(path.resolve(r), depth);
  return [...found].sort();
}

/** A verify entry from what the repository has, or null. */
export function detectVerify(repo: string, timeout = DEFAULT_VERIFY_TIMEOUT): VerifySpec | null {
  const has = (f: string) => fs.existsSync(path.join(repo, f));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const t = pkg.scripts?.test;
    if (t && !/no test specified/.test(t)) return { id: 'test', argv: ['npm', 'test'], timeout };
  } catch {
    /* no package.json */
  }
  for (const mk of ['Makefile', 'makefile']) {
    if (/^test\s*:/m.test(readText(path.join(repo, mk)) ?? '')) return { id: 'test', argv: ['make', 'test'], timeout };
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) return { id: 'test', argv: has('uv.lock') ? ['uv', 'run', 'pytest'] : ['python3', '-m', 'pytest'], timeout };
  if (has('Cargo.toml')) return { id: 'test', argv: ['cargo', 'test'], timeout };
  if (has('go.mod')) return { id: 'test', argv: ['go', 'test', './...'], timeout };
  return null;
}

/** The branch new worktrees start from: origin's default, else the current branch, else main. */
export function detectBase(repo: string): string {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const origin = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  if (origin) return origin;
  const head = git(['symbolic-ref', '--short', 'HEAD']);
  return head || 'main';
}

function targetId(repo: string, taken: Set<string>): string {
  const base = (path.basename(repo).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '') || 'repo').slice(0, 60);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function parseVerifyFlags(list: string[], timeout: number): VerifySpec[] {
  return list.map((v) => {
    const eq = v.indexOf('=');
    if (eq < 1) throw new Error(`--verify ${v}: <id>=<command>`);
    return { id: v.slice(0, eq), argv: v.slice(eq + 1).trim().split(/\s+/).filter(Boolean), timeout };
  });
}

// ── The wizard ─────────────────────────────────────────────────────────────

export interface SetupReport {
  dryRun: boolean;
  changed: string[];
  unchanged: string[];
  skipped: string[];
  link: { url: string; machine: string; hostId: string | null; probed: boolean; eridaniCaps: string[]; serverRunning: boolean; state: string };
  readiness: HelloTarget[];
  mcp: WiringRow[];
  hooks: { installed: string | null; bundled: string | null; current: boolean };
}

export async function runSetup(o: SetupOptions, d: SetupDeps): Promise<SetupReport> {
  const say = o.json ? () => undefined : (s = '') => void d.out.write(`${s}\n`);
  const p: Prompter = o.yes || o.json ? noPrompter : d.prompt;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  const would = (s: string) => (o.dryRun ? `(dry run) would change: ${s}` : s);
  const dir = d.dir;

  // stdin `-` values are consumed in this order: code, link key, MCP key.
  let stdinAt = 0;
  const val = async (v: string | undefined): Promise<string | undefined> => {
    if (v !== '-') return v;
    const lines = (await d.stdinLines?.()) ?? [];
    const line = lines[stdinAt++];
    if (!line) throw new Error('a value given as - was not found on stdin');
    return line;
  };

  // ── Inputs first: nothing is written until every key has been checked ──
  const prev = loadEridaniConfig(dir);
  let code: SetupCode | null = null;
  const codeIn = await val(o.code);
  if (codeIn) code = parseSetupCode(codeIn);
  else if (p.interactive && !o.url && !o.linkKey) {
    const pasted = await p.secret('Setup code from Eridani (Enter to answer step by step)');
    if (pasted) code = parseSetupCode(pasted);
  }
  let url = o.url ?? code?.url ?? prev?.url;
  if (!url && p.interactive) url = await p.text('Eridani URL (https://<eridani> or its wss://…/agents/link URL)');
  if (!url) throw new Error(`no Eridani URL: pass --url or --code\n${SETUP_USAGE}`);
  url = normalizeLinkUrl(url);
  const urlErr = linkUrlError(url);
  if (urlErr) throw new Error(urlErr);
  let machine = o.machine ?? code?.machine ?? prev?.machine;
  if (!o.machine && !code?.machine && p.interactive) machine = (await p.text('Machine name for reports', machine ?? '')) || machine;

  const currentLinkKey = readEridaniToken(dir);
  let linkKey = (await val(o.linkKey)) ?? code?.link_key;
  if (!linkKey && p.interactive) linkKey = (await p.secret(currentLinkKey ? 'Link key (eri_bot_…; Enter keeps the current one)' : 'Link key (eri_bot_…)')) || undefined;
  linkKey ??= currentLinkKey ?? undefined;
  if (!linkKey) throw new Error('no link key: pass --link-key (or - to read it from stdin) or --code; mint one in Eridani, Settings → Connections');
  if (!ERIDANI_KEY_RE.test(linkKey)) throw new Error('that is not an Eridani link key (it starts with eri_bot_)');

  const keyFile = globalKeyFile(dir);
  const currentMcpRaw = readText(keyFile)?.trim() ?? null;
  const currentMcp = currentMcpRaw && ERIDANI_KEY_RE.test(currentMcpRaw) ? currentMcpRaw : null;
  let mcpKey = (await val(o.mcpKey)) ?? code?.mcp_key;
  if (!mcpKey && p.interactive) {
    mcpKey = (await p.secret(currentMcp ? 'MCP bot key for coding agents (Enter keeps the current one)' : 'MCP bot key for coding agents (a second eri_bot_ key; Enter to skip)')) || undefined;
  }
  if (mcpKey !== undefined) {
    if (!ERIDANI_KEY_RE.test(mcpKey)) throw new Error('that is not an Eridani bot key for MCP (it starts with eri_bot_)');
    if (mcpKey === linkKey) throw new Error('refused: the MCP key is the link key. Mint a separate bot key for MCP (scopes agents:session, tasks, notes) and pass that');
  } else if (currentMcp && currentMcp === linkKey) {
    throw new Error(`refused: ${keyFile} holds the link key. Mint a separate bot key for MCP and pass it with --mcp-key`);
  }

  // ── 1. Link ──
  say('1. Link');
  const machineName = machine || os.hostname();
  let hostId: string | null = null;
  let eridaniCaps: string[] = [];
  let probed = false;
  if (!o.noProbe) {
    const serverIdFile = path.join(dir, 'server-id');
    const serverId = readText(serverIdFile)?.trim() || (o.dryRun ? crypto.randomUUID() : ensureServerId(dir));
    const res = await d.probeLink(url, linkKey, { server_id: serverId, machine: machineName, version: d.version });
    hostId = res.hostId;
    eridaniCaps = res.caps ?? [];
    probed = true;
    say(`   Eridani accepted the key: ${hostId ? `host ${hostId}` : 'new host (registered when the server connects)'}`);
    say(`   Eridani caps: ${eridaniCaps.join(', ') || '-'}`);
  } else skipped.push('link probe (--no-probe): the key was not checked against Eridani');

  if (linkKey === currentLinkKey) unchanged.push(`link key (${path.join(dir, ERIDANI_TOKEN_FILE)})`);
  else {
    if (!o.dryRun) writeEridaniToken(dir, linkKey);
    changed.push(would(`link key written to ${path.join(dir, ERIDANI_TOKEN_FILE)} (0600)`));
  }
  const nextCfg: EridaniConfig = { enabled: true, url, machine: machine || undefined, collector: prev?.collector ?? 'parity' };
  if (prev && prev.enabled && prev.url === url && (prev.machine ?? undefined) === (nextCfg.machine ?? undefined)) unchanged.push(`link settings (enabled, ${url})`);
  else {
    if (!o.dryRun) saveEridaniConfig(dir, nextCfg);
    changed.push(would(`link settings in ${path.join(dir, 'eridani.json')}: enabled, ${url} as ${machineName}`));
  }
  const build = loadBuildInfo();
  const sha = (s: string) => (s === 'unknown' ? 'unknown' : s.slice(0, 12));
  const hv = hookVersion(d.hookPaths);
  const caps = nextCfg.collector === 'authoritative' ? STAGE_F_AUTHORITATIVE_CAPS : STAGE_F_CAPS;
  say(`   this build: ${sha(build.sha)}${build.dirty ? '+dirty' : ''}  proto ${ERIDANI_PROTO}  caps v${ERIDANI_CAPS_VERSION} [${caps.join(', ')}]  hooks ${hv.installed ?? 'not installed'}`);
  const running = await d.serverRunning();
  let state = running ? 'starting' : 'stopped';
  if (!running) say('   server: not running. The link starts when it does: systemctl --user start remotea (setup never starts or restarts it)');
  else {
    const info = readServerInfo(dir);
    const linkChanged = changed.length > 0 && !o.dryRun;
    if (linkChanged && o.wait > 0) {
      const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const since = Date.now();
      for (let waited = 0; waited < o.wait * 1000; waited += 500) {
        const l = readLinkStatus(dir);
        if (l && l.state === 'ready' && l.updatedAt >= since && pidAlive(l.pid)) break;
        await sleep(500);
      }
    }
    const l = readLinkStatus(dir);
    const fresh = !!l && l.enabled && pidAlive(l.pid) && l.url === url;
    state = fresh ? l!.state : 'starting';
    say(`   server: running${info ? ` build ${sha(info.build.sha)}${info.build.dirty ? '+dirty' : ''}` : ''}; link ${fresh ? `${l!.state}${l!.hostId ? ` (host ${l!.hostId})` : ''}` : 'picks the change up within 30 s'}`);
    if (fresh && l!.advertised) say(`   hello: build ${sha(l!.advertised.build_sha ?? 'unknown')}  caps v${l!.advertised.caps_version ?? 1} [${l!.advertised.caps.join(', ')}]  hooks ${l!.advertised.hook_version ?? 'not installed'}`);
    else if (linkChanged) say('   (remotea eridani status shows the hello once the server has reconnected; --wait <s> waits for it)');
  }

  // ── 2. Targets ──
  say('');
  say('2. Targets');
  const warn = (m: string) => say(`   warning: ${m}`);
  const existing = loadTargets(dir, warn);
  const targets = [...existing];
  for (const t of existing) {
    const hs = (['claude', 'codex'] as const).filter((h) => t.launch[h]);
    say(`   = ${t.id}  ${t.repo}  harnesses ${hs.join(', ') || 'none'}  verify ${t.verify.map((v) => v.id).join(', ') || 'none'}`);
  }
  // Bare launchers first: a new target enables the harnesses that answer.
  const probes = new Map<string, LauncherProbe>();
  const probeAll = async (list: Array<{ harness: ProbeHarness; bin: string }>) => {
    await Promise.all(list.filter((l) => !probes.has(probeKey(l.harness, l.bin))).map(async ({ harness, bin }) => {
      let r: LauncherProbe;
      try {
        r = await d.probe(harness, bin);
      } catch (err) {
        r = { ok: false, version: null, error: (err as Error).message };
      }
      probes.set(probeKey(harness, bin), r);
    }));
  };
  await probeAll(launchersToProbe([]));
  const working = (['claude', 'codex'] as const).filter((h) => probes.get(probeKey(h, h))?.ok);
  const flagVerify = parseVerifyFlags(o.verify, o.verifyTimeout);
  const covered = (repo: string) => targets.find((t) => path.resolve(t.repo) === path.resolve(repo));
  const taken = new Set(targets.map((t) => t.id));

  const addTarget = async (repo: string, id: string | undefined, ask: boolean): Promise<void> => {
    if (!fs.existsSync(path.join(repo, '.git'))) {
      skipped.push(`target for ${repo}: not a git repository`);
      return;
    }
    const have = covered(repo);
    if (have) {
      unchanged.push(`target ${have.id} (${repo})`);
      return;
    }
    let tid = id ?? targetId(repo, taken);
    let base = detectBase(repo);
    let root = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
    let harnesses: SpawnHarness[] = o.harnesses.length ? [...new Set(o.harnesses)] : working.length ? [...working] : ['claude'];
    const detected = detectVerify(repo, o.verifyTimeout);
    let verify: VerifySpec[] = flagVerify.length ? flagVerify : detected ? [detected] : [];
    if (ask) {
      tid = await p.text('   id', tid);
      base = await p.text('   base branch', base);
      root = path.resolve(await p.text('   worktree root', root));
      harnesses = (await p.text('   harnesses (claude, codex)', harnesses.join(','))).split(/[\s,]+/).filter((h): h is SpawnHarness => h === 'claude' || h === 'codex');
      // Enter keeps the bracketed default (the detected command, if any); "-" means no verify entry.
      const v = (await p.text(verify.length ? '   verify command (Enter keeps it, - for none)' : '   verify command (Enter for none)', verify[0]?.argv.join(' ') ?? '')).trim();
      verify = v && v !== '-' ? [{ id: verify[0]?.id ?? 'test', argv: v.split(/\s+/).filter(Boolean), timeout: o.verifyTimeout }] : [];
    }
    if (!TARGET_ID_RE.test(tid) || taken.has(tid)) throw new Error(`target id ${tid}: taken or not letters, digits, . _ -`);
    const launch: ExecutionTarget['launch'] = {};
    for (const h of harnesses.length ? harnesses : ['claude' as const]) launch[h] = {};
    const t: ExecutionTarget = { id: tid, repo, worktreeRoot: root, base, launch, verify };
    if (!o.dryRun) saveTarget(dir, t);
    else {
      const err = targetError(t);
      if (err) throw new Error(`invalid target: ${err}`);
    }
    targets.push(t);
    taken.add(tid);
    changed.push(would(`target ${tid}: ${repo}, worktrees in ${root}, base ${base}, harnesses ${Object.keys(launch).join(', ')}, verify ${verify.map((x) => `${x.id}=${x.argv.join(' ')}`).join('; ') || 'none'}`));
    say(`   + ${tid}  ${repo}`);
  };

  for (const spec of o.addRepo) {
    const eq = spec.indexOf('=');
    const id = eq > 0 && !spec.slice(0, eq).includes('/') ? spec.slice(0, eq) : undefined;
    const repo = path.resolve(id ? spec.slice(eq + 1) : spec);
    await addTarget(repo, id, false);
  }
  const roots = [...new Set([...o.scan.map((s) => path.resolve(s)), ...existing.map((t) => path.dirname(t.repo))])];
  const inWorktreeRoot = (p2: string) => targets.some((t) => p2 === t.worktreeRoot || p2.startsWith(`${t.worktreeRoot}${path.sep}`));
  const candidates = findRepos(roots, inWorktreeRoot).filter((r) => !covered(r));
  for (const repo of candidates) {
    if (p.interactive && (await p.confirm(`   Add ${repo} as an execution target?`, false))) await addTarget(repo, undefined, true);
    else skipped.push(`candidate repository ${repo} (not a target; add it with --add-repo ${repo})`);
  }
  if (!targets.length) skipped.push('targets: none configured, so Eridani cannot start work here (--add-repo <path>)');

  // ── 3. MCP for coding agents ──
  say('');
  say('3. MCP for coding agents');
  const ep = (() => {
    const file = readEridaniFile(dir);
    if (file.mcpUrl !== undefined) return mcpEndpoint(dir, url);
    const u = mcpUrlFromLink(url);
    return u ? { url: u } : { error: 'cannot derive the MCP URL from the link URL (set mcpUrl in eridani.json)' };
  })();
  let effectiveKey: string | null = null;
  if (mcpKey) {
    let mode: number | null = null;
    try {
      mode = fs.statSync(keyFile).mode & 0o777;
    } catch {
      /* none yet */
    }
    if (currentMcpRaw === mcpKey && mode === 0o600) unchanged.push(`MCP key file ${keyFile}`);
    else {
      if (!o.dryRun) writePrivate(keyFile, `${mcpKey}\n`);
      changed.push(would(currentMcpRaw === mcpKey ? `MCP key file ${keyFile}: mode set to 0600` : `MCP key written to ${keyFile} (0600)`));
    }
    effectiveKey = mcpKey;
  } else if (currentMcp) {
    unchanged.push(`MCP key file ${keyFile}`);
    effectiveKey = currentMcp;
  } else {
    skipped.push(`MCP key: none given and ${currentMcpRaw ? `${keyFile} does not hold an eri_bot_ key` : `no ${keyFile}`}; spawned agents get no Eridani tools (mint a bot key with agents:session, tasks, notes and pass --mcp-key)`);
  }
  if ('error' in ep) skipped.push(`MCP URL: ${ep.error}`);
  else say(`   endpoint ${ep.url}; key file ${keyFile}${effectiveKey ? '' : ' (no key)'}`);

  for (const h of USER_HARNESSES) {
    const bin = which(h, d.env.PATH);
    if (!bin) {
      skipped.push(`${h}: not installed (\`${h}\` is not on PATH), no user-level MCP entry`);
      continue;
    }
    if (!effectiveKey || 'error' in ep) {
      skipped.push(`${h}: user-level MCP entry needs the MCP key and URL`);
      continue;
    }
    const ins = inspectEntry(h, d.home, d.env, ep.url, effectiveKey);
    if (ins.state === 'same') {
      unchanged.push(`${h}: eridani MCP entry in ${ins.file}`);
      continue;
    }
    if (ins.state === 'unreadable') {
      skipped.push(`${h}: ${ins.file} cannot be read (${ins.detail}); not touched`);
      continue;
    }
    if (ins.state === 'differs' && !o.replace) {
      skipped.push(`${h}: ${ins.file} already has an eridani entry (${ins.detail}); not overwritten without --replace`);
      continue;
    }
    if (o.noUserMcp) {
      skipped.push(`${h}: user-level MCP entry not written (--no-user-mcp)`);
      continue;
    }
    say(`   ${h}: ${ins.state === 'absent' ? 'add' : 'replace'} the eridani entry`);
    for (const l of entryDiff(ins, plannedLines(h, ep.url, effectiveKey))) say(`     ${l}`);
    const yes = o.userMcp || (p.interactive && (await p.confirm(`   Write it to ${ins.file}?`, true)));
    if (!yes) {
      skipped.push(`${h}: user-level MCP entry not written (pass --user-mcp to write it)`);
      continue;
    }
    if (o.dryRun) {
      changed.push(would(`${h}: eridani MCP entry in ${ins.file}`));
      continue;
    }
    try {
      changed.push(await applyEntry(h, ins, ep.url, effectiveKey, d, bin));
    } catch (err) {
      skipped.push(`${h}: ${redact((err as Error).message)}`);
    }
  }

  // ── 4. Hooks ──
  say('');
  say('4. Hooks');
  const rows = hooksStatus(d.hookPaths);
  const present = rows.filter((r) => r.present);
  // Claude Code and Codex are what Eridani spawns; another agent without hooks
  // (Qwen's settings with comments are never rewritten) is reported, not chased.
  const missing = present.filter((r) => !r.entries && (r.agent === 'claude' || r.agent === 'codex'));
  const hookOk = !!hv.installed && hv.current !== false && missing.length === 0;
  say(`   helper ${hv.installed ?? 'not installed'}${hv.bundled ? ` (this checkout ships ${hv.bundled})` : ''}; agents ${present.map((r) => `${r.agent} ${r.entries ? 'hooked' : 'NOT hooked'}`).join(', ') || 'none found'}`);
  const why = !hv.installed ? 'not installed' : hv.current === false ? `stale (${hv.installed}, this checkout ships ${hv.bundled})` : `missing for ${missing.map((r) => r.agent).join(', ')}`;
  if (hookOk) unchanged.push(`hooks (helper ${hv.installed})`);
  else if (o.hooks) {
    if (o.dryRun) changed.push(would(`hooks: remotea hooks install (${why})`));
    else {
      try {
        installHooks(d.hookPaths);
        changed.push(`hooks installed (were ${why}): ${present.map((r) => r.file).join(', ')}`);
      } catch (err) {
        skipped.push(`hooks: install failed: ${(err as Error).message}`);
      }
    }
  } else {
    skipped.push(`hooks ${why}: run \`remotea hooks install\` (it edits ~/.claude/settings.json and the other agents' hook files; or rerun setup with --hooks)`);
    say('   run: remotea hooks install');
  }

  // ── Readiness (what hello sends) ──
  await probeAll(launchersToProbe(targets));
  const venv = serviceEnv(d.home, d.env);
  const readiness = o.dryRun
    ? helloTargets(targets, probes, { env: venv.env }).map((h) => ({ ...h, mcp: plannedMcp(dir, targets.find((t) => t.id === h.id)!, keyFile, effectiveKey, ep) }))
    : localReadiness(dir, targets, probes, venv.env);
  say('');
  say(`Readiness (what hello sends; verify checked against the service PATH from ${venv.source})`);
  for (const l of fmtReadiness(readiness)) say(`   ${l}`);

  const wiring = o.dryRun ? [] : mcpWiring(dir, { home: d.home, env: d.env });
  if (wiring.length) {
    say('');
    say('MCP wiring');
    for (const l of fmtWiring(wiring)) say(`   ${l}`);
  }

  say('');
  say(`${o.dryRun ? 'Would change' : 'Changed'} (${changed.length}):${changed.length ? '' : ' nothing'}`);
  for (const c of changed) say(`   + ${c.replace(/^\(dry run\) would change: /, '')}`);
  say(`Already right (${unchanged.length}):${unchanged.length ? '' : ' nothing'}`);
  for (const c of unchanged) say(`   = ${c}`);
  say(`Skipped (${skipped.length}):${skipped.length ? '' : ' nothing'}`);
  for (const c of skipped) say(`   - ${c}`);

  const report: SetupReport = {
    dryRun: o.dryRun,
    changed: changed.map(redact),
    unchanged: unchanged.map(redact),
    skipped: skipped.map(redact),
    link: { url, machine: machineName, hostId, probed, eridaniCaps, serverRunning: running, state },
    readiness,
    mcp: wiring,
    hooks: { installed: hv.installed, bundled: hv.bundled, current: hookOk },
  };
  if (o.json) d.out.write(JSON.stringify(report, null, 2) + '\n');
  return report;
}

/** Dry run: the mcp state the target would have once the planned key file is written. */
function plannedMcp(dir: string, t: ExecutionTarget, globalFile: string, key: string | null, ep: { url: string } | { error: string }): McpStatus {
  if (t.mcpKeyFile && keyFilePath(dir, t.mcpKeyFile) !== globalFile) return mcpStatus(resolveMcp(dir, t));
  if ('error' in ep) return { configured: false, reason: ep.error };
  return key ? { configured: true } : { configured: false, reason: `no MCP key file at ${globalFile}` };
}

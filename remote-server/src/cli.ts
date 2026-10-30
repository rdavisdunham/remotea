#!/usr/bin/env node
/**
 * `remotea` — the server-side CLI (runs in WSL next to the server).
 *
 *   remotea status [--json]        sessions, groups and server state (reads the registry; no token needed)
 *   remotea doctor [--json] [--probe]
 *                                  one redacted readiness report: service, build, listener, collector, link,
 *                                  hooks, targets, disk, uploads, recovery (doctor.ts); exit 1 when a check fails
 *   remotea open --group <name> [--cwd <dir>] [--title <t>] [--id surf-…] [--json] -- <cmd…>
 *                                  create a session in a workspace group (created if missing) and run
 *                                  <cmd…> once its shell is ready; every connected app places it as a tab
 *   remotea close <surf-id>        end a session on every device
 *   remotea upgrade [--yes] [--timeout <s>] [--unit <name>] [--json]
 *                                  drain, restart the server unit only, and check the PTY keeper's sessions
 *                                  came back (S-Q5, upgrade.ts; docs/remotea/upgrade.md)
 *   remotea token                  print the access token for the app's Settings → Remote hosts
 *   remotea rotate-token           issue a new token; the running server closes every connection that used the
 *                                  old one (sessions keep running) until each app is given the new one
 *   remotea hooks install|remove|status
 *                                  register wmux's hook helper with Claude Code and Codex in this WSL,
 *                                  so agents report their status to the apps (see hook-bridge.ts)
 *   remotea hooks --remove-legacy-collector [--dry-run]
 *                                  collector cutover: strip only the Python collector's SessionStart hook
 *   remotea logs [-f] [--device <name>] [--surf <id>] [--kind <prefix>] [--since <10m>] [--json]
 *                                  diagnostics the apps sent (connection, reattach, agent state; no content)
 *   remotea screen <surf-id>       print what a session's screen shows right now
 *   remotea eridani connect|status|disconnect|collect|collector|targets|worktrees
 *                                  the link to Eridani (see eridani-cli.ts)
 *
 * `status --json` is a stable contract for other tools (STATUS_VERSION below).
 * Additions are backwards compatible; a breaking change bumps the version.
 *
 * The version is also the collector cutover's interlock (stage E). While
 * `eridani.json.collector` is `authoritative`, status --json says version 2;
 * otherwise 1. The Python collector (~/jarvis/scripts/session_collector)
 * reads only version 1: on v2 it keeps its last known terminals and says
 * "remotea status unavailable" on every run. So a forgotten Python timer
 * after the cutover cannot learn about new remotea terminals, and the
 * message in its journal points at the timer that should be off. It is a
 * tripwire, not a lock: disabling the timer is still the cutover's step.
 * v2 has the same fields as v1; nothing else changes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import WebSocket from 'ws';
import { LEGACY_TIMER_HINT, configDir, ensureToken, loadConfig, loadEridaniConfig, rotateToken, type CollectorMode, type ServerConfig } from './config';
import { UploadStore, fmtBytes, readUploadsStatus, type UploadUsage } from './upload';
import { diagDir } from './diag-log';
import { defaultHookPaths, hooksStatus, installHooks, removeHooks, removeLegacyCollectorHooks, type HookTarget, type LegacyRemoval } from './hooks-install';
import { hookVersion, loadBuildInfo, readServerInfo, type BuildInfo, type HookVersion } from './build-info';
import { ERIDANI_CAPS_VERSION, ERIDANI_PROTO } from '../../src/shared/eridani-link-protocol';
import type { RegistryData } from './registry';
import { eridaniCommand, statusBlock } from './eridani-cli';
import { doctorCommand } from './doctor';
import { fmtKeeper, observeKeeperStatus, type KeeperObservation } from './pty-backend';
import { upgrade } from './upgrade';
import { PROTO, parseServerMsg, type AgentStateInfo, type ServerMsg, type SessionRecord, type VerifyAttemptStatus } from '../../src/shared/remote-host-protocol';

/** status --json while the collector is authoritative (the cutover interlock, above). */
export const STATUS_VERSION = 2;
/** status --json otherwise: what the Python collector reads. */
export const STATUS_VERSION_PARITY = 1;

/** The version status --json reports for this collector mode (null: no Eridani link set up). */
export function statusVersion(mode: CollectorMode | null | undefined): number {
  return mode === 'authoritative' ? STATUS_VERSION : STATUS_VERSION_PARITY;
}

export interface StatusSession {
  id: string;
  groupId: string | null;
  groupName: string | null;
  state: SessionRecord['state'];
  title: string | null;
  cwd: string;
  lastCwd: string | null;
  cmd: string | null;
  agent: { provider: string; sessionId: string } | null;
  createdAt: number;
  createdBy: string;
  createdByName: string | null;
  lastActivityAt: number | null;
  exitCode: number | null;
  hiddenOn: string[];
  /** Added with the Eridani link (additive): the server's agent state, and the process generation. */
  agentState: AgentStateInfo | null;
  incarnation: number;
  turnSeq: number;
  /** Stage C (additive): the Eridani run this session belongs to, null for any other session. */
  eridani: { runId: string; generation: number; taskId: string | null } | null;
  worktree: string | null;
  branch: string | null;
  /** A stop Eridani requested and the process has not yet been seen to exit. */
  stopRequested: { at: number; mode: 'interrupt' | 'kill' } | null;
  /** Stage D (additive): the latest verification attempt, null when none ran. */
  verify: { attemptId: string; state: VerifyAttemptStatus['state']; startedAt: number | null } | null;
  /** S-Q5 (additive): the PTY keeper holds this session's process (it survives a server restart). */
  inKeeper: boolean;
}

export interface StatusOutput {
  version: number;
  server: {
    serverId: string | null;
    hostname: string;
    configDir: string;
    port: number;
    running: boolean;
    epoch: string | null;
    eridani: ReturnType<typeof statusBlock>;
    /** Stage E (additive): `eridani.json.collector`, null when the link was never set up. */
    collector: CollectorMode | null;
    /**
     * S-S5 (additive): the RUNNING server's build, from the server-info.json
     * it wrote at start; null when it is not running or predates this.
     * `sha` is "unknown" for a build without git (or before build-info).
     */
    build: (BuildInfo & { pid: number; startedAt: number; version: string }) | null;
    /** The build on disk (dist/build-info.json): what a restart would run. Differs from `build` after a rebuild without a restart. */
    diskBuild: BuildInfo;
    /** The Eridani link protocol and capability shape this build speaks (hello's proto and caps_version). */
    proto: number;
    capsVersion: number;
    /** The hook helper agents run (`installed`), the one this checkout ships (`bundled`), and whether they match. */
    hooks: HookVersion;
    /** S-Q5 (additive): the PTY keeper (docs/remotea/upgrade.md), as an observer sees it. */
    ptyKeeper: KeeperObservation;
  };
  groups: Array<{ id: string; name: string; color: string | null }>;
  sessions: StatusSession[];
  /** S-S3 (additive): pasted/dropped files in /tmp/remotea-drop-*, against their budget. */
  uploads: StatusUploads;
}

export type StatusUploads = Pick<UploadUsage, 'bytes' | 'files' | 'budget' | 'maxAgeDays' | 'tempDir' | 'freeBytes' | 'freeRatio' | 'degraded' | 'at'>;

function readRegistry(dir: string): RegistryData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')) as RegistryData;
  } catch {
    return null;
  }
}

function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

export async function buildStatus(dir: string): Promise<StatusOutput> {
  const config = loadConfig(dir);
  const reg = readRegistry(dir);
  let serverId: string | null = null;
  try {
    serverId = fs.readFileSync(path.join(dir, 'server-id'), 'utf8').trim() || null;
  } catch {
    /* never started */
  }
  const groups = Object.values(reg?.groups ?? {});
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const sessions: StatusSession[] = Object.values(reg?.sessions ?? {}).map((s) => ({
    id: s.id,
    groupId: s.groupId,
    groupName: s.groupId ? groupName.get(s.groupId) ?? null : null,
    state: s.state,
    title: s.title ?? null,
    cwd: s.cwd,
    lastCwd: s.lastCwd ?? null,
    cmd: s.cmd ?? null,
    agent: s.agent ? { provider: s.agent.provider, sessionId: s.agent.sessionId } : null,
    createdAt: s.createdAt,
    createdBy: s.createdBy,
    createdByName: reg?.devices[s.createdBy]?.name ?? null,
    lastActivityAt: s.lastActivityAt ?? null,
    exitCode: s.exitCode ?? null,
    hiddenOn: s.hiddenBy.map((d) => reg?.devices[d]?.name ?? d),
    agentState: s.agentState ?? null,
    incarnation: s.incarnation ?? 0,
    turnSeq: s.turnSeq ?? 0,
    eridani: s.eridani ? { runId: s.eridani.runId, generation: s.eridani.generation, taskId: s.eridani.taskId } : null,
    worktree: s.eridani?.worktree ?? null,
    branch: s.eridani?.branch ?? null,
    stopRequested: s.eridani?.stopRequested ? { at: s.eridani.stopRequested.at, mode: s.eridani.stopRequested.mode } : null,
    verify: s.verify ? { attemptId: s.verify.attemptId, state: s.verify.state, startedAt: s.verify.startedAt } : null,
    inKeeper: false,
  }));
  const ptyKeeper = await observeKeeperStatus(dir, config.ptyKeeper);
  const kept = new Set(ptyKeeper.ids);
  for (const s of sessions) s.inKeeper = kept.has(s.id);
  sessions.sort((a, b) => a.createdAt - b.createdAt);
  const running = await healthy(config.port);
  const collector = loadEridaniConfig(dir)?.collector ?? null;
  const info = running ? readServerInfo(dir) : null;
  return {
    version: statusVersion(collector),
    server: {
      serverId, hostname: os.hostname(), configDir: dir, port: config.port, running, epoch: reg?.epoch ?? null, eridani: statusBlock(dir, running), collector,
      build: info ? { ...info.build, pid: info.pid, startedAt: info.startedAt, version: info.version } : null,
      diskBuild: loadBuildInfo(),
      proto: ERIDANI_PROTO,
      capsVersion: ERIDANI_CAPS_VERSION,
      hooks: hookVersion(defaultHookPaths()),
      ptyKeeper,
    },
    groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color ?? null })),
    sessions,
    uploads: uploadsStatus(dir, config, running),
  };
}

/**
 * S-S3: pasted/dropped files. What the running server last wrote
 * (uploads-status.json); otherwise measured here, with the configured budget.
 */
export function uploadsStatus(dir: string, config: ServerConfig, running: boolean): StatusUploads {
  const written = running ? readUploadsStatus(dir) : null;
  const u = written ?? new UploadStore({ budgetBytes: config.uploadBudgetMiB * 1024 * 1024, maxAgeMs: config.uploadMaxAgeDays * 24 * 60 * 60 * 1000 }).usage();
  return { bytes: u.bytes, files: u.files, budget: u.budget, maxAgeDays: u.maxAgeDays, tempDir: u.tempDir, freeBytes: u.freeBytes, freeRatio: u.freeRatio, degraded: u.degraded, at: u.at };
}

/** One line: the running build, the one on disk when it differs, and the hook helper. */
export function fmtBuild(s: Pick<StatusOutput['server'], 'build' | 'diskBuild' | 'hooks' | 'proto' | 'capsVersion'>): string {
  const short = (b: BuildInfo) => (b.sha === 'unknown' ? 'unknown' : `${b.sha.slice(0, 12)}${b.dirty ? '+dirty' : ''}`);
  const running = s.build ? `build ${short(s.build)}` : 'build of the running server unknown';
  const disk = !s.build || s.build.sha !== s.diskBuild.sha || s.build.dirty !== s.diskBuild.dirty ? `; on disk ${short(s.diskBuild)}${s.build ? ' (restart to run it)' : ''}` : '';
  const hooks = s.hooks.installed ? `hooks ${s.hooks.installed}${s.hooks.current === false ? ' (stale: run `remotea hooks install`)' : ''}` : 'hooks not installed';
  return `${running}${disk}; proto ${s.proto} caps v${s.capsVersion}; ${hooks}`;
}

/** POSIX-shell quote one argument for typing into an interactive shell. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

interface OpenArgs {
  group: string;
  cwd?: string;
  title?: string;
  id?: string;
  json: boolean;
  command: string[];
}

export function parseOpenArgs(argv: string[]): OpenArgs {
  const dash = argv.indexOf('--');
  const flags = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const out: OpenArgs = { group: '', json: false, command };
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const val = () => {
      const v = flags[++i];
      if (v === undefined) throw new Error(`${f} needs a value`);
      return v;
    };
    if (f === '--group') out.group = val();
    else if (f === '--cwd') out.cwd = val();
    else if (f === '--title') out.title = val();
    else if (f === '--id') out.id = val();
    else if (f === '--json') out.json = true;
    else throw new Error(`unknown option ${f}`);
  }
  if (!out.group) throw new Error('--group <name> is required');
  if (out.id && !/^surf-[A-Za-z0-9_-]{1,96}$/.test(out.id)) throw new Error('--id must look like surf-<id>');
  return out;
}

/** The CLI's device identity: stable per machine user, distinct from any app. */
function cliDevice(): { id: string; name: string } {
  const h = crypto.createHash('sha256').update(`cli:${os.hostname()}:${os.userInfo().username}`).digest('hex').slice(0, 16);
  return { id: `cli-${h}`, name: `remotea CLI (${os.hostname()})` };
}

interface ServerLink {
  welcome: Extract<ServerMsg, { t: 'welcome' }>;
  send(msg: unknown): void;
  next(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>;
  close(): void;
}

/** Connect to the local server as the CLI device and complete the hello. */
async function connectLocal(dir: string): Promise<ServerLink> {
  const config = loadConfig(dir);
  const token = ensureToken(dir);
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`, { headers: { Authorization: `Bearer ${token}` } });
  const inbox: ServerMsg[] = [];
  let wake: (() => void) | null = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = parseServerMsg(JSON.parse(String(data)));
    if (msg) {
      inbox.push(msg);
      wake?.();
    }
  });
  const next = async (pred: (m: ServerMsg) => boolean, ms = 10_000): Promise<ServerMsg> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for the server');
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, left);
      });
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_q, res) => reject(new Error(`server refused the connection (HTTP ${res.statusCode})`)));
    ws.once('error', (err) => reject(new Error(`cannot reach the remotea server on 127.0.0.1:${config.port}: ${err.message}`)));
  });
  ws.send(JSON.stringify({ t: 'hello', proto: PROTO, device: cliDevice(), app: { name: 'remotea-cli', version: '1' } }));
  const welcome = await next((m) => m.t === 'welcome' || m.t === 'error').catch((err) => {
    ws.close();
    throw err;
  });
  if (welcome.t !== 'welcome') {
    ws.close();
    throw new Error(welcome.t === 'error' ? welcome.message : 'unexpected reply');
  }
  return { welcome, send: (m) => ws.send(JSON.stringify(m)), next, close: () => ws.close() };
}

async function closeSession(dir: string, id: string): Promise<void> {
  if (!/^surf-[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error('expected a session id like surf-…');
  const link = await connectLocal(dir);
  try {
    link.send({ t: 'close', rid: 1, id });
    const ack = await link.next((m) => m.t === 'ack' && m.rid === 1);
    if (ack.t === 'ack' && !ack.ok) throw new Error(ack.error ?? 'close failed');
  } finally {
    link.close();
  }
}

async function openSession(dir: string, args: OpenArgs): Promise<{ id: string; groupId: string; created: boolean }> {
  const link = await connectLocal(dir);
  const { welcome, next } = link;
  try {
    const wanted = args.group.trim().toLowerCase();
    const existing = welcome.groups.find((g) => g.name.trim().toLowerCase() === wanted);
    const groupId = existing?.id ?? `grp-${crypto.randomUUID()}`;
    const id = args.id ?? `surf-${crypto.randomUUID()}`;
    const command = args.command.map(shellQuote).join(' ');
    link.send({
      t: 'open', rid: 1, id, cols: 120, rows: 32,
      create: {
        cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
        groupId,
        group: { name: existing?.name ?? args.group.trim() },
        title: args.title,
        startupCommands: command ? [command] : undefined,
      },
    });
    const reply = await next((m) => (m.t === 'opened' || m.t === 'openError') && m.id === id);
    if (reply.t === 'openError') throw new Error(reply.message);
    if (reply.t !== 'opened') throw new Error('unexpected reply');
    // Startup commands are typed by the server once the shell is ready; we can leave now.
    link.send({ t: 'detach', ids: [id] });
    return { id, groupId, created: reply.created || !!reply.wasLost };
  } finally {
    link.close();
  }
}

/** What a session's screen shows now: attach read-only, render the snapshot, detach. */
async function screenOf(dir: string, id: string): Promise<{ lines: string[]; cols: number; rows: number }> {
  if (!/^surf-[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error('expected a session id like surf-…');
  const link = await connectLocal(dir);
  try {
    // Attaching never claims the size (only focus or typing in an app does).
    link.send({ t: 'open', rid: 1, id, cols: 80, rows: 24 });
    const reply = await link.next((m) => (m.t === 'opened' || m.t === 'openError') && m.id === id);
    if (reply.t === 'openError') throw new Error(reply.message);
    if (reply.t !== 'opened') throw new Error('unexpected reply');
    link.send({ t: 'detach', ids: [id] });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
    const term = new Terminal({ cols: reply.cols, rows: reply.rows, scrollback: 0, allowProposedApi: true });
    await new Promise<void>((r) => term.write(reply.snapshot ?? '', r));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < term.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    term.dispose();
    return { lines, cols: reply.cols, rows: reply.rows };
  } finally {
    link.close();
  }
}

interface LogArgs {
  follow: boolean;
  device?: string;
  surf?: string;
  kind?: string;
  sinceMs?: number;
  json: boolean;
}

export function parseLogArgs(argv: string[]): LogArgs {
  const out: LogArgs = { follow: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${f} needs a value`);
      return v;
    };
    if (f === '-f' || f === '--follow') out.follow = true;
    else if (f === '--json') out.json = true;
    else if (f === '--device') out.device = val().toLowerCase();
    else if (f === '--surf') out.surf = val();
    else if (f === '--kind') out.kind = val();
    else if (f === '--since') {
      const m = /^(\d+)([smhd])$/.exec(val());
      if (!m) throw new Error('--since takes a duration like 30s, 10m, 2h or 1d');
      out.sinceMs = Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's' | 'm' | 'h' | 'd'];
    } else throw new Error(`unknown option ${f}`);
  }
  return out;
}

type LogLine = { at: number; device?: string; src?: string; kind?: string; surf?: string; data?: Record<string, unknown> };

function fmtLog(e: LogLine): string {
  const t = new Date(e.at);
  const time = `${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  const fields = Object.entries(e.data ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${String(v)}`).join(' ');
  const surf = e.surf ? ` ${e.surf.slice(0, 13)}` : '';
  return `${time} ${(e.device ?? '?').slice(0, 14).padEnd(14)} ${(e.src === 'renderer' ? 'R' : 'M')} ${(e.kind ?? '').padEnd(16)}${surf} ${fields}`;
}

async function showLogs(args: LogArgs): Promise<void> {
  const dir = diagDir();
  const since = args.sinceMs ? Date.now() - args.sinceMs : 0;
  const keep = (e: LogLine) => e.at >= since
    && (!args.device || (e.device ?? '').toLowerCase().includes(args.device))
    && (!args.surf || (e.surf ?? '').startsWith(args.surf))
    && (!args.kind || (e.kind ?? '').startsWith(args.kind));
  const print = (e: LogLine) => process.stdout.write((args.json ? JSON.stringify(e) : fmtLog(e)) + '\n');
  const offsets = new Map<string, number>();
  const readNew = (): LogLine[] => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
    const out: LogLine[] = [];
    for (const f of files) {
      const from = offsets.get(f) ?? 0;
      let text = '';
      try {
        const size = fs.statSync(f).size;
        if (size < from) offsets.set(f, 0); // rotated
        const fd = fs.openSync(f, 'r');
        const len = size - (size < from ? 0 : from);
        const b = Buffer.alloc(Math.max(0, len));
        fs.readSync(fd, b, 0, b.length, size < from ? 0 : from);
        fs.closeSync(fd);
        text = b.toString('utf8');
        const lastNl = text.lastIndexOf('\n');
        text = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
        offsets.set(f, (size < from ? 0 : from) + Buffer.byteLength(text));
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as LogLine);
        } catch {
          /* torn line */
        }
      }
    }
    return out.filter(keep).sort((a, b) => a.at - b.at);
  };
  const first = readNew();
  if (!first.length && !args.follow) process.stderr.write(`no diagnostics yet in ${dir}\n`);
  first.forEach(print);
  if (!args.follow) return;
  await new Promise<never>(() => {
    setInterval(() => readNew().forEach(print), 500);
  });
}

function fmtHooks(rows: HookTarget[]): string {
  return rows.map((r) => `${r.agent.padEnd(7)} ${!r.present ? 'not installed here' : r.entries ? `${r.entries} remotea hook entries` : 'no remotea hooks'}  ${r.file}`).join('\n') + '\n';
}

/** What `remotea hooks --remove-legacy-collector` did, and the timer step it leaves to the person. */
export function fmtLegacyRemoval(r: LegacyRemoval): string {
  const lines: string[] = [];
  if (!r.removed.length) lines.push(`no Python collector hook in ${r.file}`);
  else {
    lines.push(`${r.dryRun ? 'would remove' : 'removed'} from SessionStart in ${r.file}:`);
    for (const c of r.removed) lines.push(`  ${c}`);
    if (!r.dryRun) lines.push(`(the file before the first remotea change is kept as ${r.file}.remotea-backup)`);
  }
  if (r.timerUnit) {
    lines.push(`the Python collector's timer is installed (${r.timerUnit}); turn it off with:`);
    lines.push(`  ${LEGACY_TIMER_HINT}`);
  }
  return lines.join('\n') + '\n';
}

function fmtAge(ms: number | null): string {
  if (!ms) return '-';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function parseUpgradeArgs(argv: string[]): { yes: boolean; json: boolean; unit?: string; timeoutMs?: number } {
  const out: { yes: boolean; json: boolean; unit?: string; timeoutMs?: number } = { yes: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${f} needs a value`);
      return v;
    };
    if (f === '--yes' || f === '-y') out.yes = true;
    else if (f === '--json') out.json = true;
    else if (f === '--unit') out.unit = val();
    else if (f === '--timeout') {
      const n = Number(val());
      if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout takes seconds');
      out.timeoutMs = n * 1000;
    } else throw new Error(`unknown option ${f} (usage: remotea upgrade [--yes] [--timeout <s>] [--unit <name>] [--json])`);
  }
  return out;
}

const USAGE = `usage:
  remotea status [--json]
  remotea doctor [--json] [--probe]                             readiness report (ok/warn/fail per check; exit 1 on a fail)
  remotea upgrade [--yes] [--timeout <s>] [--unit <name>] [--json]
                                                                drain, restart the server only, check the sessions came back
  remotea open --group <name> [--cwd <dir>] [--title <t>] [--id surf-...] [--json] -- <command...>
  remotea close <surf-id>
  remotea token
  remotea rotate-token
  remotea hooks install|remove|status [--json]
  remotea hooks --remove-legacy-collector [--dry-run]             cutover: strip the Python collector's SessionStart hook
  remotea logs [-f] [--device <name>] [--surf <id>] [--kind <prefix>] [--since <10m>] [--json]
  remotea screen <surf-id>
  remotea eridani connect [--url <wss://…>] [--machine <name>] | status [--json] | disconnect [--forget] | collect [--dry-run] [--days N]
  remotea eridani collector [parity|authoritative]              show or switch the collector mode (prints the cutover checklist)
  remotea eridani targets list [--json] | add … | remove <id>     where Eridani may start work
  remotea eridani worktrees [--json]                            managed worktrees and unmerged work (never removes)`;

export async function main(argv: string[]): Promise<number> {
  const dir = configDir();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'doctor':
      return doctorCommand(dir, rest);
    case 'upgrade': {
      const args = parseUpgradeArgs(rest);
      const json = args.json;
      const res = await upgrade({
        dir, yes: args.yes, unit: args.unit, timeoutMs: args.timeoutMs,
        healthy: () => healthy(loadConfig(dir).port),
        out: json ? () => {} : (l) => process.stdout.write(l + '\n'),
      });
      if (json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return res.ok ? 0 : 1;
    }
    case 'status': {
      const status = await buildStatus(dir);
      if (rest.includes('--json')) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        return 0;
      }
      process.stdout.write(`server ${status.server.running ? 'running' : 'NOT running'} on port ${status.server.port} (${status.server.hostname})\n`);
      process.stdout.write(`${fmtBuild(status.server)}\n`);
      process.stdout.write(`${fmtKeeper(status.server.ptyKeeper)}\n`);
      for (const s of status.sessions) {
        const what = s.agent ? `${s.agent.provider} ${s.agent.sessionId.slice(0, 8)}` : s.cmd ?? 'shell';
        process.stdout.write(`${s.state.padEnd(6)} ${(s.groupName ?? '-').slice(0, 20).padEnd(20)} ${what.slice(0, 24).padEnd(24)} active ${fmtAge(s.lastActivityAt).padStart(4)}  ${s.lastCwd ?? s.cwd}  ${s.id}\n`);
      }
      if (!status.sessions.length) process.stdout.write('no sessions\n');
      const u = status.uploads;
      process.stdout.write(`uploads ${fmtBytes(u.bytes)} in ${u.files} file(s) of ${fmtBytes(u.budget)}, kept up to ${u.maxAgeDays} day(s)${u.degraded ? `; DEGRADED: ${u.degraded}` : ''}\n`);
      return 0;
    }
    case 'open': {
      const args = parseOpenArgs(rest);
      const res = await openSession(dir, args);
      process.stdout.write(args.json ? JSON.stringify(res) + '\n' : `${res.id}\n`);
      return 0;
    }
    case 'close':
      await closeSession(dir, rest[0] ?? '');
      return 0;
    case 'token':
      process.stdout.write(ensureToken(dir) + '\n');
      return 0;
    case 'hooks': {
      if (rest.includes('--remove-legacy-collector')) {
        process.stdout.write(fmtLegacyRemoval(removeLegacyCollectorHooks(undefined, { dryRun: rest.includes('--dry-run') })));
        return 0;
      }
      const sub = rest[0] ?? 'status';
      if (sub === 'install') {
        const rows = installHooks();
        process.stdout.write(fmtHooks(rows));
        process.stdout.write('new agent sessions in remotea terminals now report their status to the apps\n');
      } else if (sub === 'remove') process.stdout.write(fmtHooks(removeHooks()));
      else if (sub === 'status') process.stdout.write(rest.includes('--json') ? JSON.stringify(hooksStatus()) + '\n' : fmtHooks(hooksStatus()));
      else throw new Error('usage: remotea hooks install|remove|status | --remove-legacy-collector [--dry-run]');
      return 0;
    }
    case 'logs':
      await showLogs(parseLogArgs(rest));
      return 0;
    case 'screen': {
      const shot = await screenOf(dir, rest[0] ?? '');
      process.stdout.write(`── ${rest[0]} (${shot.cols}x${shot.rows}) ──\n${shot.lines.join('\n')}\n`);
      return 0;
    }
    case 'eridani':
      return eridaniCommand(dir, rest, () => healthy(loadConfig(dir).port));
    case 'rotate-token':
      process.stdout.write(rotateToken(dir) + '\n');
      process.stderr.write('token rotated: the old token is revoked and apps using it are disconnected (sessions keep running).\nUpdate it in every app\'s Settings → Remote hosts to reconnect.\n');
      return 0;
    default:
      process.stderr.write(USAGE + '\n');
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`remotea: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}

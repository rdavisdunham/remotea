#!/usr/bin/env node
/**
 * `remotea` — the server-side CLI (runs in WSL next to the server).
 *
 *   remotea status [--json]        sessions, groups and server state (reads the registry; no token needed)
 *   remotea open --group <name> [--cwd <dir>] [--title <t>] [--id surf-…] [--json] -- <cmd…>
 *                                  create a session in a workspace group (created if missing) and run
 *                                  <cmd…> once its shell is ready; every connected app places it as a tab
 *   remotea close <surf-id>        end a session on every device
 *   remotea token                  print the access token for the app's Settings → Remote hosts
 *   remotea rotate-token           issue a new token (connected apps must be given the new one)
 *
 * `status --json` is a stable contract for other tools (STATUS_VERSION below).
 * Additions are backwards compatible; a breaking change bumps the version.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import WebSocket from 'ws';
import { configDir, ensureToken, loadConfig, rotateToken } from './config';
import type { RegistryData } from './registry';
import { PROTO, parseServerMsg, type ServerMsg, type SessionRecord } from '../../src/shared/remote-host-protocol';

export const STATUS_VERSION = 1;

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
  };
  groups: Array<{ id: string; name: string; color: string | null }>;
  sessions: StatusSession[];
}

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
  }));
  sessions.sort((a, b) => a.createdAt - b.createdAt);
  return {
    version: STATUS_VERSION,
    server: { serverId, hostname: os.hostname(), configDir: dir, port: config.port, running: await healthy(config.port), epoch: reg?.epoch ?? null },
    groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color ?? null })),
    sessions,
  };
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

function fmtAge(ms: number | null): string {
  if (!ms) return '-';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const USAGE = `usage:
  remotea status [--json]
  remotea open --group <name> [--cwd <dir>] [--title <t>] [--id surf-...] [--json] -- <command...>
  remotea close <surf-id>
  remotea token
  remotea rotate-token`;

export async function main(argv: string[]): Promise<number> {
  const dir = configDir();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'status': {
      const status = await buildStatus(dir);
      if (rest.includes('--json')) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        return 0;
      }
      process.stdout.write(`server ${status.server.running ? 'running' : 'NOT running'} on port ${status.server.port} (${status.server.hostname})\n`);
      for (const s of status.sessions) {
        const what = s.agent ? `${s.agent.provider} ${s.agent.sessionId.slice(0, 8)}` : s.cmd ?? 'shell';
        process.stdout.write(`${s.state.padEnd(6)} ${(s.groupName ?? '-').slice(0, 20).padEnd(20)} ${what.slice(0, 24).padEnd(24)} active ${fmtAge(s.lastActivityAt).padStart(4)}  ${s.lastCwd ?? s.cwd}  ${s.id}\n`);
      }
      if (!status.sessions.length) process.stdout.write('no sessions\n');
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
    case 'rotate-token':
      process.stdout.write(rotateToken(dir) + '\n');
      process.stderr.write('token rotated: update it in every app\'s Settings → Remote hosts\n');
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

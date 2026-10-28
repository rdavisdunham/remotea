/**
 * `remotea eridani …`: set up and inspect the link to Eridani.
 *
 *   connect [--url <wss://…>] [--machine <name>] [--no-probe]
 *       Asks for the link key (hidden, on a terminal; read from stdin when
 *       piped), checks it is an `eri_bot_` key, proves it with one hello →
 *       welcome against the URL, then writes `eridani-token` (0600) and
 *       enables the link in `eridani.json`. The running server picks the
 *       change up within 30 s; nothing restarts.
 *   status [--json]      the link as the running server last wrote it
 *   disconnect [--forget]
 *       disables the link; --forget also deletes the key
 *   collect [--dry-run] [--days N]
 *       --dry-run prints what the collector would report (like collector.py
 *       --dry-run); without it, asks the running server for a scan now
 *
 * The key never appears in output, logs or the status file.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import {
  ERIDANI_COLLECT_REQUEST,
  ERIDANI_KEY_RE,
  ensureServerId,
  forgetEridaniToken,
  loadEridaniConfig,
  readEridaniToken,
  saveEridaniConfig,
  writeEridaniToken,
  type EridaniConfig,
} from './config';
import { ERIDANI_PROTO, ERIDANI_SUBPROTOCOL, ERIDANI_TIMING, STAGE_B_CAPS, parseDownFrame } from '../../src/shared/eridani-link-protocol';
import { readLinkStatus, type LinkStatus } from './eridani-link';
import { Collector, formatRows } from './collector/collector';
import { CollectorState } from './collector/state';
import { statusFromRegistry } from './collector/report';
import { WINDOWS_USERS, serverVersion } from './eridani-runtime';
import type { RegistryData } from './registry';
import { loadTargets, removeTarget, saveTarget, type ExecutionTarget, type VerifySpec } from './eridani-targets';
import { WorktreeManager, cleanupCommands } from './worktrees';

export interface EridaniSummary {
  enabled: boolean;
  url: string | null;
  machine: string;
  collector: string;
  keyPresent: boolean;
  /** The link's state as the running server reports it; 'stopped' when no server is running it. */
  state: string;
  link: LinkStatus | null;
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

export function eridaniSummary(dir: string, serverRunning: boolean): EridaniSummary {
  const cfg = loadEridaniConfig(dir);
  const link = readLinkStatus(dir);
  const enabled = !!cfg?.enabled;
  const fresh = !!link && serverRunning && link.enabled && pidAlive(link.pid);
  return {
    enabled,
    url: cfg?.url ?? null,
    machine: cfg?.machine ?? os.hostname(),
    collector: cfg?.collector ?? 'parity',
    keyPresent: readEridaniToken(dir) !== null,
    state: !enabled ? 'disabled' : fresh ? link!.state : 'stopped',
    link: fresh ? link : null,
  };
}

/** The additive `server.eridani` block of `remotea status --json`. */
export function statusBlock(dir: string, serverRunning: boolean): { enabled: boolean; state: string; unacked: number; lastAckAt: number | null } {
  const s = eridaniSummary(dir, serverRunning);
  return { enabled: s.enabled, state: s.state, unacked: s.link?.unacked ?? 0, lastAckAt: s.link?.lastAckAt ?? null };
}

/** Read the key without echoing it (terminal) or from stdin (pipe). */
async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) {
      data += chunk;
      if (data.length > 4096) break;
    }
    return data.trim();
  }
  process.stderr.write('Eridani link key (eri_bot_…): ');
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let key = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
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

/**
 * One hello → welcome against `url` with `key`. Resolves with Eridani's host id;
 * rejects with a sentence a person can act on.
 */
export function probeLink(url: string, key: string, hello: { server_id: string; machine: string; version: string }, timeoutMs: number = ERIDANI_TIMING.probeMs): Promise<{ hostId: string; connEpoch: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, [ERIDANI_SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': `remotea-server/${hello.version}` },
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
    });
    const finish = (err: Error | null, value?: { hostId: string; connEpoch: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* gone */
      }
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`no welcome from ${url} within ${timeoutMs / 1000} s`)), timeoutMs);
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      finish(new Error(code === 401 || code === 403 ? `Eridani refused the key (HTTP ${code})` : `Eridani answered HTTP ${code}`));
    });
    ws.on('error', (err) => finish(new Error(`cannot reach ${url}: ${err.message}`)));
    ws.on('close', (code) => finish(new Error(code === 4401 || code === 4403 ? 'Eridani refused the key' : `Eridani closed the connection (${code})`)));
    ws.on('open', () => {
      ws.send(JSON.stringify({
        v: 1, id: crypto.randomUUID(), conn_epoch: null, at: Date.now(), t: 'hello',
        server_id: hello.server_id, boot_id: `probe-${crypto.randomUUID()}`, hostname: os.hostname(), machine: hello.machine,
        proto: ERIDANI_PROTO, version: hello.version, caps: [...STAGE_B_CAPS], harnesses: {},
      }));
    });
    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      const f = parseDownFrame(raw);
      if (f?.t !== 'welcome') return;
      const w = f as unknown as { host_id: string; conn_epoch: number };
      try {
        ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), conn_epoch: w.conn_epoch, at: Date.now(), t: 'bye', reason: 'probe' }));
      } catch {
        /* closing anyway */
      }
      finish(null, { hostId: w.host_id, connEpoch: w.conn_epoch });
    });
  });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function readRegistry(dir: string): RegistryData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')) as RegistryData;
  } catch {
    return null;
  }
}

function fmtTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString() : '-';
}

export async function eridaniCommand(dir: string, args: string[], serverRunning: () => Promise<boolean>, out = process.stdout): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'connect': {
      const prev = loadEridaniConfig(dir);
      const url = flag(rest, '--url') ?? prev?.url;
      if (!url) throw new Error('usage: remotea eridani connect --url wss://<eridani>/api/v1/external/agents/link [--machine <name>]');
      if (!/^wss?:\/\//.test(url)) throw new Error('the link URL starts with wss:// (ws:// only for a local test)');
      const machine = flag(rest, '--machine') ?? prev?.machine;
      const key = await readKey();
      if (!ERIDANI_KEY_RE.test(key)) throw new Error('that is not an Eridani link key (it starts with eri_bot_)');
      if (!rest.includes('--no-probe')) {
        const res = await probeLink(url, key, { server_id: ensureServerId(dir), machine: machine || os.hostname(), version: serverVersion() });
        out.write(`Eridani accepted the key (host ${res.hostId})\n`);
      }
      writeEridaniToken(dir, key);
      const cfg: EridaniConfig = { enabled: true, url, machine, collector: prev?.collector ?? 'parity' };
      saveEridaniConfig(dir, cfg);
      out.write(`link enabled: ${url} as ${machine || os.hostname()} (collector ${cfg.collector}); the server connects within 30 s\n`);
      return 0;
    }
    case 'status': {
      const s = eridaniSummary(dir, await serverRunning());
      if (rest.includes('--json')) {
        out.write(JSON.stringify(s, null, 2) + '\n');
        return 0;
      }
      if (!s.url) {
        out.write('not set up: run `remotea eridani connect --url wss://…`\n');
        return 0;
      }
      out.write(`link ${s.state}  ${s.url}  as ${s.machine}  collector ${s.collector}  key ${s.keyPresent ? 'present' : 'MISSING'}\n`);
      const l = s.link;
      if (l) {
        out.write(`host ${l.hostId ?? '-'}  epoch ${l.connEpoch ?? '-'}  last connected ${fmtTime(l.lastConnectedAt)}  last ack ${fmtTime(l.lastAckAt)}\n`);
        out.write(`outbox ${l.unacked} unacked, ${l.spool.entries} entries, ${Math.round(l.spool.fill * 100)}% full${l.dirty ? `, ${l.dirty} to re-read` : ''}${l.degraded ? `, DEGRADED: ${l.degraded}` : ''}\n`);
        if (l.error) out.write(`error: ${l.error}\n`);
        if (l.rejected) out.write(`refused by Eridani: ${l.rejected} (last: ${l.lastRejection})\n`);
      }
      return 0;
    }
    case 'disconnect': {
      const prev = loadEridaniConfig(dir);
      if (prev) saveEridaniConfig(dir, { ...prev, enabled: false });
      if (rest.includes('--forget')) forgetEridaniToken(dir);
      out.write(`link disabled${rest.includes('--forget') ? ' and key deleted' : ''}; the server disconnects within 30 s\n`);
      return 0;
    }
    case 'collect': {
      const daysArg = flag(rest, '--days');
      const days = daysArg !== undefined ? Number(daysArg) : undefined;
      if (days !== undefined && !(days > 0)) throw new Error('--days takes a positive number');
      if (rest.includes('--dry-run')) {
        const cfg = loadEridaniConfig(dir);
        const reg = readRegistry(dir);
        const collector = new Collector({
          machine: cfg?.machine,
          home: process.env.REMOTEA_COLLECTOR_HOME || undefined,
          windowsUsers: process.env.REMOTEA_COLLECTOR_HOME ? null : WINDOWS_USERS,
          state: new CollectorState(null),
          status: () => (reg ? statusFromRegistry(reg, os.hostname()) : null),
          warn: (m) => process.stderr.write(`${m}\n`),
        });
        const res = await collector.scan({ dryRun: true, days });
        out.write(formatRows(res.rows, days ?? 7));
        return 0;
      }
      if (!(await serverRunning())) throw new Error('the server is not running');
      if (!loadEridaniConfig(dir)?.enabled) throw new Error('the link is not enabled (remotea eridani connect)');
      fs.writeFileSync(path.join(dir, ERIDANI_COLLECT_REQUEST), String(Date.now()), { mode: 0o600 });
      out.write('scan requested; the server runs it within 30 s\n');
      return 0;
    }
    case 'targets':
      return targetsCommand(dir, rest, out);
    case 'worktrees':
      return worktreesCommand(dir, rest, out);
    default:
      process.stderr.write(`usage: remotea eridani connect [--url <wss://…>] [--machine <name>] | status [--json] | disconnect [--forget] | collect [--dry-run] [--days N]
       remotea eridani targets list [--json] | add --id <id> --repo <path> --worktree-root <path> [--base <branch>] [--claude] [--codex] [--verify <id>=<command>]… [--verify-timeout <s>] | add --json '<target>' | remove <id>
       remotea eridani worktrees [--json]\n`);
      return sub === undefined ? 0 : 2;
  }
}

/** Every value of a repeated flag. */
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
    out.push(v);
  }
  return out;
}

/**
 * `remotea eridani targets`: where Eridani may start work (eridani-targets.ts).
 * A verify command is split on spaces into a fixed argv and runs with no
 * shell; for quoting or anything unusual, `add --json` takes the whole target.
 */
function targetsCommand(dir: string, args: string[], out: NodeJS.WritableStream): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list': {
      const list = loadTargets(dir, (m) => process.stderr.write(`${m}\n`));
      if (rest.includes('--json')) {
        out.write(JSON.stringify(list, null, 2) + '\n');
        return 0;
      }
      if (!list.length) {
        out.write('no execution targets: add one with `remotea eridani targets add`\n');
        return 0;
      }
      for (const t of list) {
        const harnesses = (['claude', 'codex'] as const).filter((h) => t.launch[h]).join(', ') || 'none';
        out.write(`${t.id}  ${t.repo}  worktrees in ${t.worktreeRoot}  base ${t.base}  harnesses ${harnesses}\n`);
        for (const v of t.verify) out.write(`  verify ${v.id}: ${v.argv.join(' ')}${v.cwd ? ` (in ${v.cwd})` : ''}, ${v.timeout} s\n`);
      }
      return 0;
    }
    case 'add': {
      let target: ExecutionTarget;
      const json = flag(rest, '--json');
      if (json) {
        target = JSON.parse(json) as ExecutionTarget;
      } else {
        const id = flag(rest, '--id');
        const repo = flag(rest, '--repo');
        const root = flag(rest, '--worktree-root');
        if (!id || !repo || !root) throw new Error('targets add needs --id, --repo and --worktree-root (or --json)');
        const timeout = Number(flag(rest, '--verify-timeout') ?? 600);
        const verify: VerifySpec[] = flags(rest, '--verify').map((v) => {
          const eq = v.indexOf('=');
          if (eq < 1) throw new Error(`--verify ${v}: <id>=<command>`);
          return { id: v.slice(0, eq), argv: v.slice(eq + 1).trim().split(/\s+/).filter(Boolean), timeout };
        });
        const launch: ExecutionTarget['launch'] = {};
        if (rest.includes('--claude')) launch.claude = {};
        if (rest.includes('--codex')) launch.codex = {};
        if (!launch.claude && !launch.codex) launch.claude = {};
        target = { id, repo: path.resolve(repo), worktreeRoot: path.resolve(root), base: flag(rest, '--base') ?? 'main', launch, verify };
      }
      if (!fs.existsSync(path.join(target.repo ?? '', '.git'))) throw new Error(`${target.repo} is not a git repository`);
      saveTarget(dir, target);
      out.write(`target ${target.id} saved; it applies to the next spawn (no restart)\n`);
      return 0;
    }
    case 'remove': {
      const id = rest[0];
      if (!id) throw new Error('targets remove <id>');
      out.write(removeTarget(dir, id) ? `target ${id} removed (its worktrees stay on disk)\n` : `no target ${id}\n`);
      return 0;
    }
    default:
      throw new Error(`unknown targets command ${sub}`);
  }
}

/**
 * `remotea eridani worktrees`: every managed worktree, with what would be
 * lost by removing it. Nothing is ever removed: a candidate gets the commands
 * that would, recovery ref first, for a person to run.
 */
async function worktreesCommand(dir: string, args: string[], out: NodeJS.WritableStream): Promise<number> {
  const targets = loadTargets(dir, (m) => process.stderr.write(`${m}\n`));
  const reg = readRegistry(dir);
  const active = new Set(Object.values(reg?.sessions ?? {}).filter((r) => r.eridani && r.state !== 'exited').map((r) => r.eridani!.worktree));
  const rows = await new WorktreeManager({ dir }).nominate(targets, (p) => active.has(p));
  if (args.includes('--json')) {
    out.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  if (!rows.length) {
    out.write('no managed worktrees\n');
    return 0;
  }
  for (const r of rows) {
    out.write(`${r.candidate ? 'candidate ' : 'keep      '} ${r.target}  ${r.branch ?? '(detached)'}  ${r.path}\n`);
    if (r.reasons.length) out.write(`           ${r.reasons.join('; ')}\n`);
    if (r.candidate) {
      const t = targets.find((x) => x.id === r.target);
      if (t) for (const c of cleanupCommands(t.repo, r)) out.write(`           $ ${c}\n`);
    }
  }
  return 0;
}

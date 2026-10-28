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
    default:
      process.stderr.write('usage: remotea eridani connect [--url <wss://…>] [--machine <name>] | status [--json] | disconnect [--forget] | collect [--dry-run] [--days N]\n');
      return sub === undefined ? 0 : 2;
  }
}

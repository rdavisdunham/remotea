/**
 * `remotea upgrade` (S-Q5, docs/remotea/upgrade.md): drain, restart the
 * server unit only, and check that the sessions came back.
 *
 *   1. The running server must support drain (server-info.json `features`).
 *      Without the PTY keeper holding sessions the restart ends them: that
 *      needs `--yes`.
 *   2. Drain: DRAIN_REQUEST_FILE, SIGUSR2, then wait for DRAIN_STATUS_FILE of
 *      this boot to say `settled` (or `timeout`).
 *   3. Restart the unit (`systemctl --user restart remotea`); the keeper's
 *      own unit is not touched.
 *   4. Wait for a new boot to answer, then compare: every session the keeper
 *      held running must be `live` in the new boot with the same incarnation.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { readServerInfo, type ServerInfo } from './build-info';
import type { RegistryData } from './registry';
import { DEFAULT_DRAIN_TIMEOUT_MS, readDrainStatus, writeDrainRequest, type DrainStatus } from './drain';
import { observeKeeperStatus, type KeeperObservation } from './pty-backend';

export interface UpgradeOptions {
  dir: string;
  /** How long the drain may wait for work under way. */
  timeoutMs?: number;
  /** Go ahead even when the restart would end sessions. */
  yes?: boolean;
  unit?: string;
  out?: (line: string) => void;
  /** Is the server answering /healthz? */
  healthy: () => Promise<boolean>;
  /** Tests: how the server is restarted (default `systemctl --user restart <unit>`). */
  restart?: () => Promise<void>;
  /** Tests: how the server is signalled. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** How long to wait for the new boot. */
  bootWaitMs?: number;
  observe?: (dir: string, enabled: boolean) => Promise<KeeperObservation>;
}

export interface UpgradeResult {
  ok: boolean;
  oldBoot: string;
  newBoot: string | null;
  drain: DrainStatus | null;
  /** Sessions the keeper held running before, with their incarnation. */
  before: Array<{ id: string; incarnation: number; title: string | null }>;
  survived: string[];
  lost: Array<{ id: string; why: string }>;
  /** Live sessions the server ran in process: they end with the restart. */
  inProcess: string[];
}

function readRegistry(dir: string): RegistryData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')) as RegistryData;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function systemctlRestart(unit: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'restart', unit], { timeout: 60_000, encoding: 'utf8' }, (err, _o, stderr) => {
      if (err) reject(new Error(`systemctl --user restart ${unit} failed: ${String(stderr || err.message).trim().split('\n')[0]}`));
      else resolve();
    });
  });
}

export async function upgrade(o: UpgradeOptions): Promise<UpgradeResult> {
  const out = o.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const unit = o.unit ?? 'remotea';
  const timeoutMs = o.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const config = loadConfig(o.dir);
  if (!(await o.healthy())) throw new Error(`the server is not running on port ${config.port}; start it with: systemctl --user start ${unit}`);
  const info: ServerInfo | null = readServerInfo(o.dir);
  if (!info) throw new Error('cannot read server-info.json of the running server');

  const keeper = await (o.observe ?? observeKeeperStatus)(o.dir, config.ptyKeeper);
  const reg = readRegistry(o.dir);
  const live = Object.values(reg?.sessions ?? {}).filter((s) => s.state === 'live' && s.bootId === info.bootId);
  const held = new Set(keeper.aliveIds);
  const before = live.filter((s) => held.has(s.id)).map((s) => ({ id: s.id, incarnation: s.incarnation ?? 0, title: s.title ?? null }));
  const inProcess = live.filter((s) => !held.has(s.id)).map((s) => s.id);
  out(`server pid ${info.pid}, boot ${info.bootId.slice(0, 8)}; ${keeper.running ? `pty keeper pid ${keeper.pid} holds ${before.length} running session(s)` : 'no pty keeper'}`);
  if (inProcess.length) {
    out(`${inProcess.length} session(s) run inside the server and will END with the restart${config.ptyKeeper ? ' (started before the keeper was on, or while it was unreachable)' : ' (ptyKeeper is off in config.json)'}; the apps respawn them and agents resume`);
    if (!o.yes) throw new Error('not restarting: pass --yes to restart anyway');
  }

  let drain: DrainStatus | null = null;
  if (info.features?.includes('drain')) {
    writeDrainRequest(o.dir, { at: Date.now(), timeoutMs, reason: 'restart' });
    (o.signal ?? ((pid, sig) => process.kill(pid, sig)))(info.pid, 'SIGUSR2');
    out(`draining (up to ${Math.round(timeoutMs / 1000)} s): Eridani's new commands are held for the next server`);
    const until = Date.now() + timeoutMs + 10_000;
    for (;;) {
      const s = readDrainStatus(o.dir);
      if (s && s.bootId === info.bootId && (s.state === 'settled' || s.state === 'timeout')) {
        drain = s;
        break;
      }
      if (Date.now() > until) throw new Error('the server did not report its drain; nothing was restarted');
      await sleep(100);
    }
    if (drain.state === 'settled') out('drained: nothing under way');
    else {
      const what = [...drain.waiting.commands.map((c) => `${c.t} ${c.op_id}`), ...drain.waiting.writes.map((w) => `write on ${w}`)];
      out(`drain timed out; still under way (Eridani is told after the restart): ${what.join(', ')}`);
    }
  } else {
    out('the running server predates drain (no `drain` in server-info.json): restarting without it');
    if (!o.yes) throw new Error('not restarting: pass --yes to restart without a drain');
  }

  out(`restarting ${unit}`);
  await (o.restart ?? (() => systemctlRestart(unit)))();

  const until = Date.now() + (o.bootWaitMs ?? 60_000);
  let next: ServerInfo | null = null;
  for (;;) {
    next = readServerInfo(o.dir);
    if (next && next.bootId !== info.bootId && (await o.healthy())) break;
    if (Date.now() > until) {
      out('the new server did not come up in time');
      return { ok: false, oldBoot: info.bootId, newBoot: null, drain, before, survived: [], lost: before.map((b) => ({ id: b.id, why: 'no new server' })), inProcess };
    }
    await sleep(200);
  }
  const after = readRegistry(o.dir);
  const survived: string[] = [];
  const lost: Array<{ id: string; why: string }> = [];
  for (const b of before) {
    const r = after?.sessions[b.id];
    if (!r) lost.push({ id: b.id, why: 'gone from the registry' });
    else if (r.state !== 'live' || r.bootId !== next.bootId) lost.push({ id: b.id, why: r.state === 'exited' ? `exited (${r.exitCode ?? '?'})` : r.state });
    else if ((r.incarnation ?? 0) !== b.incarnation) lost.push({ id: b.id, why: `respawned (incarnation ${b.incarnation} → ${r.incarnation ?? 0})` });
    else survived.push(b.id);
  }
  out(`new server pid ${next.pid}, boot ${next.bootId.slice(0, 8)}, build ${next.build.sha === 'unknown' ? 'unknown' : next.build.sha.slice(0, 12)}`);
  out(`survived: ${survived.length} of ${before.length} session(s)`);
  for (const id of survived) {
    const b = before.find((x) => x.id === id)!;
    out(`  ${id}  incarnation ${b.incarnation}${b.title ? `  ${b.title}` : ''}`);
  }
  for (const l of lost) out(`  NOT reattached: ${l.id}: ${l.why}`);
  return { ok: lost.length === 0, oldBoot: info.bootId, newBoot: next.bootId, drain, before, survived, lost, inProcess };
}

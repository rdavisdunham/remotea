#!/usr/bin/env node
/**
 * remotea-server entry point. Normally run by the `remotea` systemd user
 * service (see systemd/remotea.service and scripts/install.sh).
 */
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { configDir, ensureHookSecret, ensureServerId, ensureToken, loadConfig, resolveBind, watchTokenFile } from './config';
import { Registry } from './registry';
import { Hub } from './hub';
import { RemoteaServer } from './server';
import { PtyBackend } from './pty-backend';
import { Drainer } from './drain';
import { HookBridge, hookEnv } from './hook-bridge';
import { DiagLog, diagDir } from './diag-log';
import { defaultHookPaths, hooksStatus, installHooks, toAgentStatus } from './hooks-install';
import { runFsOp } from './remote-fs';
import { EridaniRuntime, serverVersion } from './eridani-runtime';
import { loadBuildInfo, serverInfo, writeServerInfo } from './build-info';
import { UPLOADS_STATUS_FILE, UploadStore } from './upload';

const DAY = 24 * 60 * 60 * 1000;
const BIND_RETRY_MS = 5_000;
const UPLOAD_SWEEP_MS = 10 * 60 * 1000;

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

async function main(): Promise<void> {
  const dir = configDir();
  const config = loadConfig(dir);
  const tokenFile = path.join(dir, 'token');
  let token = ensureToken(dir);
  const serverId = ensureServerId(dir);
  const bootId = crypto.randomUUID();

  const registry = Registry.load({
    file: path.join(dir, 'registry.json'),
    bootId,
    exitedRetentionMs: config.exitedRetentionDays * DAY,
    tombstoneRetentionMs: config.tombstoneDays * DAY,
  });
  const hookSecret = ensureHookSecret(dir);
  const diag = new DiagLog(diagDir());
  const build = loadBuildInfo();
  const version = serverVersion();
  // S-Q5: sessions in the PTY keeper outlive a restart of this server (docs/remotea/upgrade.md).
  const ptys = new PtyBackend({
    dir,
    enabled: config.ptyKeeper,
    idleMs: Math.max(1, config.ptyKeeperIdleMinutes) * 60_000,
    ringBytes: config.ringBytes,
    version: `${version}+${build.sha.slice(0, 12)}`,
    log,
  });
  const hub = new Hub({
    registry,
    spawn: ptys.spawn,
    bootId,
    serverId,
    hostname: os.hostname(),
    config: { resumeAgents: config.resumeAgents, scrollback: config.scrollback, snapshotScrollback: config.snapshotScrollback, ringBytes: config.ringBytes },
    log,
    sessionEnv: config.hookPort
      ? (id) => hookEnv(hookSecret, config.hookPort, id, { cliPath: path.join(defaultHookPaths().cliDir, 'wmux.js'), nodePath: process.execPath })
      : undefined,
    diag: (device, events) => diag.write(device, events),
    hooks: { status: () => toAgentStatus(hooksStatus()), install: () => toAgentStatus(installHooks()) },
    fs: runFsOp,
  });
  // The bridge comes up before the Eridani runtime exists; its held methods answer as "not remote" until then.
  let eridaniRt: EridaniRuntime | null = null;
  const bridge = new HookBridge({
    secret: hookSecret,
    relay: (id, method, params) => hub.relayRpc(id, method, params),
    question: (id, params, closed) => eridaniRt?.questions.hold(id, params, closed) ?? Promise.resolve({ reason: 'not-remote' }),
    approval: (id, params, closed) => eridaniRt?.questions.holdApproval(id, params, closed) ?? Promise.resolve({ reason: 'not-remote' }),
    context: (id, params) => eridaniRt?.context.sessionStart(id, params) ?? Promise.resolve(''),
    log,
  });
  if (config.hookPort) {
    // Loopback only. Sessions started before the bridge came up still report once it does.
    bridge.listen(config.hookPort).then(
      (port) => log(`hook bridge on 127.0.0.1:${port}`),
      (err) => log(`hook bridge unavailable on 127.0.0.1:${config.hookPort}: ${(err as Error).message}`),
    );
  }
  // Re-read the token on every handshake so `remotea rotate-token` takes effect without a restart, and
  // when the file changes (watchTokenFile below), so the rotation also closes sockets admitted with the old one.
  // S-S3: pasted/dropped files are held to a budget and an age; usage goes to uploads-status.json.
  const uploads = new UploadStore({
    budgetBytes: Math.max(1, config.uploadBudgetMiB) * 1024 * 1024,
    maxAgeMs: Math.max(0, config.uploadMaxAgeDays) * DAY,
    isLive: (surf) => hub.isLive(surf),
    statusFile: path.join(dir, UPLOADS_STATUS_FILE),
    log,
  });
  uploads.tick();
  const server = new RemoteaServer({
    hub,
    uploads,
    token: () => {
      try {
        token = ensureToken(dir);
      } catch {
        /* keep the last good one */
      }
      return token;
    },
    log,
  });
  server.checkToken();

  // The Eridani side is wired into the hub before the keeper's sessions are adopted, so an exit
  // that happened while no server ran reaches dispatch like any other. It starts after.
  // REMOTEA_COLLECTOR_HOME points the collector at another home (tests and the e2e); it then skips /mnt/c.
  const collectorHome = process.env.REMOTEA_COLLECTOR_HOME || undefined;
  const eridani = new EridaniRuntime({
    dir, hub, registry, serverId, bootId, hostname: os.hostname(), version, build, log,
    collectorHome, windowsUsers: collectorHome ? null : undefined, resumeAgents: config.resumeAgents,
  });
  eridaniRt = eridani;

  // Before anyone connects: take back what the PTY keeper kept.
  const adopted = await ptys.start();
  if (adopted.length) {
    const r = hub.adopt(adopted, ptys.discard);
    log(`pty keeper: ${r.adopted.length} session(s) reattached, ${r.exited.length} exited while no server ran, ${r.discarded.length} closed meanwhile and hung up`);
  }

  // `remotea rotate-token` only writes the file; this is how the running server learns of it. Rotation is
  // revocation: connections admitted with the old token are closed (4401 "token rotated"), sessions stay.
  const tokenWatch = watchTokenFile(dir, () => server.checkToken());

  const bindAll = async () => {
    const { addresses, pending } = resolveBind(config.bind);
    for (const host of addresses) {
      if (server.listening(host)) continue;
      try {
        await server.listen(host, config.port);
        log(`listening on ws://${host.includes(':') ? `[${host}]` : host}:${config.port}`);
      } catch (err) {
        log(`cannot bind ${host}:${config.port} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); retrying`);
        pending.push(host);
      }
    }
    return pending;
  };

  const pending = await bindAll();
  if (pending.length) {
    log(`waiting for ${pending.join(', ')}`);
    const retry = setInterval(async () => {
      if ((await bindAll()).length === 0) clearInterval(retry);
    }, BIND_RETRY_MS);
  }

  // What is running now (S-S5): `remotea status` compares it with the build on disk.
  try {
    writeServerInfo(dir, serverInfo({ bootId, version, build }));
  } catch (err) {
    log(`cannot write server-info.json: ${(err as Error).message}`);
  }
  log(`remotea-server ${version} build ${build.sha}${build.dirty ? ' (dirty)' : ''} ${serverId} boot ${bootId}; ${registry.sessions().length} session(s) in registry; token at ${tokenFile}`);

  // The Eridani link: constructed only while eridani.json enables it; follows the file (30 s).
  eridani.start();

  // S-Q5: `remotea upgrade` asks for a drain with SIGUSR2 (drain.ts).
  const drainer = new Drainer({
    dir,
    bootId,
    target: () => eridani,
    flush: () => {
      registry.saveNow();
      eridani.current?.writeStatusNow();
    },
    log,
  });
  process.on('SIGUSR2', () => drainer.requested());

  const lagTimer = setInterval(() => hub.pumpLagging(), 250);
  const probeTimer = setInterval(() => hub.probeAgents(), 5_000);
  const pruneTimer = setInterval(() => hub.prune(), 60 * 60 * 1000);
  const uploadTimer = setInterval(() => uploads.tick(), UPLOAD_SWEEP_MS);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: shutting down`);
    clearInterval(lagTimer);
    clearInterval(probeTimer);
    clearInterval(pruneTimer);
    clearInterval(uploadTimer);
    tokenWatch.close();
    drainer.dispose();
    // Keeper-held sessions are handed over (checkpoint, then let go); the rest are hung up.
    const kept = await Promise.race([hub.shutdown(), new Promise<string[]>((r) => setTimeout(() => r([]), 5_000))]);
    if (kept.length) log(`${kept.length} session(s) left running in the pty keeper`);
    eridani.stop();
    await ptys.stop();
    await Promise.all([server.close(), bridge.close()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});

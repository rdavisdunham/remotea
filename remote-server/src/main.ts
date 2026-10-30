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
import { spawnPty } from './pty-spawn';
import { HookBridge, hookEnv } from './hook-bridge';
import { DiagLog, diagDir } from './diag-log';
import { defaultHookPaths, hooksStatus, installHooks, toAgentStatus } from './hooks-install';
import { runFsOp } from './remote-fs';
import { EridaniRuntime, serverVersion } from './eridani-runtime';
import { loadBuildInfo, serverInfo, writeServerInfo } from './build-info';

const DAY = 24 * 60 * 60 * 1000;
const BIND_RETRY_MS = 5_000;

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
  const hub = new Hub({
    registry,
    spawn: spawnPty,
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
  const server = new RemoteaServer({
    hub,
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
  const build = loadBuildInfo();
  const version = serverVersion();
  try {
    writeServerInfo(dir, serverInfo({ bootId, version, build }));
  } catch (err) {
    log(`cannot write server-info.json: ${(err as Error).message}`);
  }
  log(`remotea-server ${version} build ${build.sha}${build.dirty ? ' (dirty)' : ''} ${serverId} boot ${bootId}; ${registry.sessions().length} session(s) in registry; token at ${tokenFile}`);

  // The Eridani link: constructed only while eridani.json enables it; follows the file (30 s).
  // REMOTEA_COLLECTOR_HOME points the collector at another home (tests and the e2e); it then skips /mnt/c.
  const collectorHome = process.env.REMOTEA_COLLECTOR_HOME || undefined;
  const eridani = new EridaniRuntime({
    dir, hub, registry, serverId, bootId, hostname: os.hostname(), version, build, log,
    collectorHome, windowsUsers: collectorHome ? null : undefined, resumeAgents: config.resumeAgents,
  });
  eridaniRt = eridani;
  eridani.start();

  const lagTimer = setInterval(() => hub.pumpLagging(), 250);
  const probeTimer = setInterval(() => hub.probeAgents(), 5_000);
  const pruneTimer = setInterval(() => hub.prune(), 60 * 60 * 1000);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: shutting down`);
    clearInterval(lagTimer);
    clearInterval(probeTimer);
    clearInterval(pruneTimer);
    tokenWatch.close();
    hub.shutdown();
    eridani.stop();
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

#!/usr/bin/env node
/**
 * remotea-server entry point. Normally run by the `remotea` systemd user
 * service (see systemd/remotea.service and scripts/install.sh).
 */
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { configDir, ensureServerId, ensureToken, loadConfig, resolveBind } from './config';
import { Registry } from './registry';
import { Hub } from './hub';
import { RemoteaServer } from './server';
import { spawnPty } from './pty-spawn';

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
  const hub = new Hub({
    registry,
    spawn: spawnPty,
    bootId,
    serverId,
    hostname: os.hostname(),
    config: { scrollback: config.scrollback, snapshotScrollback: config.snapshotScrollback, ringBytes: config.ringBytes },
    log,
  });
  // Re-read the token on every handshake so `remotea rotate-token` takes effect without a restart.
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

  log(`remotea-server ${serverId} boot ${bootId}; ${registry.sessions().length} session(s) in registry; token at ${tokenFile}`);

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
    hub.shutdown();
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});

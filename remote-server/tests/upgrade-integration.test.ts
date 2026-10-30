/**
 * S-Q5 end to end: the real server (compiled here into a temp dir) with
 * `ptyKeeper: true`, real PTYs in a real keeper process, a fake Eridani.
 *
 *   A: open a shell session, write a marker; SIGTERM A (hand-over).
 *   (no server) give the session an Eridani run binding on disk.
 *   B: the same session is live again: same shell pid, marker on screen,
 *      Eridani's snapshot says live with the same incarnation and run.
 *   `remotea upgrade` against B (drain over SIGUSR2, Eridani told
 *      `host.state draining`), restarting into C: everything survived.
 *   SIGKILL C (a crash, no checkpoint), start D: still the same process.
 *
 * Never touches ~/.config/remotea or a systemd unit: a scratch config dir,
 * a random port, the keeper started detached.
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { Terminal } from '@xterm/headless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { PROTO, decodeFrame, encodeInput, parseServerMsg, type ServerMsg } from '../../src/shared/remote-host-protocol';
import { upgrade } from '../src/upgrade';
import { keeperPaths } from '../src/pty-keeper/protocol';

const ROOT = path.resolve(__dirname, '..');
const linux = process.platform === 'linux';
let out = '';
let dir = '';
let port = 0;
const servers: ChildProcess[] = [];
const logs: string[] = [];

const freePort = () => new Promise<number>((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => r(p));
  });
});

function healthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${logs.join('').slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path.join(out, 'remote-server/src/main.js')], {
    env: {
      ...process.env,
      REMOTEA_CONFIG_DIR: dir,
      REMOTEA_COLLECTOR_HOME: path.join(dir, 'home'),
      REMOTEA_PTY_KEEPER_LAUNCH: 'detached',
      NODE_PATH: path.join(ROOT, 'node_modules'),
      INVOCATION_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => logs.push(String(d)));
  child.stderr!.on('data', (d) => logs.push(String(d)));
  servers.push(child);
  await until(healthy, 20_000, 'the server to answer');
  return child;
}

function stopServer(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

/** An app: hello, then open/attach and type. */
class App {
  ws!: WebSocket;
  msgs: ServerMsg[] = [];
  output = '';
  async connect(): Promise<Extract<ServerMsg, { t: 'welcome' }>> {
    const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` } });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const f = decodeFrame(new Uint8Array(data as Buffer));
        if (f?.data) this.output += f.data;
        return;
      }
      const m = parseServerMsg(JSON.parse(String(data)));
      if (m) this.msgs.push(m);
    });
    await new Promise((r) => this.ws.once('open', r));
    this.ws.send(JSON.stringify({ t: 'hello', proto: PROTO, device: { id: 'device-test0001', name: 'test' }, app: { name: 'test', version: '0' } }));
    await until(() => this.msgs.some((m) => m.t === 'welcome'), 5000, 'welcome');
    return this.msgs.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  type(id: string, text: string): void {
    this.ws.send(encodeInput(id, text));
  }
  async opened(id: string): Promise<Extract<ServerMsg, { t: 'opened' }>> {
    await until(() => this.msgs.some((m) => m.t === 'opened' && m.id === id), 10_000, `opened ${id}`);
    return this.msgs.find((m) => m.t === 'opened' && m.id === id) as Extract<ServerMsg, { t: 'opened' }>;
  }
  close(): void {
    this.ws.close();
  }
}

/** A fake Eridani: welcome (advertising `draining`) and ack everything. */
class FakeEridani {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  frames: Array<Record<string, unknown>> = [];
  epoch = 0;
  constructor() {
    this.wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const f = JSON.parse(String(data)) as Record<string, unknown>;
        this.frames.push(f);
        const send = (b: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, id: `e-${Math.random()}`, conn_epoch: this.epoch, at: Date.now(), ...b }));
        if (f.t === 'hello') send({ t: 'welcome', host_id: 'host-t', conn_epoch: ++this.epoch, server_time: Date.now(), caps: ['draining'] });
        else if (typeof f.op_id === 'string' && f.t !== 'ack') send({ t: 'ack', acked_id: f.id, op_id: f.op_id, ok: true });
      });
    });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as net.AddressInfo).port}/link`;
  }
  /** The newest snapshot surface for `surf` after the hello of `boot`. */
  surface(boot: string, surf: string): Record<string, unknown> | undefined {
    const i = this.frames.findIndex((f) => f.t === 'hello' && f.boot_id === boot);
    if (i < 0) return undefined;
    const snaps = this.frames.slice(i).filter((f) => f.t === 'sessions.snapshot');
    for (const s of snaps.reverse()) {
      const hit = (s.surfaces as Array<Record<string, unknown>>).find((x) => x.surf === surf);
      if (hit) return hit;
    }
    return undefined;
  }
}

function screenOf(snapshot: string, cols: number, rows: number): Promise<string> {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  return new Promise((r) => term.write(snapshot, () => {
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    term.dispose();
    r(lines.join('\n'));
  }));
}

const bootOf = () => (JSON.parse(fs.readFileSync(path.join(dir, 'server-info.json'), 'utf8')) as { bootId: string }).bootId;

describe.skipIf(!linux)('upgrade without dropping PTYs (real server, real keeper)', () => {
  let eri: FakeEridani;

  beforeAll(async () => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-build-'));
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(ROOT, 'tsconfig.json'), '--outDir', out, '--sourceMap', 'false'], { stdio: 'pipe' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-up-'));
    fs.mkdirSync(path.join(dir, 'home'));
    port = await freePort();
    eri = new FakeEridani();
    await new Promise((r) => eri.wss.once('listening', r));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, hookPort: 0, bind: ['127.0.0.1'], ptyKeeper: true, ptyKeeperIdleMinutes: 1 }));
    fs.writeFileSync(path.join(dir, 'eridani.json'), JSON.stringify({ enabled: true, url: eri.url, machine: 'test', collector: 'off' }));
    fs.writeFileSync(path.join(dir, 'eridani-token'), 'eri_bot_integration0123456789\n', { mode: 0o600 });
  }, 240_000);

  afterAll(async () => {
    if (process.env.UPGRADE_IT_LOGS) process.stdout.write(logs.join(''));
    for (const s of servers) await stopServer(s, 'SIGKILL');
    try {
      const pid = Number(fs.readFileSync(keeperPaths(dir).pid, 'utf8').trim());
      if (pid > 1) process.kill(pid, 'SIGTERM'); // the keeper hangs up its sessions and exits
    } catch {
      /* not running */
    }
    await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => eri?.wss.close(() => r(null)));
    for (const d of [out, dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a session lives through SIGTERM, `remotea upgrade` and a crash of the server', async () => {
    const surf = 'surf-upgrade-it';
    // ── A ──
    const a = await startServer();
    const bootA = bootOf();
    const app = new App();
    await app.connect();
    app.send({ t: 'open', rid: 1, id: surf, cols: 100, rows: 30, create: { cwd: dir, groupId: 'grp-it', group: { name: 'IT' } } });
    await app.opened(surf);
    app.type(surf, 'echo "MARK-$((6*7)) PID=$$"\r');
    await until(() => /MARK-42 PID=(\d+)/.test(app.output), 15_000, 'the marker');
    const pid = /MARK-42 PID=(\d+)/.exec(app.output)![1];
    await until(() => !!eri.surface(bootA, surf), 10_000, 'the snapshot of A');
    await new Promise((r) => setTimeout(r, 400)); // the registry is saved (debounced)
    app.close();
    await stopServer(a, 'SIGTERM');
    expect(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()).toMatch(/sh$/); // the shell outlived its server

    // While no server runs: the session becomes an Eridani run's (as a spawn would have made it).
    const regFile = path.join(dir, 'registry.json');
    const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    const incarnation = reg.sessions[surf].incarnation;
    reg.sessions[surf].eridani = { runId: 'run-it', generation: 3, attempt: 1, taskId: null, target: 'none', harness: 'claude', model: 'm', worktree: dir, branch: 'b', base: 'main', baseSha: null, spawnOp: 'op-s' };
    fs.writeFileSync(regFile, JSON.stringify(reg));

    // ── B ──
    await startServer();
    const bootB = bootOf();
    const app2 = new App();
    const welcome = await app2.connect();
    expect(welcome.sessions.find((s) => s.id === surf)).toMatchObject({ state: 'live', incarnation, bootId: bootB });
    app2.send({ t: 'open', rid: 1, id: surf, cols: 100, rows: 30 });
    const opened = await app2.opened(surf);
    expect(opened).toMatchObject({ mode: 'snapshot', state: 'live', created: false });
    expect(opened.wasLost).toBeFalsy();
    expect(await screenOf(opened.snapshot ?? '', opened.cols, opened.rows)).toContain(`MARK-42 PID=${pid}`);
    app2.type(surf, 'echo "AFTER-$((1+1)) PID=$$"\r');
    await until(() => app2.output.includes(`AFTER-2 PID=${pid}`), 10_000, 'the same shell answering');
    await until(() => !!eri.surface(bootB, surf), 10_000, 'the snapshot of B');
    expect(eri.surface(bootB, surf)).toMatchObject({ state: 'live', incarnation, run_id: 'run-it', generation: 3 });
    app2.close();

    // ── remotea upgrade: drain B, restart into C ──
    const lines: string[] = [];
    const res = await upgrade({
      dir,
      healthy,
      timeoutMs: 5000,
      out: (l) => lines.push(l),
      restart: async () => {
        await stopServer(servers.at(-1)!, 'SIGTERM');
        await startServer();
      },
    });
    expect(res, lines.join('\n')).toMatchObject({ ok: true, survived: [surf], lost: [], drain: { state: 'settled' } });
    expect(eri.frames.some((f) => f.t === 'host.state' && f.draining === true)).toBe(true);
    const bootC = bootOf();
    expect(res.newBoot).toBe(bootC);
    await until(() => !!eri.surface(bootC, surf), 10_000, 'the snapshot of C');
    expect(eri.surface(bootC, surf)).toMatchObject({ state: 'live', incarnation, run_id: 'run-it' });

    // ── a crash: SIGKILL C, no checkpoint; D rebuilds from the ring ──
    await stopServer(servers.at(-1)!, 'SIGKILL');
    await startServer();
    const bootD = bootOf();
    const app3 = new App();
    const w3 = await app3.connect();
    expect(w3.sessions.find((s) => s.id === surf)).toMatchObject({ state: 'live', incarnation, bootId: bootD });
    app3.send({ t: 'open', rid: 1, id: surf, cols: 100, rows: 30 });
    await app3.opened(surf);
    app3.type(surf, 'echo "CRASH-$((2+2)) PID=$$"\r');
    await until(() => app3.output.includes(`CRASH-4 PID=${pid}`), 10_000, 'the same shell after a crash');
    app3.close();
  }, 120_000);
});

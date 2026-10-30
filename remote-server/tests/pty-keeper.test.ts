/**
 * S-Q5: the PTY keeper's protocol (pty-keeper/), and the hub handing its
 * sessions over and adopting them back across a "restart" (a new Registry
 * load, a new Hub, a new keeper client), with fake PTYs in an in-process
 * keeper on a real unix socket. The real processes and the real server are in
 * upgrade-integration.test.ts.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import { KeeperServer } from '../src/pty-keeper/keeper';
import { KeeperClient, observeKeeper, type KeeperCloseReason } from '../src/pty-keeper/client';
import { KEEPER_PROTO, LineReader, encodeLine, keeperPaths, type KeeperSpawnSpec } from '../src/pty-keeper/protocol';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { PtyBackend, observeKeeperStatus } from '../src/pty-backend';
import { Drainer, readDrainStatus, writeDrainRequest } from '../src/drain';
import { FakeConn, FakePty, waitFor } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyk-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const SPEC: KeeperSpawnSpec = { file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 };

async function keeper(o: { idleMs?: number; now?: () => number; ringBytes?: number } = {}) {
  const dir = tmpDir();
  const sock = keeperPaths(dir).sock;
  const ptys: FakePty[] = [];
  let idle = 0;
  const k = new KeeperServer({
    sock,
    version: 'test',
    idleMs: o.idleMs ?? 60_000,
    now: o.now,
    onIdle: () => idle++,
    spawn: (spec) => {
      const p = new FakePty({ sessionId: 'x', cols: spec.cols, rows: spec.rows });
      ptys.push(p);
      return p;
    },
  });
  await k.listen();
  cleanups.push(() => k.close());
  const connect = async (role: 'owner' | 'observer' = 'owner') => {
    const c = await KeeperClient.connect({ sock, role });
    cleanups.push(() => c.end());
    return c;
  };
  return { dir, sock, k, ptys, connect, idle: () => idle };
}

describe('pty keeper protocol', () => {
  it('LineReader splits lines across chunks and refuses an endless line', () => {
    const lines: string[] = [];
    const r = new LineReader((l) => lines.push(l), 10);
    expect(r.push('{"a":')).toBe(true);
    expect(r.push('1}\n{"b":2}\n{"c"')).toBe(true);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.push('xxxxxxxxxxxxxxxx')).toBe(false);
  });

  it('welcome, spawn, numbered output, write, resize, pause', async () => {
    const t = await keeper();
    const c = await t.connect();
    expect(c.welcome).toMatchObject({ proto: KEEPER_PROTO, version: 'test', owner: null, sessions: [] });
    const pty = c.spawn('surf-1', SPEC);
    const got: string[] = [];
    pty.onData((d) => got.push(d));
    await waitFor(() => t.ptys.length === 1 && pty.pid !== 0);
    expect(pty.pid).toBe(t.ptys[0].pid);
    t.ptys[0].emit('hello ');
    t.ptys[0].emit('world');
    await waitFor(() => got.join('') === 'hello world');
    expect(pty.lastSeq).toBe(2);
    pty.write('ls\r');
    pty.resize(100, 30);
    pty.pause();
    await waitFor(() => t.ptys[0].written.join('') === 'ls\r' && t.ptys[0].size[0] === 100 && t.ptys[0].paused);
    pty.resume();
    await waitFor(() => !t.ptys[0].paused);
  });

  it('keeps sessions when the owner goes; the next owner attaches with the checkpoint and what came after', async () => {
    const t = await keeper();
    const c1 = await t.connect();
    const p1 = c1.spawn('surf-1', SPEC);
    p1.onData(() => {});
    await waitFor(() => t.ptys.length === 1);
    t.ptys[0].emit('before ');
    await waitFor(() => p1.lastSeq === 1);
    p1.release({ seq: p1.hold(), data: '<SNAPSHOT>' });
    await c1.end();
    // Output while no server is attached: kept in the ring.
    t.ptys[0].emit('during ');
    t.ptys[0].emit('gap');
    const c2 = await t.connect();
    expect(c2.welcome.sessions).toMatchObject([{ id: 'surf-1', alive: true, seq: 3, checkpointSeq: 1 }]);
    const { pty, attached } = await c2.adopt('surf-1');
    expect(attached).toMatchObject({ alive: true, seq: 3, checkpoint: { seq: 1, data: '<SNAPSHOT>' }, truncated: false });
    expect(attached.chunks).toEqual([[2, 'during '], [3, 'gap']]);
    const got: string[] = [];
    // Output after the attach and before anyone subscribed is buffered, not lost.
    t.ptys[0].emit(' after');
    await new Promise((r) => setTimeout(r, 20));
    pty.onData((d) => got.push(d));
    await waitFor(() => got.join('') === ' after');
  });

  it('without a covering checkpoint the whole ring is replayed and says it is truncated', async () => {
    const t = await keeper();
    const c1 = await t.connect();
    c1.spawn('surf-1', { ...SPEC, ringBytes: 8 }).onData(() => {});
    await waitFor(() => t.ptys.length === 1);
    for (const s of ['aaaa', 'bbbb', 'cccc', 'dddd']) t.ptys[0].emit(s);
    await new Promise((r) => setTimeout(r, 20));
    await c1.end();
    const c2 = await t.connect();
    const { attached } = await c2.adopt('surf-1');
    expect(attached.checkpoint).toBeUndefined();
    expect(attached.truncated).toBe(true);
    expect(attached.chunks.map(([, d]) => d).join('')).toBe('ccccdddd');
  });

  it('an exit while no owner is attached is reported on attach; forget drops it', async () => {
    const t = await keeper();
    const c1 = await t.connect();
    c1.spawn('surf-1', SPEC).onData(() => {});
    await waitFor(() => t.ptys.length === 1);
    await c1.end();
    t.ptys[0].exit(3);
    const c2 = await t.connect();
    const { pty, attached } = await c2.adopt('surf-1');
    expect(attached).toMatchObject({ alive: false, exitCode: 3 });
    const exits: number[] = [];
    pty.onExit((e) => exits.push(e.exitCode));
    expect(exits).toEqual([3]);
    c2.forget('surf-1');
    await waitFor(() => !t.k.sessions.has('surf-1'));
  });

  it('a live exit reaches the owner and the keeper forgets it', async () => {
    const t = await keeper();
    const c = await t.connect();
    const pty = c.spawn('surf-1', SPEC);
    const exits: number[] = [];
    pty.onExit((e) => exits.push(e.exitCode));
    await waitFor(() => t.ptys.length === 1);
    t.ptys[0].exit(0);
    await waitFor(() => exits.length === 1 && !t.k.sessions.has('surf-1'));
  });

  it('a newer owner replaces the older (sessions untouched); an observer replaces nobody', async () => {
    const t = await keeper();
    const c1 = await t.connect();
    const p1 = c1.spawn('surf-1', SPEC);
    const exits: number[] = [];
    p1.onExit((e) => exits.push(e.exitCode));
    const closed: KeeperCloseReason[] = [];
    c1.onClose((why) => closed.push(why));
    await waitFor(() => t.ptys.length === 1);
    const seen = await observeKeeper(t.sock);
    expect(seen?.owner?.pid).toBe(process.pid);
    expect(c1.connected).toBe(true);
    const c2 = await t.connect();
    await waitFor(() => closed.length === 1);
    expect(closed).toEqual(['replaced']);
    expect(exits).toEqual([]); // the process was not ended by the takeover
    expect(c2.welcome.sessions[0]).toMatchObject({ id: 'surf-1', alive: true });
  });

  it('refuses another protocol version; answers an unknown request with an error', async () => {
    const t = await keeper();
    const raw = net.connect(t.sock);
    raw.setEncoding('utf8');
    let text = '';
    raw.on('data', (d: string) => (text += d));
    raw.write(encodeLine({ t: 'hello', proto: KEEPER_PROTO + 1, role: 'owner' }));
    await waitFor(() => text.includes('incompatible'));
    raw.destroy();
    const c = await t.connect();
    c.post({ t: 'frobnicate', rid: 9 } as never);
    // The connection stays usable.
    expect(await c.list()).toEqual([]);
  });

  it('a second keeper refuses a socket another one answers on', async () => {
    const t = await keeper();
    const k2 = new KeeperServer({ sock: t.sock, version: 'x', idleMs: 1, onIdle: () => {}, spawn: () => new FakePty({ sessionId: 'x', cols: 1, rows: 1 }) });
    await expect(k2.listen()).rejects.toThrow(/another pty keeper/);
  });

  it('exits when idle: no owner and no live session for idleMs', async () => {
    let now = 1000;
    const t = await keeper({ idleMs: 5000, now: () => now });
    const c = await t.connect();
    c.spawn('surf-1', SPEC).onData(() => {});
    await waitFor(() => t.ptys.length === 1);
    await c.end();
    await waitFor(() => !t.k['owner']);
    t.k.checkIdle();
    now += 10_000;
    t.k.checkIdle();
    expect(t.idle()).toBe(0); // a live session keeps it
    t.ptys[0].exit(0);
    t.k.checkIdle();
    now += 4000;
    t.k.checkIdle();
    expect(t.idle()).toBe(0);
    now += 2000;
    t.k.checkIdle();
    expect(t.idle()).toBe(1);
  });
});

describe('hub across a restart with the keeper (S-Q5)', () => {
  const DEV = 'device-aaaaaaaa';

  async function boot(dir: string, sock: string, bootId: string) {
    const registry = Registry.load({ file: path.join(dir, 'registry.json'), bootId, saveDebounceMs: 1 });
    const backend = new PtyBackend({ dir, enabled: false, idleMs: 60_000, ringBytes: 1 << 20, version: 'test', log: () => {} });
    const hub = new Hub({ registry, spawn: backend.spawn, bootId, serverId: 'srv-1', hostname: 'desk', probe: () => ({}) });
    const adopted = await backend.start();
    const res = hub.adopt(adopted, backend.discard);
    cleanups.push(() => backend.stop());
    const conn = new FakeConn(1);
    hub.connect(conn);
    hub.handle(conn, { t: 'hello', proto: 1, device: { id: DEV, name: 'laptop' }, app: { name: 'test', version: '0' } });
    void sock;
    return { registry, backend, hub, conn, res };
  }

  function screen(snapshot: string): Promise<string> {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    return new Promise((r) => term.write(snapshot, () => {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
      term.dispose();
      r(lines.join('\n'));
    }));
  }

  it('a keeper session survives: same record, same incarnation and binding, screen rebuilt, no respawn', async () => {
    const t = await keeper();
    // The backend attaches to a keeper that answers even with ptyKeeper off; spawns go to the keeper only when on.
    const b1 = await boot(t.dir, t.sock, 'boot-1');
    // Route this boot's spawns into the keeper (as ptyKeeper: true would).
    (b1.backend as unknown as { o: { enabled: boolean } }).o.enabled = true;
    b1.hub.handle(b1.conn, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: { cwd: '/tmp', groupId: 'grp-w', group: { name: 'Work' } } });
    await waitFor(() => t.ptys.length === 1);
    b1.registry.updateSession('surf-1', { eridani: { runId: 'run-1', generation: 2 } as never, incarnation: 1 });
    t.ptys[0].emit('MARKER-ONE\r\n');
    await waitFor(() => b1.conn.outputs('surf-1').length > 0);
    const kept = await b1.hub.shutdown();
    expect(kept).toEqual(['surf-1']);
    expect(t.ptys[0].killed).toEqual([]); // handed over, not hung up
    await b1.backend.stop();
    t.ptys[0].emit('MARKER-TWO\r\n'); // while no server runs

    const b2 = await boot(t.dir, t.sock, 'boot-2');
    expect(b2.res).toEqual({ adopted: ['surf-1'], exited: [], discarded: [] });
    const rec = b2.registry.session('surf-1')!;
    expect(rec).toMatchObject({ state: 'live', bootId: 'boot-2', incarnation: 1, eridani: { runId: 'run-1', generation: 2 } });
    expect(b2.hub.isLive('surf-1')).toBe(true);
    expect(b2.conn.json('welcome')[0].sessions[0]).toMatchObject({ id: 'surf-1', state: 'live' });
    // The app reopens the tab: a snapshot of the same screen, not a fresh process.
    b2.hub.handle(b2.conn, { t: 'open', rid: 2, id: 'surf-1', cols: 80, rows: 24, create: { cwd: '/tmp' } });
    await waitFor(() => b2.conn.json('opened').length === 1);
    const opened = b2.conn.json('opened')[0];
    expect(opened).toMatchObject({ mode: 'snapshot', created: false, state: 'live' });
    const text = await screen(opened.snapshot ?? '');
    expect(text).toContain('MARKER-ONE');
    expect(text).toContain('MARKER-TWO');
    expect(t.ptys).toHaveLength(1);
    // Input reaches the same process.
    b2.hub.handleInput(b2.conn, 'surf-1', 'echo hi\r');
    await waitFor(() => t.ptys[0].written.includes('echo hi\r'));
  });

  it('adoption: an exit meanwhile is recorded with its code; a session the registry closed is hung up', async () => {
    const t = await keeper();
    const b1 = await boot(t.dir, t.sock, 'boot-1');
    (b1.backend as unknown as { o: { enabled: boolean } }).o.enabled = true;
    for (const id of ['surf-a', 'surf-b']) b1.hub.handle(b1.conn, { t: 'open', rid: 1, id: id as `surf-${string}`, cols: 80, rows: 24, create: { cwd: '/tmp' } });
    await waitFor(() => t.ptys.length === 2);
    await b1.hub.shutdown();
    await b1.backend.stop();
    t.ptys[0].exit(7);
    // surf-b was closed while the server was down (tombstoned on disk).
    const reg = JSON.parse(fs.readFileSync(path.join(t.dir, 'registry.json'), 'utf8'));
    delete reg.sessions['surf-b'];
    reg.tombstones['s:surf-b'] = { kind: 'session', at: Date.now(), by: DEV, reason: 'closed' };
    fs.writeFileSync(path.join(t.dir, 'registry.json'), JSON.stringify(reg));

    const b2 = await boot(t.dir, t.sock, 'boot-2');
    expect(b2.res).toEqual({ adopted: [], exited: ['surf-a'], discarded: ['surf-b'] });
    expect(b2.registry.session('surf-a')).toMatchObject({ state: 'exited', exitCode: 7 });
    await waitFor(() => t.ptys[1].killed.includes('SIGHUP'));
  });

  it('status sees the keeper and its sessions without taking it over', async () => {
    const t = await keeper();
    const c = await t.connect();
    c.spawn('surf-1', SPEC).onData(() => {});
    await waitFor(() => t.ptys.length === 1);
    const s = await observeKeeperStatus(t.dir, true);
    expect(s).toMatchObject({ enabled: true, running: true, sessions: 1, alive: 1, ids: ['surf-1'], owner: { pid: process.pid } });
    expect(c.connected).toBe(true);
    const none = await observeKeeperStatus(tmpDir(), false);
    expect(none).toMatchObject({ enabled: false, running: false, sessions: 0 });
  });
});

describe('drain (S-Q5)', () => {
  it('holds, waits for work under way, settles; a drain with no restart expires and runs what was held', async () => {
    const dir = tmpDir();
    const calls: string[] = [];
    let inflight = { commands: [{ op_id: 'op-1', t: 'input' }], writes: ['surf-1'] };
    const d = new Drainer({
      dir,
      bootId: 'boot-1',
      target: () => ({ setDraining: (on) => calls.push(on ? 'on' : 'off'), inflight: () => inflight }),
      flush: () => calls.push('flush'),
      log: () => {},
      pollMs: 5,
      expireGraceMs: 50,
    });
    cleanups.push(() => d.dispose());
    writeDrainRequest(dir, { at: Date.now(), timeoutMs: 5000 });
    d.requested();
    expect(calls).toEqual(['on']);
    await new Promise((r) => setTimeout(r, 30));
    expect(readDrainStatus(dir)).toMatchObject({ bootId: 'boot-1', state: 'draining', waiting: { writes: ['surf-1'] } });
    inflight = { commands: [], writes: [] };
    await waitFor(() => readDrainStatus(dir)?.state === 'settled');
    expect(calls).toEqual(['on', 'flush']);
    // Nobody restarted it: the drain is canceled (expiry calls the same) and the held work runs here.
    d.cancel('expired');
    expect(calls).toEqual(['on', 'flush', 'off']);
    expect(readDrainStatus(dir)?.state).toBe('expired');
  });

  it('times out with what is still under way', async () => {
    const dir = tmpDir();
    const d = new Drainer({ dir, bootId: 'b', target: () => ({ setDraining: () => {}, inflight: () => ({ commands: [{ op_id: 'op-9', t: 'verify' }], writes: [] }) }), log: () => {}, pollMs: 5 });
    cleanups.push(() => d.dispose());
    d.start(30);
    await waitFor(() => readDrainStatus(dir)?.state === 'timeout');
    expect(readDrainStatus(dir)?.waiting.commands).toEqual([{ op_id: 'op-9', t: 'verify' }]);
  });
});

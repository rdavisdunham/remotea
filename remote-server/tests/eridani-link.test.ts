import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IncomingMessage } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseUpFrame, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { AUTH_RETRY_MS } from '../../src/main/remote-hosts/connection-fsm';
import { EridaniLink, OUTBOX_FILE, digestOf, type EridaniLinkDeps } from '../src/eridani-link';
import { Spool } from '../src/eridani-spool';
import { ManualTimers } from './helpers';

/** A fake Eridani: answers hello with welcome and acks everything unless told otherwise. */
class FakeEridani {
  readonly wss: WebSocketServer;
  readonly frames: UpFrame[] = [];
  readonly upgrades: IncomingMessage[] = [];
  sockets: WebSocket[] = [];
  status = 101;
  autoAck = true;
  epoch = 0;
  constructor() {
    this.wss = new WebSocketServer({
      port: 0,
      verifyClient: (info, cb) => {
        this.upgrades.push(info.req);
        if (this.status !== 101) cb(false, this.status);
        else cb(true);
      },
    });
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const f = parseUpFrame(JSON.parse(String(data)));
        if (!f) throw new Error(`bad frame ${String(data)}`);
        this.frames.push(f);
        if (f.t === 'hello') {
          this.send(ws, { t: 'welcome', host_id: 'host-1', conn_epoch: ++this.epoch, server_time: Date.now() });
        } else if (this.autoAck && 'op_id' in f && f.t !== 'ack') {
          this.ack(ws, f.id, true);
        }
      });
    });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}/link`;
  }
  send(ws: WebSocket, body: Record<string, unknown>): void {
    ws.send(JSON.stringify({ v: 1, id: `e-${Math.random()}`, conn_epoch: this.epoch, at: Date.now(), ...body }));
  }
  ack(ws: WebSocket, id: string, ok: boolean, extra: Record<string, unknown> = {}): void {
    this.send(ws, { t: 'ack', acked_id: id, ok, ...extra });
  }
  of(t: string): UpFrame[] {
    return this.frames.filter((f) => f.t === t);
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eridani-link-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function setup(over: Partial<EridaniLinkDeps> = {}) {
  const eri = new FakeEridani();
  cleanups.push(() => eri.close());
  await new Promise((r) => eri.wss.once('listening', r));
  const link = new EridaniLink({
    url: eri.url,
    token: () => 'eri_bot_test0123456789',
    dir: null,
    serverId: 'srv-1',
    bootId: 'boot-1',
    hostname: 'box',
    machine: 'box',
    version: '9.9.9',
    harnesses: () => ({ claude: { version: '2.0.0', observe: true, capture: true, question: false, context: false, resume: false } }),
    snapshot: () => [],
    rand: () => 0.5,
    ...over,
  });
  cleanups.push(() => link.stop());
  return { eri, link };
}

const turn = (n: number) => ({
  surf: 'surf-1',
  incarnation: 1,
  run_id: null,
  generation: 0,
  provider: 'claude',
  tool: 'claude_code' as const,
  provider_session_id: 'sess',
  provider_turn_id: `sess:surf-1:${n}`,
  root: true as const,
  seq: n,
  text: `answer ${n}`,
  truncated: false,
  missing: false,
  source: 'hook' as const,
  ended_at: 1000 + n,
});

describe('EridaniLink', () => {
  it('connects with the bearer key and an explicit User-Agent, no Origin, then hello → welcome → snapshot', async () => {
    const { eri, link } = await setup({ snapshot: () => [{ surf: 'surf-1', incarnation: 2, state: 'live', agent_state: 'idle', since: 5, provider: null, provider_session_id: null, group: null, title: 't', cwd: '/x', turn_seq: 0, run_id: null, generation: 0 }] });
    link.start();
    await until(() => link.ready && eri.of('sessions.snapshot').length === 1);
    const req = eri.upgrades[0];
    expect(req.headers.authorization).toBe('Bearer eri_bot_test0123456789');
    expect(req.headers['user-agent']).toBe('remotea-server/9.9.9');
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers['sec-websocket-protocol']).toBe('eridani.v1');
    const hello = eri.of('hello')[0] as UpFrame & { caps: string[]; conn_epoch: unknown };
    expect(hello.conn_epoch).toBeNull();
    expect(hello).toMatchObject({ server_id: 'srv-1', boot_id: 'boot-1', proto: 1, version: '9.9.9' });
    expect(hello.caps).toContain('session.report.parity');
    const snap = eri.of('sessions.snapshot')[0] as UpFrame & { conn_epoch: number; part: { i: number; n: number }; surfaces: unknown[] };
    expect(snap.conn_epoch).toBe(1);
    expect(snap.part).toMatchObject({ i: 1, n: 1 });
    expect(snap.surfaces).toHaveLength(1);
    expect(link.status()).toMatchObject({ state: 'ready', hostId: 'host-1', connEpoch: 1 });
  });

  it('an acked event leaves the spool; the digest is the semantic one', async () => {
    const delivered: string[] = [];
    const { eri, link } = await setup({ onDelivered: (e) => delivered.push(String(e.body.t)) });
    link.start();
    await until(() => link.ready);
    link.turn(turn(1));
    await until(() => delivered.includes('turn'));
    const f = eri.of('turn')[0] as unknown as Record<string, unknown>;
    expect(f.digest).toBe(digestOf(f));
    expect(link.spool.size).toBe(0);
    expect(link.status().lastAckAt).not.toBeNull();
  });

  it('server close → reconnect replays each unacked event exactly once, with the same op_id', async () => {
    const { eri, link } = await setup();
    eri.autoAck = false;
    link.start();
    await until(() => link.ready);
    link.turn(turn(1));
    link.turn(turn(2));
    await until(() => eri.of('turn').length === 2);
    const first = eri.of('turn').map((f) => (f as { op_id: string }).op_id);
    eri.autoAck = true;
    eri.sockets[0].close(1012, 'restart');
    await until(() => eri.of('turn').length === 4 && link.spool.size === 0, 5000);
    const replayed = eri.of('turn').slice(2);
    expect(replayed.map((f) => (f as { op_id: string }).op_id)).toEqual(first);
    expect(new Set(eri.of('turn').map((f) => f.id)).size).toBe(4); // a new envelope id per send
    expect((replayed[0] as { conn_epoch: number }).conn_epoch).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(eri.of('turn')).toHaveLength(4);
  });

  it('a 401 waits five minutes before trying again', async () => {
    const timers = new ManualTimers();
    const { eri, link } = await setup({ timers, now: () => timers.now });
    eri.status = 401;
    link.start();
    await until(() => link.status().state === 'auth-failed');
    expect(eri.upgrades).toHaveLength(1);
    timers.advance(AUTH_RETRY_MS - 1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(eri.upgrades).toHaveLength(1);
    eri.status = 101;
    timers.advance(1000);
    await until(() => link.ready);
    expect(eri.upgrades).toHaveLength(2);
  });

  it('other failures back off quickly and reconnect', async () => {
    const timers = new ManualTimers();
    const { eri, link } = await setup({ timers, now: () => timers.now });
    eri.status = 503;
    link.start();
    await until(() => link.status().state === 'reconnecting');
    eri.status = 101;
    timers.advance(1000);
    await until(() => link.ready);
  });

  it('a duplicate inbound op_id executes once; a different digest is refused', async () => {
    let runs = 0;
    const { eri, link } = await setup({ handlers: { 'test.cmd': async () => (runs++, { state: 'executed' }) } });
    link.start();
    await until(() => link.ready);
    const ws = eri.sockets[0];
    const cmd = { t: 'test.cmd', op_id: 'op-1', value: 1 };
    const digest = digestOf(cmd);
    eri.send(ws, { ...cmd, id: 'c1', digest });
    await until(() => eri.of('command.outcome').length === 1);
    eri.send(ws, { ...cmd, id: 'c2', digest });
    await until(() => eri.of('ack').filter((a) => (a as { acked_id: string }).acked_id === 'c2').length === 1);
    expect(runs).toBe(1);
    eri.send(ws, { ...cmd, value: 2, id: 'c3', digest: digestOf({ ...cmd, value: 2 }) });
    await until(() => eri.of('ack').some((a) => (a as { acked_id: string }).acked_id === 'c3'));
    const refusal = eri.of('ack').find((a) => (a as { acked_id: string }).acked_id === 'c3') as { ok: boolean; error: string };
    expect(refusal).toMatchObject({ ok: false, error: 'DIGEST_MISMATCH' });
    expect(runs).toBe(1);
  });

  it('commands this release does not execute are acked and reported rejected', async () => {
    const { eri, link } = await setup();
    link.start();
    await until(() => link.ready);
    eri.send(eri.sockets[0], { t: 'prompt.inject', op_id: 'op-x', id: 'c1', digest: 'x' });
    await until(() => eri.of('command.outcome').length === 1);
    expect(eri.of('command.outcome')[0]).toMatchObject({ command_id: 'op-x', state: 'rejected', detail: 'unsupported' });
  });

  it('a transient refusal (retry) is sent again later, a permanent one is dropped', async () => {
    const timers = new ManualTimers();
    const { eri, link } = await setup({ timers, now: () => timers.now });
    eri.autoAck = false;
    link.start();
    await until(() => link.ready);
    link.turn(turn(1));
    link.turn(turn(2));
    await until(() => eri.of('turn').length === 2);
    const [a, b] = eri.of('turn');
    eri.ack(eri.sockets[0], a.id, false, { retry: true, error: 'busy' });
    eri.ack(eri.sockets[0], b.id, false, { error: 'bad turn' });
    await until(() => link.status().rejected === 1);
    expect(link.status().unacked).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(eri.of('turn')).toHaveLength(2);
    // Two steps, so the 15 s ping's pong lands in between and the link stays alive.
    timers.advance(15_000);
    await new Promise((r) => setTimeout(r, 30));
    timers.advance(15_000);
    await until(() => eri.of('turn').length === 3);
    expect((eri.of('turn')[2] as { op_id: string }).op_id).toBe((a as { op_id: string }).op_id);
  });

  it('the outbox survives a new instance (server restart) and is sent then', async () => {
    const dir = tmpDir();
    const { eri, link } = await setup({ dir });
    eri.autoAck = false;
    link.start();
    await until(() => link.ready);
    link.turn(turn(7));
    await until(() => eri.of('turn').length === 1);
    const op = (eri.of('turn')[0] as { op_id: string }).op_id;
    link.stop();
    expect(fs.statSync(path.join(dir, OUTBOX_FILE)).mode & 0o777).toBe(0o600);
    eri.autoAck = true;
    const again = new EridaniLink({ ...(link as unknown as { deps: EridaniLinkDeps }).deps });
    cleanups.push(() => again.stop());
    expect(again.spool.size).toBe(1);
    again.start();
    await until(() => eri.of('turn').length === 2 && again.spool.size === 0);
    expect((eri.of('turn')[1] as { op_id: string }).op_id).toBe(op);
  });

  it('writes its status to eridani-status.json', async () => {
    const dir = tmpDir();
    const { link } = await setup({ dir });
    link.start();
    await until(() => link.ready);
    link.writeStatusNow();
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'eridani-status.json'), 'utf8'));
    expect(st).toMatchObject({ enabled: true, state: 'ready', hostId: 'host-1', unacked: 0 });
    expect(JSON.stringify(st)).not.toContain('eri_bot_');
  });
});

describe('Spool', () => {
  const opts = (file: string | null, over = {}) => ({ file, maxEntries: 100, maxBytes: 1 << 20, hardFactor: 2, ...over });
  const report = (entity: string, revision: string, n = 0) => ({ op_id: `op-${entity}-${revision}-${n}`, lane: 2 as const, entity, revision, body: { t: 'session.report', entity, revision } });

  it('coalescing keeps the latest revision of an entity', () => {
    const s = new Spool(opts(null));
    s.put(report('claude_code:a', 'r1'));
    s.put(report('claude_code:a', 'r2'));
    s.put(report('claude_code:b', 'r1'));
    expect(s.size).toBe(2);
    expect(s.pending().map((e) => e.revision)).toEqual(['r2', 'r1']);
    // Numeric revisions only move forward.
    s.put({ op_id: 's5', lane: 1, entity: 'status:x', revision: 5, body: {} });
    s.put({ op_id: 's4', lane: 1, entity: 'status:x', revision: 4, body: {} });
    expect(s.get('s5')).toBeDefined();
    expect(s.get('s4')).toBeUndefined();
  });

  it('eviction drops the oldest coalescable entry and marks its entity dirty; turns are never evicted', () => {
    const dirty: string[] = [];
    const s = new Spool({ ...opts(null, { maxEntries: 3 }), onDirty: (e) => dirty.push(e) });
    s.put({ op_id: 't1', lane: 1, body: { t: 'turn' } });
    s.put(report('claude_code:a', 'r1'));
    s.put(report('claude_code:b', 'r1'));
    s.put(report('claude_code:c', 'r1'));
    expect(dirty).toEqual(['claude_code:a']);
    expect(s.get('t1')).toBeDefined();
    expect(s.dirty).toEqual(['claude_code:a']);
    expect(s.takeDirty()).toEqual(['claude_code:a']);
    expect(s.dirty).toEqual([]);
  });

  it('refuses protected events past the hard bound instead of dropping one', () => {
    const s = new Spool(opts(null, { maxEntries: 2, hardFactor: 2 }));
    for (let i = 0; i < 4; i++) expect(s.put({ op_id: `t${i}`, lane: 1, body: { t: 'turn' } }).ok).toBe(true);
    expect(s.put({ op_id: 't4', lane: 1, body: { t: 'turn' } })).toEqual({ ok: false, reason: 'spool-full' });
    expect(s.degraded).toBe('spool-full');
  });

  it('a torn final line is tolerated and the rest reloads', () => {
    const file = path.join(tmpDir(), OUTBOX_FILE);
    const a = new Spool(opts(file));
    a.put({ op_id: 't1', lane: 1, body: { t: 'turn', n: 1 } });
    a.put(report('claude_code:a', 'r1'));
    a.close();
    fs.appendFileSync(file, '{"k":"put","e":{"op_id":"t2","la');
    const b = new Spool(opts(file));
    expect(b.pending().map((e) => e.op_id)).toEqual(['t1', 'op-claude_code:a-r1-0']);
    b.put({ op_id: 't3', lane: 1, body: { t: 'turn', n: 3 } });
    b.close();
    const c = new Spool(opts(file));
    expect(c.size).toBe(3);
  });

  it('acks and dirty marks persist across instances', () => {
    const file = path.join(tmpDir(), OUTBOX_FILE);
    const a = new Spool(opts(file, { maxEntries: 2 }));
    a.put(report('claude_code:a', 'r1'));
    a.put(report('claude_code:b', 'r1'));
    a.put(report('claude_code:c', 'r1'));
    a.ack('op-claude_code:c-r1-0');
    a.close();
    const b = new Spool(opts(file, { maxEntries: 2 }));
    expect(b.pending().map((e) => e.entity)).toEqual(['claude_code:b']);
    expect(b.dirty).toEqual(['claude_code:a']);
  });

  it('disk full: keeps events in memory, degraded, and recovers once writes succeed', () => {
    const file = path.join(tmpDir(), OUTBOX_FILE);
    let full = true;
    const s = new Spool({
      ...opts(file),
      append: (f, text) => {
        if (full) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        fs.appendFileSync(f, text);
      },
    });
    expect(s.put({ op_id: 't1', lane: 1, body: { t: 'turn' } }).ok).toBe(true);
    expect(s.degraded).toBe('disk-full');
    expect(s.size).toBe(1);
    full = false;
    s.compact();
    expect(s.degraded).toBeNull();
    s.close();
    expect(new Spool(opts(file)).size).toBe(1);
  });
});

describe('Journal', () => {
  it('survives a restart; an op that was executing becomes uncertain, never re-run', async () => {
    const { Journal } = await import('../src/eridani-journal');
    const file = path.join(tmpDir(), 'eridani-journal.jsonl');
    const a = new Journal({ file, horizonMs: 1000 });
    a.record('op-1', { digest: 'd1', t: 'x', state: 'executed', detail: 'done' });
    a.record('op-2', { digest: 'd2', t: 'x', state: 'executing' });
    a.close();
    const b = new Journal({ file, horizonMs: 1000 });
    expect(b.get('op-1')).toMatchObject({ state: 'executed', digest: 'd1' });
    expect(b.get('op-2')?.state).toBe('uncertain');
    expect(b.unsettled()).toEqual({ pending: [], uncertain: ['op-2'] });
    expect((fs.statSync(file).mode & 0o777)).toBe(0o600);
  });
});

describe('EridaniLink: stage C commands', () => {
  const EXPIRES = Date.now() + 10 * 60_000;
  const cmdOf = (over: Record<string, unknown> = {}) => {
    const body = { t: 'test.cmd', op_id: 'op-c', expires_at: EXPIRES, value: 1, ...over };
    return { ...body, digest: digestOf(body) };
  };

  it('journals accepted (fsynced) before the ack, and the ack carries the accept facts', async () => {
    const dir = tmpDir();
    let journalAtRun = '';
    const { eri, link } = await setup({
      dir,
      handlers: {
        'test.cmd': async () => {
          journalAtRun = fs.readFileSync(path.join(dir, 'eridani-journal.jsonl'), 'utf8');
          return { state: 'executed', result: { ok: 1 } };
        },
      },
      acceptFacts: () => ({ surf: 'surf-x', incarnation: 1 }),
    });
    link.start();
    await until(() => link.ready);
    eri.send(eri.sockets[0], { ...cmdOf(), id: 'c1' });
    await until(() => eri.of('command.outcome').length === 1);
    expect(eri.of('ack').find((a) => (a as { acked_id: string }).acked_id === 'c1')).toMatchObject({ ok: true, op_id: 'op-c', outcome: { state: 'accepted', surf: 'surf-x', incarnation: 1 } });
    expect(journalAtRun).toContain('"state":"accepted"');
    expect(eri.of('command.outcome')[0]).toMatchObject({ command_id: 'op-c', state: 'executed', kind: 'test.cmd', result: { ok: 1 } });
  });

  it('rejects an expired command, one beyond the replay horizon, and a failed fence', async () => {
    const { eri, link } = await setup({
      handlers: { 'test.cmd': async () => ({ state: 'executed' }) },
      precheck: (c) => ((c as unknown as { value: number }).value === 9 ? 'stale incarnation' : null),
    });
    link.start();
    await until(() => link.ready);
    const ws = eri.sockets[0];
    eri.send(ws, { ...cmdOf({ op_id: 'op-old', expires_at: Date.now() - 1 }), id: 'c1' });
    eri.send(ws, { ...cmdOf({ op_id: 'op-far', expires_at: Date.now() + 30 * 86_400_000 }), id: 'c2' });
    eri.send(ws, { ...cmdOf({ op_id: 'op-fence', value: 9 }), id: 'c3' });
    await until(() => eri.of('command.outcome').length === 3);
    const by = (id: string) => eri.of('command.outcome').find((o) => (o as { command_id: string }).command_id === id);
    expect(by('op-old')).toMatchObject({ state: 'rejected', detail: 'expired' });
    expect(by('op-far')).toMatchObject({ state: 'rejected', detail: 'expires beyond the replay horizon' });
    expect(by('op-fence')).toMatchObject({ state: 'rejected', detail: 'stale incarnation' });
  });

  it('crash after accept, before the effect: the command runs once after the restart (replayAccepted)', async () => {
    const dir = tmpDir();
    let runs = 0;
    const first = await setup({ dir, handlers: { 'test.cmd': () => new Promise(() => {}) } });
    first.link.start();
    await until(() => first.link.ready);
    first.eri.send(first.eri.sockets[0], { ...cmdOf(), id: 'c1' });
    await until(() => first.eri.of('ack').some((a) => (a as { acked_id: string }).acked_id === 'c1'));
    first.link.stop(); // the "crash": the handler never began

    const deps = { ...(first.link as unknown as { deps: EridaniLinkDeps }).deps, handlers: { 'test.cmd': async () => (runs++, { state: 'executed' as const }) } };
    const again = new EridaniLink(deps);
    cleanups.push(() => again.stop());
    again.start();
    await until(() => again.ready);
    again.replayAccepted();
    again.replayAccepted();
    await until(() => first.eri.of('command.outcome').length === 1);
    expect(runs).toBe(1);
    // Eridani resends the same op: the recorded outcome, no second run.
    first.eri.send(first.eri.sockets.at(-1)!, { ...cmdOf(), id: 'c2' });
    await until(() => first.eri.of('ack').some((a) => (a as { acked_id: string }).acked_id === 'c2'));
    expect(first.eri.of('ack').find((a) => (a as { acked_id: string }).acked_id === 'c2')).toMatchObject({ ok: true, outcome: { state: 'executed' } });
    expect(runs).toBe(1);
  });

  it('crash during the effect: recover() settles it, or it is reported uncertain; never re-run', async () => {
    const dir = tmpDir();
    const first = await setup({ dir, handlers: { 'test.cmd': (_c, ctx) => (ctx.begin(), new Promise(() => {})) } });
    first.link.start();
    await until(() => first.link.ready);
    first.eri.send(first.eri.sockets[0], { ...cmdOf({ op_id: 'op-a' }), id: 'c1' });
    first.eri.send(first.eri.sockets[0], { ...cmdOf({ op_id: 'op-b', value: 2 }), id: 'c2' });
    await until(() => first.eri.of('ack').length >= 2);
    await new Promise((r) => setTimeout(r, 20));
    first.link.stop();

    let runs = 0;
    const seen: unknown[] = [];
    const again = new EridaniLink({
      ...(first.link as unknown as { deps: EridaniLinkDeps }).deps,
      handlers: { 'test.cmd': async () => (runs++, { state: 'executed' as const }) },
      recover: (rec) => (seen.push(rec.body), rec.op_id === 'op-a' ? { state: 'executed', detail: 'mapped' } : null),
    });
    cleanups.push(() => again.stop());
    again.start();
    await until(() => first.eri.of('command.outcome').length === 2);
    again.replayAccepted();
    const by = (id: string) => first.eri.of('command.outcome').find((o) => (o as { command_id: string }).command_id === id);
    expect(by('op-a')).toMatchObject({ state: 'executed', detail: 'mapped' });
    expect(by('op-b')).toMatchObject({ state: 'uncertain' });
    // The body survived into the executing record, so recover could reconcile it.
    expect(seen[0]).toMatchObject({ t: 'test.cmd', value: 1 });
    expect(runs).toBe(0);
  });

  it('context.request round trip; a timeout resolves null and a late response is dropped', async () => {
    const { eri, link } = await setup();
    link.start();
    await until(() => link.ready);
    const ws = eri.sockets[0];
    const p = link.request({ t: 'context.request', req_id: 'r1', surf: 'surf-1', incarnation: 1, generation: 0 }, 2000);
    await until(() => eri.of('context.request').length === 1);
    eri.send(ws, { t: 'context.response', req_id: 'r1', text: 'Plan: do X', run_token: 'tok' });
    expect(await p).toMatchObject({ text: 'Plan: do X', run_token: 'tok' });

    const slow = link.request({ t: 'context.request', req_id: 'r2', surf: 'surf-1', incarnation: 1, generation: 0 }, 30);
    expect(await slow).toBeNull();
    eri.send(ws, { t: 'context.response', req_id: 'r2', text: 'too late' });
    await new Promise((r) => setTimeout(r, 20));
    expect(link.ready).toBe(true);
  });

  it('hello lists targets and stage C caps; runs.snapshot parts are assembled', async () => {
    const got: unknown[] = [];
    const { eri, link } = await setup({
      caps: () => ['turn', 'spawn'],
      targets: () => [{ id: 'proj', repo: '/r', harnesses: ['claude'], verify: ['test'] }],
      onRunsSnapshot: (runs) => got.push(runs),
    });
    link.start();
    await until(() => link.ready);
    expect(eri.of('hello')[0]).toMatchObject({ caps: ['turn', 'spawn'], targets: [{ id: 'proj', repo: '/r', harnesses: ['claude'], verify: ['test'] }] });
    const ws = eri.sockets[0];
    eri.send(ws, { t: 'runs.snapshot', part: { of: 'x', i: 2, n: 2 }, runs: [{ run_id: 'r2', generation: 1, desired: 'stop' }] });
    eri.send(ws, { t: 'runs.snapshot', part: { of: 'x', i: 1, n: 2 }, runs: [{ run_id: 'r1', generation: 3, desired: 'continue' }] });
    await until(() => got.length === 1);
    expect((got[0] as Array<{ run_id: string }>).map((r) => r.run_id)).toEqual(['r1', 'r2']);
  });
});

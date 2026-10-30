/**
 * The remote-host intent outbox (Astra review A-N1): a close, hide, rename,
 * move or group edit survives a dropped connection and an app restart at any
 * point between the click and the server's ack, is applied once, and an older
 * change never lands over a newer one.
 *
 * FakeHost below mirrors remote-server/src/hub.ts for these messages:
 * idempotent operations, one ack per request, broadcasts to the connection.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RemoteHostClient, type ClientTimers, type SocketLike } from '../../src/main/remote-hosts/host-client';
import { INTENT_MAX_ATTEMPTS, INTENT_TTL_MS, PendingIntents, type SecretBox } from '../../src/main/remote-hosts/host-config';
import { RemoteHosts } from '../../src/main/remote-hosts/index';
import { INBOX_GROUP_ID, PROTO, type GroupRecord, type SessionRecord } from '../../src/shared/remote-host-protocol';
import type { HostStatus } from '../../src/shared/remote-hosts-types';

const DEVICE = { id: 'dev-0123456789abcdef', name: 'laptop' };
const HOST = 'desk';

type Msg = Record<string, unknown> & { t: string };
/** What the fake does with the next intent message it gets. */
type Fault =
  | 'none'
  | 'lose'        // the connection dies before the server reads it
  | 'apply-drop'  // the server applies it, then the connection dies before the ack
  | 'hold'        // the server has not got round to it yet (see release())
  | 'apply-noack' // the server applies it and broadcasts the change; the ack is lost, the socket stays up
  | 'apply-silent'; // the server applies it; the ack and the broadcast are both lost, the socket stays up

const INTENT_TYPES = new Set(['close', 'groupClose', 'hide', 'unhide', 'sessionUpdate', 'groupUpsert']);

class FakeSocket implements SocketLike {
  readyState = 0;
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(private readonly host: FakeHost) {}
  on(ev: string, cb: (...a: never[]) => void): unknown {
    const list = this.handlers.get(ev) ?? [];
    list.push(cb as (...a: unknown[]) => void);
    this.handlers.set(ev, list);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(ev) ?? []) cb(...args);
  }
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('send on a closed socket');
    if (typeof data === 'string') this.host.receive(this, JSON.parse(data) as Msg);
  }
  close(): void {
    this.terminate();
  }
  terminate(): void {
    this.readyState = 3;
  }
  /** The TCP connection opens. */
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  /** The connection dies under both ends. */
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', 1006, '');
  }
  toClient(msg: Msg): void {
    if (this.readyState === 1) this.emit('message', JSON.stringify(msg), false);
  }
}

class FakeHost {
  readonly sessions = new Map<string, SessionRecord>();
  readonly groups = new Map<string, GroupRecord>();
  readonly tombstones = new Set<string>();
  /** Every intent message that reached the server. */
  readonly received: Msg[] = [];
  /** Intents that changed the registry. */
  readonly applied: string[] = [];
  readonly sockets: FakeSocket[] = [];
  fault: Fault = 'none';
  /** The device on the last hello. */
  deviceId = DEVICE.id;
  /** Faults stay on (for every intent) instead of firing once. */
  sticky = false;
  private held: Array<{ sock: FakeSocket; msg: Msg }> = [];
  private queue: Array<{ sock: FakeSocket; msg: Msg }> = [];
  private busy = false;

  readonly factory = (): SocketLike => {
    const s = new FakeSocket(this);
    this.sockets.push(s);
    return s;
  };

  get socket(): FakeSocket {
    return this.sockets[this.sockets.length - 1];
  }

  addSession(id: string, patch: Partial<SessionRecord> = {}): void {
    this.sessions.set(id, {
      id: id as SessionRecord['id'], groupId: INBOX_GROUP_ID, cwd: '/home/u', createdBy: 'dev-other0000', createdAt: 1,
      bootId: 'boot-1', state: 'live', hiddenBy: [], ...patch,
    });
  }

  addGroup(id: string, name: string, color?: string): void {
    this.groups.set(id, { id: id as GroupRecord['id'], name, color, createdBy: 'dev-other0000', createdAt: 1, updatedAt: 1 });
  }

  receive(sock: FakeSocket, msg: Msg): void {
    this.queue.push({ sock, msg });
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        this.handle(next.sock, next.msg);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * The server catches up with the intents it held, in order. `dropBeforeAcks`:
   * it applies them all, then the connection dies before any ack goes out.
   */
  release(opts: { dropBeforeAcks?: boolean } = {}): void {
    const held = this.held;
    this.held = [];
    for (const h of held) this.process(h.sock, h.msg, false, opts.dropBeforeAcks);
    if (opts.dropBeforeAcks) for (const h of held) h.sock.drop();
  }

  private handle(sock: FakeSocket, msg: Msg): void {
    if (msg.t === 'hello') {
      this.deviceId = (msg.device as { id: string }).id;
      sock.toClient({
        t: 'welcome', proto: PROTO, serverId: 'srv-1', bootId: 'boot-1', epoch: 'ep-1', hostname: 'desk', you: this.deviceId,
        groups: [...this.groups.values()].map((g) => ({ ...g })),
        sessions: [...this.sessions.values()].map((s) => ({ ...s, hiddenBy: [...s.hiddenBy] })),
        features: [],
      });
      return;
    }
    if (!INTENT_TYPES.has(msg.t)) return;
    const fault = this.fault;
    if (!this.sticky) this.fault = 'none';
    if (fault === 'lose') {
      sock.drop();
      return;
    }
    if (fault === 'hold') {
      this.held.push({ sock, msg });
      return;
    }
    if (fault === 'apply-noack') {
      this.received.push(msg);
      this.apply(sock, msg);
      return;
    }
    if (fault === 'apply-silent') {
      this.process(sock, msg, false, true);
      return;
    }
    this.process(sock, msg, fault === 'apply-drop');
  }

  private process(sock: FakeSocket, msg: Msg, dropBeforeAck = false, noAck = false): void {
    this.received.push(msg);
    const rid = msg.rid as number;
    const reply = this.apply(noAck ? new FakeSocket(this) : sock, msg);
    if (dropBeforeAck) {
      sock.drop();
      return;
    }
    if (!noAck) sock.toClient({ t: 'ack', rid, ...reply });
  }

  private apply(sock: FakeSocket, msg: Msg): { ok: boolean; error?: string } {
    const id = (msg.t === 'groupUpsert' ? (msg.group as { id: string }).id : msg.id) as string;
    switch (msg.t) {
      case 'close': {
        if (!this.tombstones.has(id)) {
          this.tombstones.add(id);
          this.sessions.delete(id);
          this.applied.push(`close ${id}`);
          sock.toClient({ t: 'sessionClosed', id, by: this.deviceId, reason: 'closed' });
        }
        return { ok: true };
      }
      case 'groupClose': {
        if (this.tombstones.has(id)) return { ok: true };
        this.tombstones.add(id);
        this.groups.delete(id);
        const removed = [...this.sessions.values()].filter((s) => s.groupId === id).map((s) => s.id);
        for (const sid of removed) this.sessions.delete(sid);
        this.applied.push(`groupClose ${id}`);
        sock.toClient({ t: 'groupClosed', id, sessionIds: removed, by: this.deviceId });
        return { ok: true };
      }
      case 'hide':
      case 'unhide': {
        const s = this.sessions.get(id);
        if (!s) return { ok: false, error: 'unknown session' };
        const was = s.hiddenBy.includes(this.deviceId);
        s.hiddenBy = msg.t === 'hide' ? [...new Set([...s.hiddenBy, this.deviceId])] : s.hiddenBy.filter((d) => d !== this.deviceId);
        if (was !== (msg.t === 'hide')) this.applied.push(`${msg.t} ${id}`);
        sock.toClient({ t: 'sessionUpdated', session: { ...s } });
        return { ok: true };
      }
      case 'sessionUpdate': {
        const s = this.sessions.get(id);
        if (!s) return { ok: false, error: 'unknown session' };
        const before = JSON.stringify(s);
        if (msg.groupId !== undefined) {
          const gid = (msg.groupId as string | null) ?? INBOX_GROUP_ID;
          if (gid !== INBOX_GROUP_ID && !this.groups.has(gid) && !this.tombstones.has(gid)) {
            this.addGroup(gid, (msg.group as { name?: string } | undefined)?.name ?? 'Workspace');
          }
          s.groupId = this.tombstones.has(gid) ? INBOX_GROUP_ID : (gid as SessionRecord['groupId']);
        }
        if (msg.title !== undefined) s.title = (msg.title as string | null) ?? undefined;
        if (JSON.stringify(s) !== before) this.applied.push(`sessionUpdate ${id} ${JSON.stringify({ title: s.title, groupId: s.groupId })}`);
        sock.toClient({ t: 'sessionUpdated', session: { ...s } });
        return { ok: true };
      }
      case 'groupUpsert': {
        if (this.tombstones.has(id)) return { ok: false, error: 'group closed' };
        const g = msg.group as { name: string; color?: string };
        const cur = this.groups.get(id);
        if (!cur || cur.name !== g.name || cur.color !== g.color) {
          this.groups.set(id, { id: id as GroupRecord['id'], name: g.name, color: g.color, createdBy: this.deviceId, createdAt: 1, updatedAt: 2 });
          this.applied.push(`groupUpsert ${id} ${g.name}`);
          sock.toClient({ t: 'groupUpserted', group: this.groups.get(id)! });
        }
        return { ok: true };
      }
    }
    return { ok: false, error: 'unhandled' };
  }
}

const timers: ClientTimers = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
};

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-outbox-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** One app run: the outbox loaded from disk, and a client for the host. */
class App {
  readonly intents: PendingIntents;
  readonly client: RemoteHostClient;
  status: HostStatus | undefined;
  constructor(readonly file: string, readonly host: FakeHost, now?: () => number, opts: { timers?: ClientTimers; requestTimeoutMs?: number } = {}) {
    this.intents = new PendingIntents(file, { now });
    this.client = new RemoteHostClient({
      hostId: HOST, url: () => 'ws://desk:7717', token: () => 'tok', device: DEVICE, appVersion: 'test',
      pinnedServerId: () => undefined, pinServer: () => {}, intents: this.intents,
      onStatus: (s) => { this.status = s; },
      socket: host.factory, timers: opts.timers ?? timers, now, requestTimeoutMs: opts.requestTimeoutMs,
    });
  }
  /** Start and get through hello/welcome (the outbox is replayed there). */
  connect(): this {
    this.client.start();
    this.host.socket.open();
    return this;
  }
  /** Start, but the host cannot be reached. */
  connectFails(): this {
    this.client.start();
    this.host.socket.drop();
    return this;
  }
  /** The app quits (or crashes): nothing in memory survives. */
  exit(): void {
    this.client.detachNow();
  }
  /** A fresh outbox read back from disk, for assertions. */
  disk(): PendingIntents {
    return new PendingIntents(this.file);
  }
}

function setup() {
  const host = new FakeHost();
  host.addSession('surf-a');
  host.addSession('surf-b');
  host.addSession('surf-c', { title: 'old' });
  host.addGroup('grp-w', 'Work', 'blue');
  const file = path.join(tmpDir(), 'remote-pending.json');
  return { host, file };
}

/** The same user actions in every fault scenario. */
function act(app: App): void {
  app.client.kill('surf-a');
  app.client.intent({ t: 'hide', id: 'surf-b' });
  app.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'renamed', groupId: 'grp-w' });
  app.client.intent({ t: 'groupUpsert', id: 'grp-w', name: 'Work 2', color: 'red' });
}

function expectFinal(host: FakeHost): void {
  expect(host.sessions.has('surf-a')).toBe(false);
  expect(host.sessions.get('surf-b')!.hiddenBy).toEqual([DEVICE.id]);
  expect(host.sessions.get('surf-c')).toMatchObject({ title: 'renamed', groupId: 'grp-w' });
  expect(host.groups.get('grp-w')).toMatchObject({ name: 'Work 2', color: 'red' });
  // Each change took effect exactly once.
  expect(host.applied.sort()).toEqual([
    'close surf-a',
    'groupUpsert grp-w Work 2',
    'hide surf-b',
    'sessionUpdate surf-c {"title":"renamed","groupId":"grp-w"}',
  ]);
}

describe('intent outbox: drops and restarts', () => {
  it('connection down before send: queued on disk, applied once after a restart', () => {
    const { host, file } = setup();
    const first = new App(file, host).connectFails();
    act(first);
    expect(host.received).toEqual([]);
    expect(first.status?.outbox?.pending).toBe(4);
    first.exit();

    const second = new App(file, host).connect();
    expectFinal(host);
    expect(host.received).toHaveLength(4);
    expect(second.disk().pending(HOST)).toEqual([]);
    expect(second.status?.outbox).toEqual({ pending: 0, failed: [] });
  });

  it('connected path persists before it sends', () => {
    const { host, file } = setup();
    const app = new App(file, host).connect();
    host.fault = 'hold';
    app.client.kill('surf-a');
    // Sent, not yet acknowledged: on disk, with the attempt counted.
    const onDisk = app.disk().pending(HOST);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ intent: { t: 'close', id: 'surf-a' }, attempts: 1 });
    host.release();
    expect(app.disk().pending(HOST)).toEqual([]);
  });

  it('dropped after send, before the server read it: resent after a restart, applied once', () => {
    const { host, file } = setup();
    const first = new App(file, host).connect();
    host.fault = 'lose';
    host.sticky = true;
    act(first);
    host.sticky = false;
    host.fault = 'none';
    expect(host.received).toEqual([]);
    expect(first.disk().pending(HOST)).toHaveLength(4);
    first.exit();

    const second = new App(file, host).connect();
    expectFinal(host);
    expect(host.received).toHaveLength(4);
    expect(second.disk().pending(HOST)).toEqual([]);
  });

  it('dropped after the server applied it, before the ack: the welcome proves it, nothing is resent', () => {
    const { host, file } = setup();
    const first = new App(file, host).connect();
    host.fault = 'hold';
    host.sticky = true;
    act(first);
    host.sticky = false;
    host.fault = 'none';
    host.release({ dropBeforeAcks: true });
    // Applied, never acknowledged.
    expect(host.received).toHaveLength(4);
    expect(first.disk().pending(HOST)).toHaveLength(4);
    first.exit();

    const second = new App(file, host).connect();
    expectFinal(host);
    expect(host.received).toHaveLength(4); // no resend
    expect(second.disk().pending(HOST)).toEqual([]);
    expect(second.status?.outbox).toEqual({ pending: 0, failed: [] });
  });

  it('dropped after apply, then reconnected in the same run (no restart): settled from the welcome', () => {
    const { host, file } = setup();
    const app = new App(file, host).connect();
    host.fault = 'apply-drop';
    app.client.kill('surf-a');
    expect(app.status?.outbox?.pending).toBe(1);
    app.client.wake(); // the retry fires
    host.socket.open();
    expect(host.received).toHaveLength(1);
    expect(host.applied).toEqual(['close surf-a']);
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
  });
});

describe('intent outbox: last writer wins per target', () => {
  it('an older rename applied without an ack never lands over a newer one made offline', () => {
    const { host, file } = setup();
    const first = new App(file, host).connect();
    host.fault = 'apply-drop';
    first.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'A' });
    first.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'B' }); // offline now
    const entries = first.disk().entries(HOST);
    expect(entries.map((e) => e.state)).toEqual(['superseded', 'pending']);
    first.exit();

    new App(file, host).connect();
    expect(host.sessions.get('surf-c')!.title).toBe('B');
    const titles = host.received.map((m) => m.title);
    expect(titles).toEqual(['A', 'B']); // A never again after B
  });

  it('an older rename lost in transit is never sent once a newer one exists', () => {
    const { host, file } = setup();
    const first = new App(file, host).connect();
    host.fault = 'lose';
    first.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'A' });
    first.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'B' });
    first.exit();
    new App(file, host).connect();
    expect(host.received.map((m) => m.title)).toEqual(['B']);
    expect(host.sessions.get('surf-c')!.title).toBe('B');
  });

  it('hide then unhide offline sends only the unhide', () => {
    const { host, file } = setup();
    host.sessions.get('surf-b')!.hiddenBy = [DEVICE.id]; // hidden here earlier
    const first = new App(file, host).connectFails();
    first.client.intent({ t: 'unhide', id: 'surf-b' });
    first.client.intent({ t: 'hide', id: 'surf-b' });
    first.client.intent({ t: 'unhide', id: 'surf-b' });
    first.exit();
    new App(file, host).connect();
    expect(host.received.map((m) => m.t)).toEqual(['unhide']);
    expect(host.sessions.get('surf-b')!.hiddenBy).toEqual([]);
    expect(new PendingIntents(file).pending(HOST)).toEqual([]);
  });

  it('a late ack for the older intent does not settle the newer one', () => {
    const { host, file } = setup();
    const app = new App(file, host).connect();
    host.fault = 'hold';
    host.sticky = true;
    app.client.intent({ t: 'groupUpsert', id: 'grp-w', name: 'One' });
    app.client.intent({ t: 'groupUpsert', id: 'grp-w', name: 'Two' }); // sent after One, on the same socket
    host.sticky = false;
    const p = new PendingIntents(file);
    expect(p.entries(HOST).map((e) => [e.intent.t === 'groupUpsert' && e.intent.name, e.state])).toEqual([['One', 'superseded'], ['Two', 'pending']]);
    host.release(); // One then Two, in order
    expect(host.groups.get('grp-w')!.name).toBe('Two');
    expect(app.disk().pending(HOST)).toEqual([]);
  });

  it('merges session metadata per field: a rename after a move keeps the move', () => {
    const p = new PendingIntents(path.join(tmpDir(), 'p.json'));
    p.add(HOST, { t: 'sessionUpdate', id: 'surf-c', groupId: 'grp-w', group: { name: 'Work' } });
    p.add(HOST, { t: 'sessionUpdate', id: 'surf-c', title: 'x' });
    p.add(HOST, { t: 'sessionUpdate', id: 'surf-c', title: null });
    expect(p.peek(HOST)).toEqual([{ t: 'sessionUpdate', id: 'surf-c', groupId: 'grp-w', group: { name: 'Work' }, title: null }]);
  });

  it('a close makes the pending changes to that session moot', () => {
    const p = new PendingIntents(path.join(tmpDir(), 'p.json'));
    p.add(HOST, { t: 'hide', id: 'surf-a' });
    p.add(HOST, { t: 'sessionUpdate', id: 'surf-a', title: 't' });
    p.add(HOST, { t: 'hide', id: 'surf-b' });
    p.add(HOST, { t: 'close', id: 'surf-a' });
    expect(p.peek(HOST)).toEqual([{ t: 'hide', id: 'surf-b' }, { t: 'close', id: 'surf-a' }]);
    const superseded = p.entries(HOST).filter((e) => e.state === 'superseded');
    expect(superseded).toHaveLength(2);
    expect(superseded.every((e) => e.supersededBy === p.pending(HOST)[1].iid)).toBe(true);
  });
});

describe('intent outbox: failure, expiry, migration', () => {
  it('a change the server refuses is reported failed and not retried', () => {
    const { host, file } = setup();
    host.sessions.delete('surf-b'); // closed on another device meanwhile
    const first = new App(file, host).connectFails();
    first.client.intent({ t: 'unhide', id: 'surf-b' });
    first.exit();
    const second = new App(file, host).connect();
    expect(second.status?.outbox?.pending).toBe(0);
    expect(second.status?.outbox?.failed).toEqual([expect.objectContaining({ t: 'unhide', id: 'surf-b', state: 'failed', error: 'unknown session' })]);
    second.exit();
    // Still reported after another restart; never resent.
    const third = new App(file, host).connect();
    expect(host.received).toHaveLength(1);
    expect(third.status?.outbox?.failed).toHaveLength(1);
    third.client.dismissOutboxFailures();
    expect(third.status?.outbox).toEqual({ pending: 0, failed: [] });
  });

  it('an intent that kills the connection every time fails after a bounded number of attempts', () => {
    const { host, file } = setup();
    host.fault = 'lose';
    host.sticky = true;
    const app = new App(file, host).connect();
    app.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'poison' });
    for (let i = 0; i < INTENT_MAX_ATTEMPTS + 2; i++) {
      app.client.wake();
      host.socket.open();
    }
    const [e] = app.disk().entries(HOST);
    expect(e).toMatchObject({ state: 'failed', attempts: INTENT_MAX_ATTEMPTS });
    expect(app.status?.outbox?.failed).toHaveLength(1);
  });

  it('an intent never applied within the TTL expires instead of replaying a stale choice', () => {
    const { host, file } = setup();
    let now = 1_000_000;
    const first = new App(file, host, () => now).connectFails();
    first.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'ancient' });
    first.exit();
    now += INTENT_TTL_MS + 1;
    const second = new App(file, host, () => now).connect();
    expect(host.received).toEqual([]);
    expect(host.sessions.get('surf-c')!.title).toBe('old');
    expect(second.status?.outbox?.failed).toEqual([expect.objectContaining({ state: 'expired', t: 'sessionUpdate' })]);
  });

  it('migrates the first on-disk format (a bare queue per host) on load', () => {
    const { host, file } = setup();
    fs.writeFileSync(file, JSON.stringify({
      desk: [{ t: 'unhide', id: 'surf-b' }, { t: 'close', id: 'surf-a' }, { t: 'close', id: '../bad' }],
      'Bad Host!': [{ t: 'close', id: 'surf-x' }],
    }));
    const p = new PendingIntents(file);
    expect(p.peek(HOST)).toEqual([{ t: 'unhide', id: 'surf-b' }, { t: 'close', id: 'surf-a' }]);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw).toMatchObject({ v: 2, hosts: { desk: [expect.objectContaining({ state: 'pending' }), expect.objectContaining({ state: 'pending' })] } });
    // And the migrated queue is replayed.
    new App(file, host).connect();
    expect(host.applied).toEqual(['close surf-a']);
    expect(new PendingIntents(file).pending(HOST)).toEqual([]);
  });

  it('ids are stable and sequence numbers keep growing across restarts', () => {
    const file = path.join(tmpDir(), 'p.json');
    const a = new PendingIntents(file).add(HOST, { t: 'hide', id: 'surf-a' });
    const reloaded = new PendingIntents(file);
    expect(reloaded.pending(HOST)[0].iid).toBe(a.iid);
    const b = reloaded.add(HOST, { t: 'hide', id: 'surf-b' });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(b.iid).not.toBe(a.iid);
  });
});

describe('intent outbox: what reconcile sees', () => {
  const box: SecretBox = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => b.toString().replace(/^enc:/, ''),
  };

  it('a close or hide still in the outbox keeps the tab out of the registry views', () => {
    const host = new FakeHost();
    host.addSession('surf-a');
    host.addSession('surf-b');
    host.addSession('surf-c');
    const dir = tmpDir();
    const make = () => new RemoteHosts({ dataDir: dir, box, appVersion: 'test', broadcast: () => {}, socket: host.factory });
    const first = make();
    first.save({ name: 'Desk', url: 'ws://desk.tail1234.ts.net:7717', token: 'tok' });
    host.socket.drop(); // unreachable
    first.client(HOST)!.kill('surf-a');
    first.hide(HOST, 'surf-b');
    first.detachAllNow();

    // Restart; the server holds the replayed intents for a moment.
    host.fault = 'hold';
    host.sticky = true;
    const second = make();
    second.save({ id: HOST, name: 'Desk', url: 'ws://desk.tail1234.ts.net:7717' });
    host.socket.open();
    const [view] = second.views();
    expect(view.connected).toBe(true);
    expect(view.sessions.map((s) => s.id)).not.toContain('surf-a');
    expect(view.closedIds).toContain('surf-a');
    const b = view.sessions.find((s) => s.id === 'surf-b')!;
    expect(b.hiddenBy).toContain(view.deviceId);
    // The server's own mirror still has both: only the view is overlaid.
    expect(second.client(HOST)!.sessions.has('surf-a')).toBe(true);

    host.sticky = false;
    host.fault = 'none';
    host.release();
    const [after] = second.views();
    expect(after.sessions.map((s) => s.id).sort()).toEqual(['surf-b', 'surf-c']);
    expect(after.sessions.find((s) => s.id === 'surf-b')!.hiddenBy).toEqual([view.deviceId]);
    expect(second.list()[0].status.outbox).toEqual({ pending: 0, failed: [] });
    second.detachAllNow();
  });
});

/**
 * Timeouts that run when told to: setTimeout fires on advance(); intervals
 * (the heartbeat) never do, so a quiet fake host is not declared dead.
 */
class ManualTimers implements ClientTimers {
  t = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  readonly now = (): number => this.t;
  setTimeout(fn: () => void, ms: number): unknown {
    const h = this.next++;
    this.pending.set(h, { at: this.t + ms, fn });
    return h;
  }
  clearTimeout(h: unknown): void {
    this.pending.delete(h as number);
  }
  setInterval(): unknown {
    return 0;
  }
  clearInterval(): void {}
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
}

describe('host status facts for the UI (Astra review A-S2)', () => {
  it('connectedAt while ready; lastSeenAt survives the drop', () => {
    const { host, file } = setup();
    const clock = new ManualTimers();
    clock.t = 1_000;
    const app = new App(file, host, clock.now, { timers: clock }).connect();
    expect(app.status).toMatchObject({ state: 'ready', connectedAt: 1_000, lastSeenAt: 1_000 });
    clock.t = 9_000;
    host.socket.drop();
    expect(app.status?.state).toBe('reconnecting');
    expect(app.status?.connectedAt).toBeUndefined();
    expect(app.status?.lastSeenAt).toBe(1_000);
  });

  it('the registry mirror follows agentState (sent in meta only), and reports tabs still re-opening', () => {
    const { host, file } = setup();
    const app = new App(file, host).connect();
    host.socket.toClient({ t: 'meta', id: 'surf-a', agentState: { state: 'needs_you', since: 5 } });
    expect(app.client.sessions.get('surf-a')?.agentState).toEqual({ state: 'needs_you', since: 5 });
    // A meta without agentState (a cwd report) leaves it alone.
    host.socket.toClient({ t: 'meta', id: 'surf-a', cwd: '/tmp' });
    expect(app.client.sessions.get('surf-a')?.agentState?.state).toBe('needs_you');

    void app.client.create({ id: 'surf-b' as never, cols: 80, rows: 24, spec: {} as never });
    expect(app.client.restoringIds()).toEqual(['surf-b']); // the fake never answers the open
  });
});

describe('request deadline (Astra review A-S1)', () => {
  function timed(requestTimeoutMs?: number) {
    const { host, file } = setup();
    const clock = new ManualTimers();
    const app = new App(file, host, clock.now, { timers: clock, requestTimeoutMs }).connect();
    return { host, file, clock, app };
  }

  /** The socket dies and the client reconnects at once (a fresh welcome). */
  function reconnect(app: App, host: FakeHost): void {
    host.socket.drop();
    app.client.wake();
    host.socket.open();
  }

  it('request() resolves uncertain at the deadline instead of hanging while the socket stays up', async () => {
    const { app, clock } = timed();
    let result: unknown;
    void app.client.request((rid) => ({ t: 'hooksInstall', rid })).then((r) => { result = r; });
    clock.advance(14_999);
    await Promise.resolve();
    expect(result).toBeUndefined();
    clock.advance(1);
    await Promise.resolve();
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(app.client.ready).toBe(true);
  });

  it('the deadline is configurable', async () => {
    const { app, clock } = timed(2_000);
    let result: { uncertain?: boolean } | undefined;
    void app.client.request((rid) => ({ t: 'hooksInstall', rid })).then((r) => { result = r; });
    clock.advance(2_000);
    await Promise.resolve();
    expect(result?.uncertain).toBe(true);
  });

  it('a request still waiting when the connection drops is uncertain too, not a plain failure', async () => {
    const { app, host } = timed();
    let result: unknown;
    void app.client.request((rid) => ({ t: 'hooksInstall', rid })).then((r) => { result = r; });
    host.socket.drop();
    await Promise.resolve();
    expect(result).toMatchObject({ ok: false, uncertain: true });
  });

  it('applied, ack and broadcast lost: uncertain, never resent on the live socket, settled by the next welcome, applied once', () => {
    const { app, host, clock, file } = timed();
    host.fault = 'apply-silent';
    app.client.intent({ t: 'hide', id: 'surf-b' });
    expect(host.applied).toEqual(['hide surf-b']);
    expect(app.status?.outbox).toEqual({ pending: 1, failed: [] });

    clock.advance(15_000);
    expect(app.status?.outbox).toEqual({ pending: 1, uncertain: 1, failed: [] });
    expect(app.disk().entries(HOST).map((e) => e.state)).toEqual(['uncertain']);
    // Minutes later, same socket: still not resent.
    clock.advance(120_000);
    expect(host.received).toHaveLength(1);

    reconnect(app, host);
    expect(host.received).toHaveLength(1);
    expect(host.applied).toEqual(['hide surf-b']);
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
    expect(new PendingIntents(file).entries(HOST)).toEqual([]);
  });

  it('applied, only the ack lost: the broadcast already in the mirror settles it at the deadline', () => {
    const { app, host, clock } = timed();
    host.fault = 'apply-noack';
    app.client.kill('surf-a');
    expect(app.status?.outbox?.pending).toBe(1);
    clock.advance(15_000);
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
    expect(host.received).toHaveLength(1);
    expect(host.applied).toEqual(['close surf-a']);
  });

  it('uncertain, then a broadcast shows it applied: settled without a reconnect', () => {
    const { app, host, clock } = timed();
    host.fault = 'apply-silent';
    app.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'renamed' });
    clock.advance(15_000);
    expect(app.status?.outbox?.uncertain).toBe(1);
    // Some later change to the session reaches this device, carrying the rename.
    host.socket.toClient({ t: 'sessionUpdated', session: { ...host.sessions.get('surf-c')! } });
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
    expect(host.received).toHaveLength(1);
  });

  it('never reached the server: uncertain until the welcome shows it unapplied, then resent exactly once', () => {
    const { app, host, clock } = timed();
    host.fault = 'hold'; // read but never processed; the socket stays up
    app.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'renamed', groupId: 'grp-w' });
    clock.advance(15_000);
    expect(app.status?.outbox?.uncertain).toBe(1);
    expect(host.received).toEqual([]);

    reconnect(app, host);
    expect(host.received).toHaveLength(1);
    expect(host.applied).toEqual(['sessionUpdate surf-c {"title":"renamed","groupId":"grp-w"}']);
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
  });

  it('a late ack after the deadline still settles the uncertain intent', () => {
    const { app, host, clock } = timed();
    host.fault = 'hold';
    app.client.intent({ t: 'groupUpsert', id: 'grp-w', name: 'Work 2', color: 'red' });
    clock.advance(15_000);
    expect(app.status?.outbox?.uncertain).toBe(1);
    host.release();
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
    expect(host.applied).toEqual(['groupUpsert grp-w Work 2']);
  });

  it('an uncertain intent still overlays the registry, and a newer one about the same target supersedes it', () => {
    const { app, host, clock } = timed();
    host.fault = 'hold';
    app.client.intent({ t: 'hide', id: 'surf-b' });
    clock.advance(15_000);
    expect(app.client.outboxOverlay().hiding.has('surf-b')).toBe(true);
    app.client.intent({ t: 'unhide', id: 'surf-b' }); // sent and acked at once
    expect(app.disk().entries(HOST).map((e) => [e.intent.t, e.state])).toEqual([['hide', 'superseded']]);
    reconnect(app, host);
    // The superseded hide is never sent again; the unhide is already true on the server.
    expect(host.received).toEqual([expect.objectContaining({ t: 'unhide' })]);
    expect(host.applied).toEqual([]);
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
  });

  it('an acked intent clears its deadline: nothing turns uncertain later', () => {
    const { app, host, clock } = timed();
    act(app);
    clock.advance(60_000);
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
    expectFinal(host);
  });

  it('every fault at once, then a reconnect: each change applied exactly once', () => {
    const { app, host, clock } = timed();
    host.fault = 'apply-silent';
    app.client.kill('surf-a');
    host.fault = 'hold';
    app.client.intent({ t: 'hide', id: 'surf-b' });
    host.fault = 'apply-noack';
    app.client.intent({ t: 'sessionUpdate', id: 'surf-c', title: 'renamed', groupId: 'grp-w' });
    host.fault = 'apply-silent';
    app.client.intent({ t: 'groupUpsert', id: 'grp-w', name: 'Work 2', color: 'red' });
    clock.advance(15_000);
    reconnect(app, host);
    clock.advance(15_000);
    expectFinal(host);
    expect(app.status?.outbox).toEqual({ pending: 0, failed: [] });
  });
});

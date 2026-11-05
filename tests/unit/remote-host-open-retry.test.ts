/**
 * A desktop that reconnects while the host is still probing a managed launcher
 * (host restart, launcher auto-update) gets `openError spawn-failed` for its
 * managed tabs. The host's boot recovery resumes those sessions itself once the
 * probe passes and broadcasts them live; the client must open again on that
 * broadcast instead of leaving the tab blank until the user clicks it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RemoteHostClient, type ClientTimers, type SocketLike } from '../../src/main/remote-hosts/host-client';
import { PendingIntents } from '../../src/main/remote-hosts/host-config';
import { INBOX_GROUP_ID, PROTO, type RemoteSurfaceId, type SessionRecord } from '../../src/shared/remote-host-protocol';

const DEVICE = { id: 'dev-0123456789abcdef', name: 'laptop' };
const SURF = 'surf-eri-managed' as RemoteSurfaceId;
type Msg = Record<string, unknown> & { t: string };

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
  emit(ev: string, ...args: unknown[]): void { for (const cb of this.handlers.get(ev) ?? []) cb(...args); }
  send(data: string | Uint8Array): void { if (typeof data === 'string') this.host.receive(this, JSON.parse(data) as Msg); }
  close(): void { this.readyState = 3; }
  terminate(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.emit('open'); }
  toClient(msg: Msg): void { if (this.readyState === 1) this.emit('message', JSON.stringify(msg), false); }
}

/** Mirrors remote-server/src/hub.ts for `open`: refuse while `probing`, attach once the session is live. */
class FakeHost {
  readonly opens: Msg[] = [];
  readonly sockets: FakeSocket[] = [];
  probing = true;
  session: SessionRecord = {
    id: SURF, groupId: INBOX_GROUP_ID, cwd: '/home/u', createdBy: 'dev-other0000', createdAt: 1,
    bootId: 'boot-1', state: 'lost', hiddenBy: [], incarnation: 1,
  };
  readonly factory = (): SocketLike => { const s = new FakeSocket(this); this.sockets.push(s); return s; };
  get socket(): FakeSocket { return this.sockets[this.sockets.length - 1]; }

  receive(sock: FakeSocket, msg: Msg): void {
    if (msg.t === 'hello') {
      sock.toClient({ t: 'welcome', proto: PROTO, serverId: 'srv-1', bootId: 'boot-2', epoch: 'ep-2', hostname: 'desk', you: DEVICE.id, groups: [], sessions: [{ ...this.session }], features: [] });
      return;
    }
    if (msg.t !== 'open') return;
    this.opens.push(msg);
    if (this.probing) {
      sock.toClient({ t: 'openError', rid: msg.rid, id: msg.id, code: 'spawn-failed', message: 'The managed agent launcher is still being verified; its saved conversation will resume when ready.' });
      return;
    }
    sock.toClient({ t: 'opened', rid: msg.rid, id: msg.id, mode: 'fresh', seq: 0, cols: 80, rows: 24, created: false, wasLost: true, state: 'live', owner: true });
  }

  /** The probe passed and boot recovery respawned the session: what the hub broadcasts. */
  probeDone(): void {
    this.probing = false;
    this.session = { ...this.session, state: 'live', incarnation: 2 };
    for (const s of this.sockets) s.toClient({ t: 'sessionUpdated', session: { ...this.session } });
  }
}

const timers: ClientTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function app() {
  const host = new FakeHost();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-open-retry-'));
  dirs.push(dir);
  const log: string[] = [];
  const client = new RemoteHostClient({
    hostId: 'desk', url: () => 'ws://desk:7717', token: () => 'tok', device: DEVICE, appVersion: 'test',
    pinnedServerId: () => undefined, pinServer: () => {}, intents: new PendingIntents(path.join(dir, 'pending.json')),
    onStatus: () => {}, log: (line: string) => log.push(line), socket: host.factory, timers, now: () => 1,
  });
  client.start();
  host.socket.open();
  return { host, client, log };
}

describe('open refused while the launcher is being probed', () => {
  it('opens again on its own when the host broadcasts the session live', async () => {
    const { host, client, log } = app();
    let settled = false;
    const created = client.create({ id: SURF, cols: 80, rows: 24, spec: {} }).then((r) => { settled = true; return r; });
    expect(host.opens).toHaveLength(1);
    await Promise.resolve();
    expect(settled).toBe(false); // the refusal is temporary: the tab keeps waiting
    expect(log.some((l) => l.includes('will open again when the host reports it live'))).toBe(true);

    host.probeDone();
    expect(host.opens).toHaveLength(2);
    await expect(created).resolves.toMatchObject({ existed: true });
    expect(log.some((l) => l.includes('is live again, opening it'))).toBe(true);
  });

  it('does not re-open on broadcasts for a session that is not live, and only once per refusal', () => {
    const { host, client } = app();
    void client.create({ id: SURF, cols: 80, rows: 24, spec: {} });
    expect(host.opens).toHaveLength(1);
    // A title change while still lost is not a reason to try.
    host.socket.toClient({ t: 'sessionUpdated', session: { ...host.session, title: 'renamed' } });
    expect(host.opens).toHaveLength(1);
    host.probeDone();
    expect(host.opens).toHaveLength(2);
    // Further broadcasts of the live session do not open it a third time.
    host.socket.toClient({ t: 'sessionUpdated', session: { ...host.session, title: 'again' } });
    expect(host.opens).toHaveLength(2);
  });

  it('leaves a tab alone that the user closed before the probe finished', () => {
    const { host, client } = app();
    void client.create({ id: SURF, cols: 80, rows: 24, spec: {} });
    client.release(SURF);
    host.probeDone();
    expect(host.opens).toHaveLength(1);
  });
});

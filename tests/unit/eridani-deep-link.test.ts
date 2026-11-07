/**
 * Open a run in Eridani from its terminal tab, and the run's terminal from
 * Eridani (task 03ff84bf).
 *
 *   - The tab's link is built from the session's Eridani binding; only an
 *     http(s) URL is ever built (it goes to shell.openExternal).
 *   - The app tells the server it understands `focus` (hello.features), and a
 *     server `focus` reaches the app's focus listener with the windows that
 *     show the tab.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { eridaniLinkForSurface, eridaniRunUrl, eridaniTabLink, eridaniTabTitle } from '../../src/shared/eridani-deep-link';
import { RemoteHostClient, type ClientTimers, type SocketLike } from '../../src/main/remote-hosts/host-client';
import { PendingIntents, type SecretBox } from '../../src/main/remote-hosts/host-config';
import { RemoteHosts } from '../../src/main/remote-hosts/index';
import { INBOX_GROUP_ID, PROTO, type EridaniBinding, type SessionRecord } from '../../src/shared/remote-host-protocol';

const RUN = '6f1c2a3b-0000-4000-8000-000000000001';

function binding(over: Partial<EridaniBinding> = {}): EridaniBinding {
  return {
    runId: RUN, generation: 3, attempt: 1, taskId: 'task-9', target: 'proj', harness: 'claude', model: 'sonnet',
    worktree: '/wt/x', branch: 'eri/x', base: 'main', baseSha: null, spawnOp: 'op-1', webUrl: 'https://app.eridani.app', ...over,
  };
}

describe('the run URL', () => {
  it('is <webUrl>/?view=remotea&run=<id>, with any trailing slash or query on the base dropped', () => {
    expect(eridaniRunUrl('https://app.eridani.app', RUN)).toBe(`https://app.eridani.app/?view=remotea&run=${RUN}`);
    expect(eridaniRunUrl('https://app.eridani.app/', RUN)).toBe(`https://app.eridani.app/?view=remotea&run=${RUN}`);
    expect(eridaniRunUrl('https://eri.example/app/?x=1#y', RUN)).toBe(`https://eri.example/app/?view=remotea&run=${RUN}`);
    expect(eridaniRunUrl('http://localhost:5173', RUN)).toBe(`http://localhost:5173/?view=remotea&run=${RUN}`);
  });

  it('is never built for another scheme, credentials, or an odd run id', () => {
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/system32/calc.exe', 'ms-settings:', 'data:text/html,x', 'wss://app.eridani.app', 'https://u:p@app.eridani.app', 'not a url', '']) {
      expect(eridaniRunUrl(bad, RUN), bad).toBeNull();
    }
    expect(eridaniRunUrl(undefined, RUN)).toBeNull();
    expect(eridaniRunUrl('https://app.eridani.app', '../../etc')).toBeNull();
    expect(eridaniRunUrl('https://app.eridani.app', 'a&b=c')).toBeNull();
    expect(eridaniRunUrl('https://app.eridani.app', '')).toBeNull();
  });

  it('a tab links only when its session is bound to a run and the server knows Eridani\'s web URL', () => {
    expect(eridaniTabLink({ eridani: binding({ taskTitle: 'Ship it' }) })).toEqual({
      url: `https://app.eridani.app/?view=remotea&run=${RUN}`, runId: RUN, taskId: 'task-9', taskTitle: 'Ship it', generation: 3,
    });
    expect(eridaniTabLink({ eridani: binding({ webUrl: undefined }) })).toBeNull();  // An older server.
    expect(eridaniTabLink({ eridani: binding({ webUrl: 'javascript:alert(1)' }) })).toBeNull();
    expect(eridaniTabLink({})).toBeNull();
    expect(eridaniTabLink(null)).toBeNull();
    expect(eridaniTabTitle(eridaniTabLink({ eridani: binding({ taskTitle: 'Ship it' }) })!)).toBe('Open in Eridani: Ship it');
    expect(eridaniTabTitle(eridaniTabLink({ eridani: binding() })!)).toBe('Open this run in Eridani');
  });

  it('finds a surface across the registry views', () => {
    const views = [
      { sessions: [{ id: 'surf-a' as const }] },
      { sessions: [{ id: 'surf-b' as const, eridani: binding() }] },
    ];
    expect(eridaniLinkForSurface(views, 'surf-b')?.runId).toBe(RUN);
    expect(eridaniLinkForSurface(views, 'surf-a')).toBeNull();
    expect(eridaniLinkForSurface(views, 'surf-zzz')).toBeNull();
    expect(eridaniLinkForSurface(null, 'surf-b')).toBeNull();
  });
});

// ── focus from the server ─────────────────────────────────────────────────

type Msg = Record<string, unknown> & { t: string };

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Msg[] = [];
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(ev: string, cb: (...a: never[]) => void): unknown {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb as (...a: unknown[]) => void]);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(ev) ?? []) cb(...args);
  }
  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as Msg;
    this.sent.push(msg);
    if (msg.t === 'hello') {
      this.toClient({ t: 'welcome', proto: PROTO, serverId: 'srv-1', bootId: 'boot-1', epoch: 'ep-1', hostname: 'desk', you: 'x', groups: [], sessions: [session('surf-run')], features: ['rpc', 'focus'] });
    }
  }
  close(): void { this.readyState = 3; }
  terminate(): void { this.readyState = 3; }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  toClient(msg: Msg): void {
    this.emit('message', JSON.stringify(msg), false);
  }
}

function session(id: string): SessionRecord {
  return { id: id as SessionRecord['id'], groupId: INBOX_GROUP_ID, cwd: '/wt/x', createdBy: 'eridani', createdAt: 1, bootId: 'boot-1', state: 'live', hiddenBy: [], eridani: binding() };
}

const timers: ClientTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };
const dirs: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-focus-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function client(onFocus?: (id: string, runId?: string, highlight?: boolean) => void) {
  const sock = new FakeSocket();
  const c = new RemoteHostClient({
    hostId: 'desk', url: () => 'ws://desk:7717', token: () => 'tok', device: { id: 'dev-0123456789abcdef', name: 'laptop' }, appVersion: 'test',
    pinnedServerId: () => undefined, pinServer: () => {}, intents: new PendingIntents(path.join(tmpDir(), 'pending.json')),
    onStatus: () => {}, socket: () => sock, timers, ...(onFocus ? { onFocus } : {}),
  });
  c.start();
  sock.open();
  return { c, sock };
}

describe('focus from the server', () => {
  it('hello lists the focus feature only when the app can act on it', () => {
    expect(client(() => {}).sock.sent[0]).toMatchObject({ t: 'hello', features: ['focus'] });
    expect(client().sock.sent[0]).not.toHaveProperty('features');
  });

  it('a focus message reaches the listener; a malformed one is dropped', () => {
    const got: Array<[string, string | undefined]> = [];
    const { sock } = client((id, runId) => got.push([id, runId]));
    sock.toClient({ t: 'focus', id: 'surf-run', runId: RUN });
    sock.toClient({ t: 'focus', id: 'not a surface' });
    sock.toClient({ t: 'focus', id: 'surf-run' });
    expect(got).toEqual([['surf-run', RUN], ['surf-run', undefined]]);
  });

  it('passes Tea highlights through and rejects malformed flags', () => {
    const got: Array<boolean | undefined> = [];
    const { sock } = client((_id, _runId, highlight) => got.push(highlight));
    sock.toClient({ t: 'focus', id: 'surf-run', highlight: true });
    sock.toClient({ t: 'focus', id: 'surf-run', highlight: 'yes' });
    sock.toClient({ t: 'focus', id: 'surf-run' });
    expect(got).toEqual([true, undefined]);
  });

  it('RemoteHosts hands the listener the windows that show the tab, oldest first', () => {
    const sockets: FakeSocket[] = [];
    const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
    const hosts = new RemoteHosts({ dataDir: tmpDir(), box, appVersion: 'test', broadcast: () => {}, socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    } });
    const calls: Array<[string, number[], boolean | undefined]> = [];
    hosts.setFocusListener((id, windows, highlight) => calls.push([id, windows, highlight]));
    hosts.report(7, () => {}, { ready: true, surfaceIds: ['surf-run'] });
    hosts.report(3, () => {}, { ready: true, surfaceIds: ['surf-run', 'surf-x'] });
    hosts.report(5, () => {}, { ready: true, surfaceIds: ['surf-x'] });
    hosts.save({ name: 'Desk', url: 'ws://desk.tail1234.ts.net:7717', token: 'tok' });
    const sock = sockets[sockets.length - 1];
    sock.open();
    expect(sock.sent[0]).toMatchObject({ t: 'hello', features: ['focus'] });
    sock.toClient({ t: 'focus', id: 'surf-run', runId: RUN });
    sock.toClient({ t: 'focus', id: 'surf-nowhere' });
    sock.toClient({ t: 'focus', id: 'surf-run', highlight: true });
    expect(calls).toEqual([
      ['surf-run', [3, 7], undefined], ['surf-nowhere', [], undefined],
      ['surf-run', [3, 7], true],
    ]);
    hosts.detachAllNow();
  });
});

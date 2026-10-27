import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { backoffDelay, initialFsm, step, AUTH_RETRY_MS, type Fsm, type FsmEvent } from '../../src/main/remote-hosts/connection-fsm';
import { HostStore, loadDevice, PendingIntents, validateHostUrl, type SecretBox } from '../../src/main/remote-hosts/host-config';
import { hostIdFromName, isRemoteShellSpec, parseRemoteShellSpec, remoteShellSpec } from '../../src/shared/remote-shell-spec';
import { decodeFrame, encodeInput, encodeOutput, parseClientMsg } from '../../src/shared/remote-host-protocol';

function run(events: FsmEvent[], from: Fsm = initialFsm()) {
  let fsm = from;
  const effects: string[] = [];
  for (const ev of events) {
    const r = step(fsm, ev, () => 0.5);
    fsm = r.fsm;
    effects.push(...r.effects.map((e) => (e.type === 'schedule-retry' ? `retry:${e.ms}` : e.type)));
  }
  return { fsm, effects };
}

describe('connection FSM', () => {
  it('connects, becomes ready, and reports down + schedules a retry when dropped', () => {
    const { fsm, effects } = run([{ type: 'start' }, { type: 'opened' }, { type: 'welcome' }, { type: 'closed' }]);
    expect(fsm.state).toBe('reconnecting');
    expect(effects).toEqual(['cancel-retry', 'connect', 'ready', 'down', 'retry:250']);
  });

  it('backs off exponentially up to 15 s with ±20 % jitter', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(250);
    expect(backoffDelay(3, () => 0.5)).toBe(2000);
    expect(backoffDelay(30, () => 0.5)).toBe(15000);
    expect(backoffDelay(30, () => 0)).toBe(12000);
    expect(backoffDelay(30, () => 1)).toBe(18000);
  });

  it('wake reconnects immediately from a backoff or from sleep', () => {
    const backoff = run([{ type: 'start' }, { type: 'closed' }, { type: 'closed' }]).fsm;
    expect(backoff.state).toBe('reconnecting');
    const woke = run([{ type: 'wake' }], backoff);
    expect(woke.fsm.state).toBe('connecting');
    expect(woke.effects).toEqual(['cancel-retry', 'connect']);
    const slept = run([{ type: 'start' }, { type: 'opened' }, { type: 'welcome' }, { type: 'suspend' }]);
    expect(slept.fsm.state).toBe('suspended');
    expect(slept.effects.slice(-3)).toEqual(['cancel-retry', 'disconnect', 'down']);
    expect(run([{ type: 'wake' }], slept.fsm).effects).toEqual(['cancel-retry', 'connect']);
  });

  it('a rejected token waits minutes, not milliseconds; a protocol mismatch never retries', () => {
    const auth = run([{ type: 'start' }, { type: 'auth-failed' }]);
    expect(auth.fsm.state).toBe('auth-failed');
    expect(auth.effects).toContain(`retry:${AUTH_RETRY_MS}`);
    const inc = run([{ type: 'start' }, { type: 'opened' }, { type: 'incompatible', error: 'v2' }]);
    expect(inc.fsm.state).toBe('incompatible');
    expect(inc.effects.some((e) => e.startsWith('retry'))).toBe(false);
    expect(run([{ type: 'wake' }, { type: 'retry' }], inc.fsm).fsm.state).toBe('incompatible');
  });

  it('a drop after being ready restarts the backoff from zero', () => {
    const { fsm } = run([{ type: 'start' }, { type: 'closed' }, { type: 'retry' }, { type: 'closed' }, { type: 'retry' }, { type: 'opened' }, { type: 'welcome' }]);
    expect(fsm.attempt).toBe(0);
    expect(run([{ type: 'closed' }], fsm).effects).toContain('retry:250');
  });
});

describe('remote shell specs', () => {
  it('parses host and optional command', () => {
    expect(parseRemoteShellSpec('remote:desk')).toEqual({ hostId: 'desk' });
    expect(parseRemoteShellSpec('remote:desk claude --resume x')).toEqual({ hostId: 'desk', command: 'claude --resume x' });
    expect(parseRemoteShellSpec('remote:Desk')).toEqual({ hostId: 'desk' });
    expect(parseRemoteShellSpec('pwsh.exe')).toBeNull();
    expect(parseRemoteShellSpec('remote:')).toBeNull();
    expect(parseRemoteShellSpec('remote:bad_host!')).toBeNull();
    expect(isRemoteShellSpec(undefined)).toBe(false);
    expect(remoteShellSpec('desk', 'codex')).toBe('remote:desk codex');
  });

  it('derives stable, unique host ids from names', () => {
    expect(hostIdFromName('Davis PC')).toBe('davis-pc');
    expect(hostIdFromName('Davis PC', new Set(['davis-pc']))).toBe('davis-pc-2');
    expect(hostIdFromName('!!!')).toBe('host');
  });
});

describe('wire frames', () => {
  it('round-trips output and input frames, including multi-byte text', () => {
    const out = decodeFrame(encodeOutput('surf-abc', 42, 'héllo 漢字\r\n'))!;
    expect(out).toEqual({ kind: 1, id: 'surf-abc', seq: 42, data: 'héllo 漢字\r\n' });
    const inp = decodeFrame(encodeInput('surf-abc', '\x1b[A'))!;
    expect(inp).toMatchObject({ kind: 2, id: 'surf-abc', data: '\x1b[A' });
    expect(decodeFrame(new Uint8Array([9, 0]))).toBeNull();
  });

  it('rejects malformed or dangerous client messages', () => {
    expect(parseClientMsg({ t: 'open', rid: 1, id: 'surf-a', cols: 80, rows: 24 })).not.toBeNull();
    expect(parseClientMsg({ t: 'open', rid: 1, id: '../etc', cols: 80, rows: 24 })).toBeNull();
    expect(parseClientMsg({ t: 'open', rid: 1, id: 'surf-a', cols: 80, rows: 24, create: { startupCommands: ['ok', 'two\nlines'] } })).toBeNull();
    expect(parseClientMsg({ t: 'open', rid: 1, id: 'surf-a', cols: 99999, rows: 24 })).toBeNull();
    expect(parseClientMsg({ t: 'nope' })).toBeNull();
  });
});

const fakeBox: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-hosts-'));
}

describe('HostStore', () => {
  it('stores the token encrypted and never in plain text', () => {
    const dir = tmp();
    const store = new HostStore(path.join(dir, 'hosts.json'), fakeBox);
    const { host } = store.save({ name: 'Desk', url: 'ws://desk:7717', token: 'secret-token' });
    expect(host.id).toBe('desk');
    expect(store.token('desk')).toBe('secret-token');
    const raw = fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8');
    expect(raw).not.toContain('secret-token');
    // Reloads from disk.
    expect(new HostStore(path.join(dir, 'hosts.json'), fakeBox).token('desk')).toBe('secret-token');
  });

  it('changing the URL drops the server pin; an empty token clears it', () => {
    const store = new HostStore(path.join(tmp(), 'hosts.json'), fakeBox);
    store.save({ name: 'Desk', url: 'ws://desk:7717', token: 't' });
    store.pinServer('desk', 'srv-1');
    expect(store.save({ id: 'desk', name: 'Desk', url: 'ws://desk:7717' }).reconnect).toBe(false);
    expect(store.get('desk')?.serverId).toBe('srv-1');
    expect(store.save({ id: 'desk', name: 'Desk', url: 'ws://other:7717' }).reconnect).toBe(true);
    expect(store.get('desk')?.serverId).toBeUndefined();
    store.save({ id: 'desk', name: 'Desk', url: 'ws://other:7717', token: '' });
    expect(store.token('desk')).toBeNull();
  });

  it('validates URLs', () => {
    expect(validateHostUrl(' ws://desk:7717/ ')).toBe('ws://desk:7717');
    expect(() => validateHostUrl('http://desk')).toThrow(/ws:\/\//);
    expect(() => validateHostUrl('ws://user:pw@desk')).toThrow(/token/);
  });

  it('refuses to save a token without secure storage', () => {
    const store = new HostStore(path.join(tmp(), 'hosts.json'), { ...fakeBox, isEncryptionAvailable: () => false });
    expect(() => store.save({ name: 'Desk', url: 'ws://desk:7717', token: 't' })).toThrow(/Secure storage/);
  });
});

describe('device identity and pending intents', () => {
  it('device id is created once and reused', () => {
    const file = path.join(tmp(), 'device.json');
    const a = loadDevice(file);
    expect(a.id).toMatch(/^dev-[0-9a-f]{16}$/);
    expect(loadDevice(file).id).toBe(a.id);
  });

  it('later intents for the same target supersede earlier ones and survive a restart', () => {
    const file = path.join(tmp(), 'pending.json');
    const p = new PendingIntents(file);
    p.add('desk', { t: 'hide', id: 'surf-1' });
    p.add('desk', { t: 'unhide', id: 'surf-1' });
    p.add('desk', { t: 'close', id: 'surf-2' });
    const reloaded = new PendingIntents(file);
    expect(reloaded.take('desk')).toEqual([{ t: 'unhide', id: 'surf-1' }, { t: 'close', id: 'surf-2' }]);
    expect(new PendingIntents(file).peek('desk')).toEqual([]);
  });
});

describe('TerminalRouter', () => {
  it('routes by spec, keeps local behaviour, and only detaches remote sessions on killAll', async () => {
    const { TerminalRouter } = await import('../../src/main/terminal-router');
    const local = {
      create: vi.fn(() => ({ id: 'surf-l', shell: 'pwsh.exe', startupCommandsConsumed: false, reused: false })),
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(), killAll: vi.fn(), has: vi.fn(() => false),
      onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}), getPid: vi.fn(() => 123),
      liveSurfaceIds: vi.fn(() => []), count: vi.fn(() => 2), deliverCommands: vi.fn(() => true),
    };
    const client = {
      create: vi.fn(async () => ({ reused: false, existed: true, snapshot: { data: 'x', cols: 80, rows: 24 } })),
      write: vi.fn(), kill: vi.fn(), owns: (id: string) => id === 'surf-r', has: () => true,
    };
    const remote = {
      client: (id: string) => (id === 'desk' ? client : undefined),
      clientOwning: (id: string) => (id === 'surf-r' ? client : undefined),
      owns: (id: string) => id === 'surf-r',
      detachAllNow: vi.fn(),
    };
    const router = new TerminalRouter(local as never, remote as never);
    const res = await router.create({ shell: 'remote:desk claude', cwd: 'C:\\Users\\me', env: {}, surfaceId: 'surf-r' as never, cols: 100, rows: 30 });
    expect(res).toMatchObject({ id: 'surf-r', remote: true, snapshot: { data: 'x' } });
    // A Windows path means nothing on the server; the command rides in the spec.
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ spec: expect.objectContaining({ cmd: 'claude', cwd: undefined }) }));
    await expect(router.create({ shell: 'remote:nowhere', cwd: '', env: {} })).rejects.toThrow(/Unknown remote host/);
    router.write('surf-r' as never, 'a');
    router.write('surf-l' as never, 'b');
    expect(client.write).toHaveBeenCalledWith('surf-r', 'a');
    expect(local.write).toHaveBeenCalledWith('surf-l', 'b');
    expect(router.getPid('surf-r' as never)).toBeUndefined();
    expect(router.getPid('surf-l' as never)).toBe(123);
    // A never-mounted remote tab is still closed on its host via the spec.
    router.kill('surf-unmounted' as never, 'remote:desk');
    expect(client.kill).toHaveBeenCalledWith('surf-unmounted');
    router.killAll();
    expect(local.killAll).toHaveBeenCalled();
    expect(remote.detachAllNow).toHaveBeenCalled();
    expect(router.count()).toBe(2);
  });
});

/**
 * Open the run's terminal from Eridani, and Eridani from the terminal (task 03ff84bf).
 *
 *   - A spawn's binding carries Eridani's web URL (eridani.json `webUrl`, else
 *     derived from the link URL) and the task title, for the desktop's
 *     "Open in Eridani"; older bindings are backfilled.
 *   - `terminal.focus` (advertised in hello): the hub tells every connected
 *     app that listed the `focus` feature to bring the tab to the front.
 *     `executed` with `result.desktops` when one was told, `rejected`
 *     `no_desktop` when none, `unknown_surf` when the surface is gone or not
 *     the run's.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { commandShapeError, parseUpFrame, STAGE_F_CAPS, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { parseClientMsg, parseServerMsg, type EridaniBinding } from '../../src/shared/remote-host-protocol';
import { normalizeWebUrl, resolveWebUrl, saveEridaniConfig, webUrlFromLink, writeEridaniFile, readEridaniFile, writeEridaniToken } from '../src/config';
import { Dispatch } from '../src/dispatch';
import { EridaniRuntime } from '../src/eridani-runtime';
import { Hub } from '../src/hub';
import { QuestionBroker } from '../src/questions-claude';
import { Registry } from '../src/registry';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import type { CommandBody } from '../../src/shared/eridani-link-protocol';
import { FakeConn, fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-focus-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const DESK = 'device-desktop1';
const LAPTOP = 'device-laptop01';
const SURF = 'surf-eri-focus';
const RUN = '6f1c2a3b-0000-4000-8000-000000000001';

function binding(over: Partial<EridaniBinding> = {}): EridaniBinding {
  return {
    runId: RUN, generation: 2, attempt: 1, taskId: 'task-1', target: 'proj', harness: 'claude', model: 'sonnet',
    worktree: '/wt/eri--task-1', branch: 'eri/task-1', base: 'main', baseSha: null, spawnOp: 'op-spawn-1', ...over,
  };
}

/** A hub with one live session; `connect` adds an app that may or may not understand `focus`. */
function hubSetup() {
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  let next = 1;
  const connect = (device: string, features?: string[]) => {
    const c = new FakeConn(next++);
    hub.connect(c);
    hub.handle(c, { t: 'hello', proto: 1, device: { id: device, name: device }, app: { name: 'test', version: '0' }, ...(features ? { features: features as 'focus'[] } : {}) });
    return c;
  };
  const opener = connect('device-opener01');
  hub.handle(opener, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24, create: { cwd: '/wt/eri--task-1' } });
  hub.handle(opener, { t: 'detach', ids: [SURF] });
  hub.updateRecord(SURF, { eridani: binding() });
  return { hub, registry, connect };
}

describe('Eridani web URL', () => {
  it('is derived from the link URL: wss → https, ws only to this machine', () => {
    expect(webUrlFromLink('wss://app.eridani.app/api/v1/external/agents/link')).toBe('https://app.eridani.app');
    expect(webUrlFromLink('wss://eri.example:8443/x')).toBe('https://eri.example:8443');
    expect(webUrlFromLink('ws://localhost:8000/api/v1/external/agents/link')).toBe('http://localhost:8000');
    expect(webUrlFromLink('ws://10.0.0.5/link')).toBeNull();
    expect(webUrlFromLink('not a url')).toBeNull();
  });

  it('an explicit webUrl must be https (http only to this machine) and is normalized', () => {
    expect(normalizeWebUrl('https://eri.example/app/')).toBe('https://eri.example/app');
    expect(normalizeWebUrl('https://eri.example/?view=x#y')).toBe('https://eri.example');
    expect(normalizeWebUrl('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(normalizeWebUrl('http://eri.example')).toBeNull();
    expect(normalizeWebUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeWebUrl('https://user:pw@eri.example')).toBeNull();
    expect(normalizeWebUrl(42)).toBeNull();
  });

  it('resolveWebUrl prefers eridani.json webUrl, else the link URL, else null', () => {
    const dir = tmpDir();
    expect(resolveWebUrl(dir)).toBeNull();
    saveEridaniConfig(dir, { enabled: true, url: 'wss://app.eridani.app/api/v1/external/agents/link', collector: 'parity' });
    expect(resolveWebUrl(dir)).toBe('https://app.eridani.app');
    writeEridaniFile(dir, { ...readEridaniFile(dir), webUrl: 'https://staging.eridani.app/' });
    expect(resolveWebUrl(dir)).toBe('https://staging.eridani.app');
    writeEridaniFile(dir, { ...readEridaniFile(dir), webUrl: 'ftp://nope' });
    expect(resolveWebUrl(dir)).toBeNull();  // A bad explicit value is not silently replaced by a guess.
  });
});

describe('the binding links back to Eridani', () => {
  const TARGET: ExecutionTarget = { id: 'proj', repo: '/repo', worktreeRoot: '/wt', base: 'main', launch: { claude: {} }, verify: [] };

  function dispatchSetup(webUrl: string | null) {
    const registry = Registry.load({ file: null, bootId: 'boot-1' });
    const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
    let url = webUrl;
    const dispatch = new Dispatch({
      hub, registry, dir: null,
      worktrees: { ensure: async (t: ExecutionTarget, branch: string, base: string) => ({ path: `${t.worktreeRoot}/x`, branch, base, baseSha: 'abc', created: true }) } as unknown as WorktreeManager,
      targets: () => [TARGET],
      questions: new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} }),
      emit: () => {},
      linkReady: () => true,
      webUrl: () => url,
    });
    hub.setEridani(dispatch.hubHooks());
    const spawn = (over: Record<string, unknown> = {}) => dispatch.handlers().spawn({
      t: 'spawn', op_id: `op-${Math.random()}`, digest: 'd', run_id: RUN, generation: 1, attempt: 1, harness: 'claude', model: 'sonnet',
      target: { id: 'proj', branch: 'eri/task-1' }, task_id: 'task-1', prompt: 'go', expires_at: Date.now() + 60_000, ...over,
    } as unknown as CommandBody, { begin: () => {} });
    return { registry, hub, dispatch, spawn, setUrl: (u: string | null) => (url = u) };
  }

  it('a spawn records the web URL and the task title it carried, and nothing it did not', async () => {
    const { registry, spawn } = dispatchSetup('https://app.eridani.app');
    const res = await spawn({ title: 'Ship the focus button' });
    const rec = registry.session(String((res.result as { surf: string }).surf))!;
    expect(rec.eridani).toMatchObject({ runId: RUN, taskId: 'task-1', generation: 1, webUrl: 'https://app.eridani.app', taskTitle: 'Ship the focus button' });

    const bare = dispatchSetup(null);
    const res2 = await bare.spawn({ task_id: undefined });
    const rec2 = bare.registry.session(String((res2.result as { surf: string }).surf))!;
    expect(rec2.eridani).not.toHaveProperty('webUrl');
    expect(rec2.eridani).not.toHaveProperty('taskTitle');
    expect(rec2.eridani!.taskId).toBeNull();
  });

  it('backfills older bindings once the URL is known, never overwriting one, and announces the change', async () => {
    const { registry, hub, dispatch, spawn, setUrl } = dispatchSetup(null);
    const res = await spawn();
    const surf = String((res.result as { surf: string }).surf);
    hub.updateRecord('surf-other', {});  // unknown id: nothing
    const desk = new FakeConn(9);
    hub.connect(desk);
    hub.handle(desk, { t: 'hello', proto: 1, device: { id: DESK, name: 'desk' }, app: { name: 't', version: '0' } });
    expect(dispatch.backfillWebUrl()).toBe(0);
    setUrl('https://app.eridani.app');
    expect(dispatch.backfillWebUrl()).toBe(1);
    expect(registry.session(surf)!.eridani!.webUrl).toBe('https://app.eridani.app');
    expect(desk.json('sessionUpdated').at(-1)!.session.eridani!.webUrl).toBe('https://app.eridani.app');
    setUrl('https://elsewhere.example');
    expect(dispatch.backfillWebUrl()).toBe(0);
    expect(registry.session(surf)!.eridani!.webUrl).toBe('https://app.eridani.app');
  });
});

describe('hub: focus', () => {
  it('welcome offers focus; hello may list features (bounded), and focus frames parse', () => {
    const { connect } = hubSetup();
    expect(connect(DESK, ['focus']).json('welcome')[0].features).toContain('focus');
    const hello = { t: 'hello', proto: 1, device: { id: DESK, name: 'd' }, app: { name: 'a', version: '1' } };
    expect(parseClientMsg({ ...hello, features: ['focus', 'something-newer'] })).not.toBeNull();
    expect(parseClientMsg(hello)).not.toBeNull();
    expect(parseClientMsg({ ...hello, features: 'focus' })).toBeNull();
    expect(parseClientMsg({ ...hello, features: Array(17).fill('focus') })).toBeNull();
    expect(parseServerMsg({ t: 'focus', id: SURF, runId: RUN })).toEqual({ t: 'focus', id: SURF, runId: RUN });
    expect(parseServerMsg({ t: 'focus', id: 'not-a-surface' })).toBeNull();
  });

  it('tells only the apps that understand focus and have not hidden the session', () => {
    const { hub, connect } = hubSetup();
    expect(hub.focus(SURF, RUN)).toBe(0);  // Only the opener (no focus feature) is connected.
    const old = connect('device-oldapp01');
    const desk = connect(DESK, ['focus']);
    const laptop = connect(LAPTOP, ['focus']);
    hub.handle(laptop, { t: 'hide', rid: 2, id: SURF });
    expect(hub.focus(SURF, RUN)).toBe(1);
    expect(desk.json('focus')).toEqual([{ t: 'focus', id: SURF, runId: RUN }]);
    expect(laptop.json('focus')).toEqual([]);
    expect(old.json('focus')).toEqual([]);
    expect(hub.focus('surf-gone')).toBe(0);
  });
});

type Frame = UpFrame & Record<string, unknown>;

/** Welcomes the host, acks its ops, sends commands down and keeps their acks and outcomes. */
class FakeEridani {
  readonly wss: WebSocketServer;
  readonly frames: Frame[] = [];
  readonly acks: Array<Record<string, unknown>> = [];
  epoch = 0;
  private ws: WebSocket | null = null;
  constructor() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws: WebSocket) => {
      this.ws = ws;
      ws.on('message', (data) => {
        const raw = JSON.parse(String(data)) as Record<string, unknown>;
        if (raw.t === 'ack') {
          this.acks.push(raw);
          return;
        }
        const f = parseUpFrame(raw) as Frame | null;
        if (!f) return;
        this.frames.push(f);
        if (f.t === 'hello') this.send({ t: 'welcome', host_id: 'host-1', conn_epoch: ++this.epoch, server_time: Date.now(), caps: [] });
        else if ('op_id' in f) this.send({ t: 'ack', acked_id: f.id, ok: true });
      });
    });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}/link`;
  }
  get connected(): boolean {
    return !!this.ws;
  }
  send(body: Record<string, unknown>): string {
    const id = `e-${Math.random().toString(36).slice(2)}`;
    this.ws!.send(JSON.stringify({ v: 1, id, conn_epoch: this.epoch, at: Date.now(), ...body }));
    return id;
  }
  outcome(op: string): Frame | undefined {
    return this.frames.find((f) => f.t === 'command.outcome' && f.command_id === op);
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

describe('terminal.focus over the link', () => {
  async function setup() {
    const eri = new FakeEridani();
    cleanups.push(() => eri.close());
    await new Promise((r) => eri.wss.once('listening', r));
    const dir = tmpDir();
    writeEridaniToken(dir, 'eri_bot_test0123456789');
    saveEridaniConfig(dir, { enabled: true, url: eri.url, machine: 'focus-box', collector: 'off' });
    const { hub, registry, connect } = hubSetup();
    const rt = new EridaniRuntime({
      dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '9.9.9',
      log: () => {}, windowsUsers: null, checkMs: 3_600_000, scanMs: 3_600_000, resumeAgents: false,
      probe: async () => ({ ok: true, version: '1.0.0' }),
    });
    cleanups.push(() => rt.stop());
    rt.start();
    await until(() => !!rt.current?.ready && eri.connected);
    let seq = 0;
    const focus = async (over: Record<string, unknown> = {}) => {
      const op = `op-focus-${++seq}`;
      eri.send({ t: 'terminal.focus', op_id: op, command_id: op, surf: SURF, run_id: RUN, generation: 2, expires_at: Date.now() + 30_000, ...over });
      await until(() => !!eri.outcome(op));
      return eri.outcome(op)!;
    };
    return { eri, hub, registry, connect, focus };
  }

  it('is advertised in hello', async () => {
    const { eri } = await setup();
    expect(STAGE_F_CAPS).toContain('terminal.focus');
    expect(eri.frames.find((f) => f.t === 'hello')!.caps).toContain('terminal.focus');
  });

  it('no app connected that understands focus: rejected no_desktop, so Eridani shows where the terminal is', async () => {
    const { focus, connect } = await setup();
    connect('device-oldapp01');  // An app from before `focus`: it would drop the message.
    expect(await focus()).toMatchObject({ state: 'rejected', detail: 'no_desktop', kind: 'terminal.focus' });
  });

  it('a connected desktop gets the focus message; the outcome is executed with how many were told', async () => {
    const { focus, connect } = await setup();
    const desk = connect(DESK, ['focus']);
    expect(await focus()).toMatchObject({ state: 'executed', result: { desktops: 1 } });
    expect(desk.json('focus')).toEqual([{ t: 'focus', id: SURF, runId: RUN }]);
    // A stale generation is harmless: focus is not fenced on it.
    expect(await focus({ generation: 1 })).toMatchObject({ state: 'executed' });
  });

  it('a surface that is gone, exited or not the run\'s is unknown_surf', async () => {
    const { focus, connect, hub } = await setup();
    connect(DESK, ['focus']);
    expect(await focus({ surf: 'surf-eri-nothere' })).toMatchObject({ state: 'rejected', detail: 'unknown_surf' });
    expect(await focus({ run_id: 'another-run' })).toMatchObject({ state: 'rejected', detail: 'unknown_surf' });
    hub.updateRecord(SURF, { state: 'exited' });
    expect(await focus()).toMatchObject({ state: 'rejected', detail: 'unknown_surf' });
  });

  it('needs expires_at and a fence, and an expired one is refused', async () => {
    const { focus } = await setup();
    expect(commandShapeError({ t: 'terminal.focus', surf: SURF, run_id: RUN, generation: 1 })).toBe('expires_at required');
    expect(commandShapeError({ t: 'terminal.focus', surf: SURF, generation: 1, expires_at: Date.now() + 1000 })).toBe('bad fence');
    expect(await focus({ expires_at: Date.now() - 1000 })).toMatchObject({ state: 'rejected', detail: 'expired' });
  });
});

/**
 * `worktrees.scan` (Eridani PR #94, the judge's PR evidence): advertised in
 * hello; on the command the host sends a fresh worktrees.report and the named
 * session's session.report even when neither changed, then `executed`. An
 * expired scan is rejected; a stale fence is not; a scan the journal cannot
 * record is refused as journal_unavailable.
 *
 * The runtime runs against a fake Eridani, the collector fixture home (the
 * fake sessions) and no execution targets (an empty, unchanging worktree list).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { commandShapeError, parseUpFrame, STAGE_F_CAPS, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { saveEridaniConfig, writeEridaniToken } from '../src/config';
import { COLLECTOR_STATE_FILES, EridaniRuntime } from '../src/eridani-runtime';
import { JOURNAL_FILE } from '../src/eridani-link';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { fakeSpawner, ManualTimers } from './helpers';

const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'collector', 'home');
const SESSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Frame = UpFrame & Record<string, unknown>;
type Ack = { t: 'ack'; acked_id: string; op_id?: string; ok: boolean; error?: string; outcome?: { state: string; detail?: string; durable?: boolean } };

/** Acks every upward op; sends commands down and keeps the acks they get. */
class FakeEridani {
  readonly wss: WebSocketServer;
  readonly frames: Frame[] = [];
  readonly acks: Ack[] = [];
  epoch = 0;
  private ws: WebSocket | null = null;
  constructor() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws: WebSocket) => {
      this.ws = ws;
      ws.on('message', (data) => {
        const raw = JSON.parse(String(data)) as Record<string, unknown>;
        if (raw.t === 'ack') {
          this.acks.push(raw as unknown as Ack);
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
  send(body: Record<string, unknown>): string {
    const id = `e-${Math.random().toString(36).slice(2)}`;
    this.ws!.send(JSON.stringify({ v: 1, id, conn_epoch: this.epoch, at: Date.now(), ...body }));
    return id;
  }
  of(t: string): Frame[] {
    return this.frames.filter((f) => f.t === t);
  }
  outcome(op: string): Frame | undefined {
    return this.frames.find((f) => f.t === 'command.outcome' && f.command_id === op);
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

async function setup() {
  const eri = new FakeEridani();
  cleanups.push(() => eri.close());
  await new Promise((r) => eri.wss.once('listening', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-wtscan-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeEridaniToken(dir, 'eri_bot_test0123456789');
  saveEridaniConfig(dir, { enabled: true, url: eri.url, machine: 'scan-box', collector: 'parity' });
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const logs: string[] = [];
  const rt = new EridaniRuntime({
    dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '9.9.9',
    log: (m) => logs.push(m),
    collectorHome: FIXTURE_HOME,
    windowsUsers: null,
    checkMs: 3_600_000,
    scanMs: 3_600_000,
    resumeAgents: false,
    probe: async () => ({ ok: true, version: '1.0.0' }),
  });
  cleanups.push(() => rt.stop());
  rt.start();
  // Settle: the first scan's reports are all acked and recorded, and the first worktrees.report went out.
  await until(() => logs.some((l) => /report\(s\) queued/.test(l)));
  const queued = Number(/(\d+) report\(s\) queued/.exec(logs.find((l) => /report\(s\) queued/.test(l))!)![1]);
  const recorded = () => {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(path.join(dir, COLLECTOR_STATE_FILES.parity), 'utf8')).sessions).length;
    } catch {
      return 0;
    }
  };
  await until(() => recorded() === queued && eri.of('worktrees.report').length === 1);
  const entity = eri.of('session.report').map((f) => String(f.entity)).find((e) => e.endsWith(`:${SESSION_ID}`))!;
  expect(entity).toBeTruthy();
  return { eri, dir, rt, logs, entity, tool: entity.slice(0, entity.indexOf(':')) };
}

let opSeq = 0;
function scanCommand(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: 'worktrees.scan',
    op_id: `op-scan-${++opSeq}`,
    run_id: 'run-1',
    generation: 1,
    branch: 'eri/task-1',
    turn_seq: 3,
    expires_at: Date.now() + 120_000,
    ...over,
  };
}

describe('worktrees.scan', () => {
  it('is advertised in hello (stage F caps)', async () => {
    expect(STAGE_F_CAPS).toContain('worktrees.scan');
    const { eri } = await setup();
    const hello = eri.of('hello')[0] as unknown as { caps: string[] };
    expect(hello.caps).toContain('worktrees.scan');
  });

  it('sends worktrees.report and the session report even when unchanged, then executed', async () => {
    const { eri, entity, tool } = await setup();
    const wt0 = eri.of('worktrees.report');
    const sr0 = eri.of('session.report').filter((f) => f.entity === entity);
    expect(sr0).toHaveLength(1);
    // A stale fence (an unknown run, an old generation) is harmless: not rejected.
    const cmd = scanCommand({ run_id: 'run-gone', generation: 0, tool, session_id: SESSION_ID });
    const id = eri.send(cmd);
    await until(() => !!eri.outcome(cmd.op_id as string));
    const ack = eri.acks.find((a) => a.acked_id === id)!;
    expect(ack).toMatchObject({ ok: true, outcome: { state: 'accepted' } });
    const out = eri.outcome(cmd.op_id as string)!;
    expect(out).toMatchObject({ state: 'executed', kind: 'worktrees.scan', result: { worktrees: 'reported', session: 'reported' } });
    await until(() => eri.of('worktrees.report').length === 2 && eri.of('session.report').filter((f) => f.entity === entity).length === 2);
    // Same content, sent again: nothing changed on disk.
    const wt = eri.of('worktrees.report');
    expect(wt[1].worktrees).toEqual(wt0[0].worktrees);
    const sr = eri.of('session.report').filter((f) => f.entity === entity);
    expect(sr[1].revision).toBe(sr0[0].revision);
    expect(sr[1].report).toEqual(sr0[0].report);
    // Only the named session was re-sent.
    expect(eri.of('session.report').length).toBe(new Set(eri.of('session.report').map((f) => f.entity)).size + 1);
  });

  it('without a session: only the worktrees are reported', async () => {
    const { eri } = await setup();
    const sessions = eri.of('session.report').length;
    const cmd = scanCommand();
    eri.send(cmd);
    await until(() => !!eri.outcome(cmd.op_id as string));
    expect(eri.outcome(cmd.op_id as string)).toMatchObject({ state: 'executed', result: { worktrees: 'reported' } });
    expect((eri.outcome(cmd.op_id as string)!.result as Record<string, unknown>).session).toBeUndefined();
    await until(() => eri.of('worktrees.report').length === 2);
    expect(eri.of('session.report').length).toBe(sessions);
  });

  it('a session this host does not have is still executed, and says so', async () => {
    const { eri, tool } = await setup();
    const cmd = scanCommand({ tool, session_id: 'not-a-session-here' });
    eri.send(cmd);
    await until(() => !!eri.outcome(cmd.op_id as string));
    expect(eri.outcome(cmd.op_id as string)).toMatchObject({ state: 'executed', result: { worktrees: 'reported', session: 'not_found' } });
  });

  it('an expired scan is rejected and nothing is rescanned', async () => {
    const { eri, entity, tool } = await setup();
    const cmd = scanCommand({ tool, session_id: SESSION_ID, expires_at: Date.now() - 1_000 });
    const id = eri.send(cmd);
    await until(() => !!eri.outcome(cmd.op_id as string));
    expect(eri.acks.find((a) => a.acked_id === id)).toMatchObject({ ok: true, outcome: { state: 'rejected', detail: 'expired' } });
    expect(eri.outcome(cmd.op_id as string)).toMatchObject({ state: 'rejected', detail: 'expired' });
    await new Promise((r) => setTimeout(r, 200));
    expect(eri.of('worktrees.report')).toHaveLength(1);
    expect(eri.of('session.report').filter((f) => f.entity === entity)).toHaveLength(1);
  });

  it('a scan without expires_at is rejected', async () => {
    const { eri } = await setup();
    const cmd = scanCommand({ expires_at: undefined });
    eri.send(cmd);
    await until(() => !!eri.outcome(cmd.op_id as string));
    expect(eri.outcome(cmd.op_id as string)).toMatchObject({ state: 'rejected', detail: 'expires_at required' });
  });

  it('is refused as journal_unavailable when the journal cannot record it', async () => {
    const { eri, rt } = await setup();
    // The journal's file fails: opening it (EACCES) and writing to the descriptor it may already hold (ENOSPC).
    const journalFd = (rt.current as unknown as { journal: { fd: number | null } }).journal.fd;
    const injected = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
    const realOpen = fs.openSync;
    const realWrite = fs.writeSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (path.basename(String(p)).startsWith(JOURNAL_FILE)) throw injected('EACCES');
      return realOpen(p, flags, mode);
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, ...rest: unknown[]) => {
      if (journalFd !== null && fd === journalFd) throw injected('ENOSPC');
      return (realWrite as (...a: unknown[]) => number)(fd, ...rest);
    }) as typeof fs.writeSync);
    const cmd = scanCommand();
    const id = eri.send(cmd);
    await until(() => eri.acks.some((a) => a.acked_id === id));
    expect(eri.acks.find((a) => a.acked_id === id)).toMatchObject({
      ok: false,
      error: 'journal_unavailable',
      outcome: { state: 'rejected', detail: 'journal_unavailable', durable: false },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(eri.outcome(cmd.op_id as string)).toBeUndefined();
    expect(eri.of('worktrees.report')).toHaveLength(1);
    expect(rt.current!.status().degraded).toMatch(/^journal_unavailable/);
  });
});

describe('worktrees.scan shape', () => {
  const base = { t: 'worktrees.scan', op_id: 'op', run_id: 'run-1', generation: 2, branch: 'eri/x', turn_seq: 1, expires_at: Date.now() + 60_000 };
  it('accepts the fields Eridani sends', () => {
    expect(commandShapeError(base)).toBeNull();
    expect(commandShapeError({ ...base, tool: 'claude_code', session_id: SESSION_ID })).toBeNull();
    expect(commandShapeError({ ...base, branch: null, turn_seq: null })).toBeNull();
  });
  it('refuses a bad tool, a lone session id and a missing expiry', () => {
    expect(commandShapeError({ ...base, tool: 'bash', session_id: 'x' })).toBe('bad tool');
    expect(commandShapeError({ ...base, session_id: 'x' })).toBe('tool and session_id go together');
    expect(commandShapeError({ ...base, tool: 'codex_cli', session_id: '../etc' })).toBe('bad session_id');
    expect(commandShapeError({ ...base, expires_at: undefined })).toBe('expires_at required');
    expect(commandShapeError({ ...base, generation: -1 })).toBe('bad fence');
  });
});

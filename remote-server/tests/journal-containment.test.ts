/**
 * Task 9d3eda83 (S-N2): the inbound journal and the outbox under write, sync,
 * compaction, read and permission failures. Memory holds only what is on
 * disk, a command whose acceptance is not durable is never acked, no
 * unjournaled effect runs, the link reports itself degraded and recovers on
 * the next successful write, the terminals the hub owns are untouched, and
 * nothing escapes as an unhandled rejection.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseUpFrame, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { EridaniLink, JOURNAL_FILE, JOURNAL_PROBE_MS, OUTBOX_FILE, STATUS_FILE, digestOf, readLinkStatus, type EridaniLinkDeps } from '../src/eridani-link';
import { JOURNAL_UNAVAILABLE, Journal, JournalUnavailableError } from '../src/eridani-journal';
import { Spool } from '../src/eridani-spool';
import { containedTimers } from '../src/eridani-runtime';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { Dispatch, surfFor } from '../src/dispatch';
import { QuestionBroker } from '../src/questions-claude';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import { FakeConn, fakeSpawner, ManualTimers } from './helpers';

// ── Fault injection: the real fs, failing on demand for the journal (or outbox) file only ──

/** The real readFileSync, for a test to look at a file while reads of it are failing. */
const realRead = fs.readFileSync.bind(fs) as (p: string, enc: 'utf8') => string;

type Fault = 'open' | 'write' | 'short-write' | 'sync' | 'rename' | 'read' | null;

class FsFaults {
  journal: Fault = null;
  outbox: Fault = null;
  private readonly fds = new Map<number, 'journal' | 'outbox'>();
  private readonly real = { openSync: fs.openSync, writeSync: fs.writeSync, fdatasyncSync: fs.fdatasyncSync, renameSync: fs.renameSync, readFileSync: fs.readFileSync, closeSync: fs.closeSync };

  constructor() {
    const kindOf = (p: unknown): 'journal' | 'outbox' | null => {
      const s = String(p);
      // The file itself and its compaction temp file (same directory, same disk).
      if (path.basename(s).startsWith(JOURNAL_FILE)) return 'journal';
      if (path.basename(s).startsWith(OUTBOX_FILE)) return 'outbox';
      return null;
    };
    const err = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const kind = kindOf(p);
      if (kind && this[kind] === 'open') throw err('EACCES');
      const fd = this.real.openSync(p, flags, mode);
      if (kind) this.fds.set(fd, kind);
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
      this.fds.delete(fd);
      return this.real.closeSync(fd);
    });
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      const kind = this.fds.get(fd);
      const fault = kind ? this[kind] : null;
      if (fault === 'write') throw err('ENOSPC');
      if (fault === 'short-write') {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
        // Half the line reaches the file, as on a disk that fills up mid-write.
        return this.real.writeSync(fd, b.subarray(0, Math.floor(b.length / 2)));
      }
      return (this.real.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest);
    }) as typeof fs.writeSync);
    vi.spyOn(fs, 'fdatasyncSync').mockImplementation((fd: number) => {
      const kind = this.fds.get(fd);
      if (kind && this[kind] === 'sync') throw err('EIO');
      return this.real.fdatasyncSync(fd);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      const kind = kindOf(to);
      if (kind && this[kind] === 'rename') throw err('EIO');
      return this.real.renameSync(from, to);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, opts?: unknown) => {
      const kind = kindOf(p);
      if (kind && this[kind] === 'read') throw err('EACCES');
      return (this.real.readFileSync as (...a: unknown[]) => unknown)(p, opts);
    }) as typeof fs.readFileSync);
  }
}

// ── Harness ────────────────────────────────────────────────────────────────

const cleanups: Array<() => unknown> = [];
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

beforeEach(() => {
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
  // Let any stray promise settle before checking.
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onRejection);
  expect(rejections, 'no unhandled promise rejection may escape command handling').toEqual([]);
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-containment-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30));

class FakeEridani {
  readonly wss: WebSocketServer;
  readonly frames: UpFrame[] = [];
  sockets: WebSocket[] = [];
  epoch = 0;
  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const f = parseUpFrame(JSON.parse(String(data)));
        if (!f) throw new Error(`bad frame ${String(data)}`);
        this.frames.push(f);
        if (f.t === 'hello') this.send(ws, { t: 'welcome', host_id: 'host-1', conn_epoch: ++this.epoch, server_time: Date.now() });
        else if ('op_id' in f && f.t !== 'ack') this.send(ws, { t: 'ack', acked_id: f.id, ok: true });
      });
    });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}/link`;
  }
  get ws(): WebSocket {
    return this.sockets.at(-1)!;
  }
  send(ws: WebSocket, body: Record<string, unknown>): void {
    ws.send(JSON.stringify({ v: 1, id: `e-${Math.random()}`, conn_epoch: this.epoch, at: Date.now(), ...body }));
  }
  of(t: string): Array<UpFrame & Record<string, unknown>> {
    return this.frames.filter((f) => f.t === t) as Array<UpFrame & Record<string, unknown>>;
  }
  ackFor(id: string): Record<string, unknown> | undefined {
    return this.of('ack').find((a) => a.acked_id === id);
  }
  outcomes(op: string): Array<Record<string, unknown>> {
    return this.of('command.outcome').filter((o) => o.command_id === op);
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

async function setup(over: Partial<EridaniLinkDeps> = {}, eri?: FakeEridani) {
  if (!eri) {
    eri = new FakeEridani();
    const e = eri;
    cleanups.push(() => e.close());
    await new Promise((r) => e.wss.once('listening', r));
  }
  const logs: string[] = [];
  const link = new EridaniLink({
    url: eri.url,
    token: () => 'eri_bot_test0123456789',
    dir: null,
    serverId: 'srv-1',
    bootId: 'boot-1',
    hostname: 'box',
    machine: 'box',
    version: '9.9.9',
    snapshot: () => [],
    rand: () => 0.5,
    log: (m) => logs.push(m),
    ...over,
  });
  cleanups.push(() => link.stop());
  link.start();
  await until(() => link.ready);
  return { eri, link, logs };
}

const EXPIRES = Date.now() + 10 * 60_000;
function cmdOf(over: Record<string, unknown> = {}) {
  const body = { t: 'test.cmd', op_id: 'op-c', expires_at: EXPIRES, value: 1, ...over };
  return { ...body, digest: digestOf(body) };
}

// ── The journal on its own ─────────────────────────────────────────────────

describe('Journal: durable first', () => {
  const rec = (state: 'accepted' | 'executing' | 'executed' = 'accepted') => ({ digest: 'd', t: 'x', state });
  const lines = (file: string) => realRead(file, 'utf8').split('\n').filter(Boolean);

  it('a sync failure: record throws, memory and the file are unchanged, degraded until the next write succeeds', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), JOURNAL_FILE);
    const j = new Journal({ file, horizonMs: 60_000 });
    j.record('op-1', rec());
    faults.journal = 'sync';
    expect(() => j.record('op-2', rec())).toThrow(JournalUnavailableError);
    // The synthetic fdatasync failure of S-N2: get(op) must not report accepted.
    expect(j.get('op-2')).toBeUndefined();
    expect(j.unsettled().pending).toEqual(['op-1']);
    expect(j.degraded).toBe('sync failed: EIO');
    // The unsynced line was cut back off: a restart does not find it.
    expect(lines(file).map((l) => JSON.parse(l).op_id)).toEqual(['op-1']);
    faults.journal = null;
    j.record('op-3', rec());
    expect(j.degraded).toBeNull();
    j.close();
    const again = new Journal({ file, horizonMs: 60_000 });
    expect(again.get('op-2')).toBeUndefined();
    expect(again.all().map((r) => r.op_id).sort()).toEqual(['op-1', 'op-3']);
  });

  it('a short write (disk full mid-line): nothing is appended after the torn line; the next write rewrites the file', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), JOURNAL_FILE);
    const j = new Journal({ file, horizonMs: 60_000 });
    j.record('op-1', rec());
    // ftruncate is part of the damage too: the half line stays in the file.
    vi.spyOn(fs, 'ftruncateSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    faults.journal = 'short-write';
    expect(() => j.record('op-2', rec())).toThrow(/journal_unavailable: write failed: ESHORTWRITE/);
    expect(j.get('op-2')).toBeUndefined();
    expect(lines(file)).toHaveLength(2); // op-1 and half of op-2
    faults.journal = null;
    j.record('op-3', rec('executed'));
    expect(j.degraded).toBeNull();
    // Every line parses: the torn one was rewritten away, not glued to op-3.
    expect(lines(file).map((l) => JSON.parse(l).op_id)).toEqual(['op-1', 'op-3']);
  });

  it('a permission failure opening the file, then a failing recovery compaction: degraded with each reason, then healthy', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), JOURNAL_FILE);
    const j = new Journal({ file, horizonMs: 60_000 });
    faults.journal = 'open';
    expect(() => j.record('op-1', rec())).toThrow(JournalUnavailableError);
    expect(j.degraded).toBe('open failed: EACCES');
    expect(j.all()).toEqual([]);
    // The file opens again, but the rewrite that must come first cannot be renamed into place.
    faults.journal = 'rename';
    expect(() => j.record('op-1', rec())).toThrow(/compaction failed: EIO/);
    expect(j.degraded).toBe('compaction failed: EIO');
    expect(j.probe()).toBe(false);
    faults.journal = null;
    expect(j.probe()).toBe(true);
    expect(j.degraded).toBeNull();
    j.record('op-1', rec());
    expect(j.get('op-1')?.state).toBe('accepted');
  });

  it('a compaction that fails after a durable append does not degrade the journal', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), JOURNAL_FILE);
    const logs: string[] = [];
    const j = new Journal({ file, horizonMs: 60_000, log: (m) => logs.push(m) });
    faults.journal = 'rename';
    j.compact();
    expect(j.degraded).toBeNull();
    expect(logs.join('\n')).toContain('compaction failed (EIO); the journal file is unchanged');
    j.record('op-1', rec());
    expect(j.get('op-1')).toBeDefined();
  });

  it('settlements found on load reach memory only once they are on disk', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), JOURNAL_FILE);
    const a = new Journal({ file, horizonMs: 60_000 });
    a.record('op-x', rec('executing'));
    a.close();
    faults.journal = 'rename';
    const b = new Journal({ file, horizonMs: 60_000 });
    expect(b.degraded).toBe('compaction failed: EIO');
    // Not yet written as uncertain: memory still says what the disk says.
    expect(b.get('op-x')?.state).toBe('executing');
    expect(b.settledOnLoad).toEqual([]);
    expect(b.unsettled()).toEqual({ pending: ['op-x'], uncertain: [] });
    faults.journal = null;
    expect(b.probe()).toBe(true);
    expect(b.get('op-x')?.state).toBe('uncertain');
    expect(b.settledOnLoad.map((r) => r.op_id)).toEqual(['op-x']);
    expect(lines(file).map((l) => JSON.parse(l).state)).toEqual(['uncertain']);
  });

  it('a journal that cannot be read is never overwritten; it is merged once it can be read', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), JOURNAL_FILE);
    const a = new Journal({ file, horizonMs: 60_000 });
    a.record('op-old', rec('executed'));
    a.close();
    faults.journal = 'read';
    const b = new Journal({ file, horizonMs: 60_000 });
    expect(b.degraded).toBe('read failed: EACCES');
    expect(() => b.record('op-new', rec())).toThrow(JournalUnavailableError);
    expect(lines(file).map((l) => JSON.parse(l).op_id)).toEqual(['op-old']);
    faults.journal = null;
    b.record('op-new', rec());
    expect(b.degraded).toBeNull();
    // The old op is remembered: its duplicate gets the recorded outcome, never a second run.
    expect(b.get('op-old')?.state).toBe('executed');
    expect(lines(file).map((l) => JSON.parse(l).op_id).sort()).toEqual(['op-new', 'op-old']);
  });
});

// ── The link: refusal, degraded status, recovery ───────────────────────────

describe('EridaniLink: commands while the journal cannot record', () => {
  for (const fault of ['write', 'sync', 'open', 'short-write'] as const) {
    it(`${fault} failure: the acceptance is not acked, nothing runs, the link is degraded; the next write recovers`, async () => {
      const faults = new FsFaults();
      const dir = tmpDir();
      let runs = 0;
      const { eri, link } = await setup({ dir, handlers: { 'test.cmd': async (_c, ctx) => (ctx.begin(), runs++, { state: 'executed' }) } });
      faults.journal = fault;
      eri.send(eri.ws, { ...cmdOf({ op_id: 'op-1' }), id: 'c1' });
      await until(() => !!eri.ackFor('c1'));
      expect(eri.ackFor('c1')).toMatchObject({ ok: false, op_id: 'op-1', error: JOURNAL_UNAVAILABLE, outcome: { state: 'rejected', detail: JOURNAL_UNAVAILABLE } });
      await tick();
      expect(runs).toBe(0);
      expect(eri.outcomes('op-1')).toEqual([]);
      expect(link.journal.get('op-1')).toBeUndefined();
      const reason = link.status().degraded!;
      expect(reason).toMatch(/^journal_unavailable \((write|sync|open) failed: (ENOSPC|EIO|EACCES|ESHORTWRITE)\)$/);
      expect(link.status().journal).toMatchObject({ refused: 1 });
      // The status file the CLI reads says so.
      link.writeStatusNow();
      expect(readLinkStatus(dir)).toMatchObject({ degraded: reason, journal: { degraded: expect.any(String), refused: 1 } });
      expect(fs.readFileSync(path.join(dir, STATUS_FILE), 'utf8')).toContain(JOURNAL_UNAVAILABLE);

      // A reconnect: hello says why; the snapshot does not list the refused op as pending.
      eri.ws.terminate();
      await until(() => eri.of('hello').length === 2 && link.ready);
      await until(() => eri.of('sessions.snapshot').length === 2);
      expect(eri.of('hello')[1].degraded_reason).toBe(reason);
      expect(eri.of('hello')[0].degraded_reason).toBeUndefined();
      expect(eri.of('sessions.snapshot')[1].journal).toEqual({ pending: [], uncertain: [] });

      // The disk is back: the next command is journaled, acked, run; degraded clears.
      faults.journal = null;
      eri.send(eri.ws, { ...cmdOf({ op_id: 'op-2' }), id: 'c2' });
      await until(() => eri.outcomes('op-2').length === 1);
      expect(eri.ackFor('c2')).toMatchObject({ ok: true, outcome: { state: 'accepted' } });
      expect(runs).toBe(1);
      expect(link.status().degraded).toBeNull();
      expect(link.status().journal?.degraded).toBeNull();
      // Eridani resends the refused op: judged afresh, and now it runs.
      eri.send(eri.ws, { ...cmdOf({ op_id: 'op-1' }), id: 'c3' });
      await until(() => eri.outcomes('op-1').length === 1);
      expect(runs).toBe(2);
    });
  }

  it('a rejection the journal cannot record is refused as journal_unavailable, never acked as a recorded rejection', async () => {
    const faults = new FsFaults();
    const { eri, link } = await setup({ dir: tmpDir(), handlers: {} });
    faults.journal = 'sync';
    eri.send(eri.ws, { ...cmdOf({ t: 'nope', op_id: 'op-u' }), id: 'c1' });
    await until(() => !!eri.ackFor('c1'));
    expect(eri.ackFor('c1')).toMatchObject({ ok: false, error: JOURNAL_UNAVAILABLE });
    expect(eri.outcomes('op-u')).toEqual([]);
    expect(link.journal.get('op-u')).toBeUndefined();
  });

  it('executing cannot be recorded: the effect does not run, the outcome waits for the journal, then is recorded and reported', async () => {
    const faults = new FsFaults();
    const timers = new ManualTimers();
    let effects = 0;
    const { eri, link } = await setup({
      dir: tmpDir(),
      timers,
      handlers: {
        'test.cmd': async (_c, ctx) => {
          faults.journal = 'sync'; // the disk fails between accepted and executing
          ctx.begin();
          effects++;
          return { state: 'executed' };
        },
      },
    });
    eri.send(eri.ws, { ...cmdOf({ op_id: 'op-b' }), id: 'c1' });
    await until(() => !!eri.ackFor('c1'));
    expect(eri.ackFor('c1')).toMatchObject({ ok: true, outcome: { state: 'accepted' } });
    await until(() => link.status().journal?.unrecorded === 1);
    expect(effects).toBe(0);
    expect(link.journal.get('op-b')?.state).toBe('accepted');
    expect(eri.outcomes('op-b')).toEqual([]);
    expect(link.status().degraded).toBe('journal_unavailable (sync failed: EIO)');
    // A duplicate gets the durable state, and does not run it again.
    eri.send(eri.ws, { ...cmdOf({ op_id: 'op-b' }), id: 'c2' });
    await until(() => !!eri.ackFor('c2'));
    expect(eri.ackFor('c2')).toMatchObject({ ok: true, outcome: { state: 'accepted' } });
    link.replayAccepted();
    // The probe while the disk is still failing changes nothing.
    timers.advance(JOURNAL_PROBE_MS);
    expect(link.status().journal?.unrecorded).toBe(1);
    faults.journal = null;
    timers.advance(JOURNAL_PROBE_MS);
    await until(() => eri.outcomes('op-b').length === 1);
    expect(eri.outcomes('op-b')[0]).toMatchObject({ state: 'failed', detail: expect.stringContaining(JOURNAL_UNAVAILABLE) });
    expect(link.journal.get('op-b')?.state).toBe('failed');
    expect(link.status().degraded).toBeNull();
    expect(link.status().journal?.unrecorded).toBe(0);
    expect(effects).toBe(0);
  });

  it('a queued effect whose begin() fails inside a timer callback is contained, settled and never run', async () => {
    const faults = new FsFaults();
    const logs: string[] = [];
    const timers = containedTimers((m) => logs.push(m));
    let effects = 0;
    const { eri, link } = await setup({
      dir: tmpDir(),
      handlers: {
        // Like dispatch's queued input: the effect starts from a timer, and the promise only settles there.
        'test.cmd': (_c, ctx) => new Promise((resolve) => {
          timers.setTimeout(() => {
            faults.journal = 'write';
            ctx.begin();
            effects++;
            resolve({ state: 'executed' });
          }, 1);
        }),
      },
    });
    eri.send(eri.ws, { ...cmdOf({ op_id: 'op-q' }), id: 'c1' });
    await until(() => link.status().journal?.unrecorded === 1);
    expect(effects).toBe(0);
    expect(logs.join('\n')).toContain('a timer callback failed: journal_unavailable: write failed: ENOSPC');
    faults.journal = null;
    eri.send(eri.ws, { ...cmdOf({ op_id: 'op-next', value: 2 }), id: 'c2' });
    await until(() => eri.outcomes('op-q').length === 1);
    expect(eri.outcomes('op-q')[0]).toMatchObject({ state: 'failed' });
  });

  it('the outcome cannot be recorded: nothing is reported, and a restart sees the durable executing, not a memory-only executed', async () => {
    const faults = new FsFaults();
    const dir = tmpDir();
    const first = await setup({
      dir,
      handlers: {
        'test.cmd': async (_c, ctx) => {
          ctx.begin();
          faults.journal = 'sync';
          return { state: 'executed', result: { done: true } };
        },
      },
    });
    first.eri.send(first.eri.ws, { ...cmdOf({ op_id: 'op-f' }), id: 'c1' });
    await until(() => first.link.status().journal?.unrecorded === 1);
    expect(first.link.journal.get('op-f')?.state).toBe('executing');
    expect(first.eri.outcomes('op-f')).toEqual([]);
    first.link.stop();
    faults.journal = null;

    // The restart: the journal says executing, so recover() decides (here: it cannot, so uncertain).
    const again = await setup({ dir, handlers: { 'test.cmd': async () => ({ state: 'executed' }) } }, first.eri);
    expect(again.link.journal.get('op-f')?.state).toBe('uncertain');
    await until(() => first.eri.outcomes('op-f').length === 1);
    expect(first.eri.outcomes('op-f')[0]).toMatchObject({ state: 'uncertain' });
  });

  it('a link that starts over an unwritable journal is degraded from the start and says so in its first hello', async () => {
    const faults = new FsFaults();
    const dir = tmpDir();
    const j = new Journal({ file: path.join(dir, JOURNAL_FILE), horizonMs: 60_000 });
    j.record('op-x', { digest: 'd', t: 'test.cmd', state: 'executing' });
    j.close();
    faults.journal = 'rename';
    const timers = new ManualTimers();
    const { eri, link } = await setup({ dir, timers, handlers: { 'test.cmd': async () => ({ state: 'executed' }) } });
    expect(eri.of('hello')[0].degraded_reason).toBe('journal_unavailable (compaction failed: EIO)');
    await until(() => eri.of('sessions.snapshot').length === 1);
    // The settlement is not on disk yet: the snapshot still says pending, and no outcome is reported.
    expect(eri.of('sessions.snapshot')[0].journal).toEqual({ pending: ['op-x'], uncertain: [] });
    expect(eri.outcomes('op-x')).toEqual([]);
    faults.journal = null;
    timers.advance(JOURNAL_PROBE_MS);
    await until(() => eri.outcomes('op-x').length === 1);
    expect(eri.outcomes('op-x')[0]).toMatchObject({ state: 'uncertain' });
    expect(link.status().degraded).toBeNull();
  });
});

// ── The hub's terminals are untouched ──────────────────────────────────────

describe('EridaniLink + Dispatch: a degraded journal leaves the terminals alone', () => {
  const TARGET: ExecutionTarget = { id: 'proj', repo: '/repo', worktreeRoot: '/wt', base: 'main', launch: { claude: {} }, verify: [] };

  it('a spawn is refused without a process; an existing session keeps working; after recovery the spawn runs', async () => {
    const faults = new FsFaults();
    const registry = Registry.load({ file: null, bootId: 'boot-1' });
    const sp = fakeSpawner();
    const hub = new Hub({ registry, spawn: sp.spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
    const conn = new FakeConn(1);
    hub.connect(conn);
    hub.handle(conn, { t: 'hello', proto: 1, device: { id: 'device-aaaaaaaa', name: 'a' }, app: { name: 'test', version: '0' } });
    hub.handle(conn, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: { cwd: '/tmp' } });
    expect(sp.ptys).toHaveLength(1);
    const dispatch = new Dispatch({
      hub,
      registry,
      dir: null,
      worktrees: { ensure: async (_t: ExecutionTarget, branch: string, base: string) => ({ path: `/wt/${branch}`, branch, base, baseSha: 'abc', created: true }) } as unknown as WorktreeManager,
      targets: () => [TARGET],
      questions: new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} }),
      emit: () => {},
      linkReady: () => true,
      timers: containedTimers(() => {}),
    });
    hub.setEridani(dispatch.hubHooks());
    const { eri, link } = await setup({
      dir: tmpDir(),
      handlers: dispatch.handlers(),
      precheck: (c) => dispatch.precheck(c),
      acceptFacts: (c) => dispatch.acceptFacts(c),
    });
    const spawn = (op: string) => {
      const body = { t: 'spawn', op_id: op, run_id: 'run-1', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet', target: { id: 'proj', branch: 'eri/t1' }, prompt: 'go', expires_at: EXPIRES };
      return { ...body, digest: digestOf(body) };
    };

    faults.journal = 'sync';
    eri.send(eri.ws, { ...spawn('op-s1'), id: 'c1' });
    await until(() => !!eri.ackFor('c1'));
    await tick();
    expect(eri.ackFor('c1')).toMatchObject({ ok: false, error: JOURNAL_UNAVAILABLE });
    expect(sp.ptys).toHaveLength(1); // no unjournaled process
    expect(registry.session(surfFor('run-1', 1, 1))).toBeUndefined();
    expect(link.status().degraded).toMatch(/^journal_unavailable/);
    // The terminal that was already there is live and takes input.
    expect(hub.isLive('surf-1')).toBe(true);
    hub.handleInput(conn, 'surf-1', 'ls\r');
    expect(sp.ptys[0].written).toContain('ls\r');
    expect(sp.ptys[0].killed).toEqual([]);

    faults.journal = null;
    eri.send(eri.ws, { ...spawn('op-s2'), id: 'c2' });
    await until(() => eri.outcomes('op-s2').length === 1);
    expect(eri.outcomes('op-s2')[0]).toMatchObject({ state: 'executed' });
    expect(sp.ptys).toHaveLength(2);
    expect(link.status().degraded).toBeNull();
    expect(hub.isLive('surf-1')).toBe(true);
  });
});

// ── The outbox: the same discipline ────────────────────────────────────────

describe('Spool: failed writes', () => {
  const opts = (file: string) => ({ file, maxEntries: 100, maxBytes: 1 << 20, hardFactor: 2 });

  it('a permission failure degrades it; nothing more is appended; the next write rewrites the file and clears it', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), OUTBOX_FILE);
    const s = new Spool(opts(file));
    s.put({ op_id: 'a', lane: 1, body: { t: 'turn', n: 1 } });
    faults.outbox = 'open';
    s.close();
    expect(s.put({ op_id: 'b', lane: 1, body: { t: 'turn', n: 2 } }).ok).toBe(true);
    expect(s.degraded).toBe('write-failed: EACCES');
    expect(s.put({ op_id: 'c', lane: 1, body: { t: 'turn', n: 3 } }).ok).toBe(true);
    expect(s.degraded).toBe('write-failed: EACCES');
    faults.outbox = null;
    s.put({ op_id: 'd', lane: 1, body: { t: 'turn', n: 4 } });
    expect(s.degraded).toBeNull();
    s.close();
    expect(new Spool(opts(file)).pending().map((e) => e.op_id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a short write mid-file cannot corrupt the next line: recovery rewrites instead of appending', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), OUTBOX_FILE);
    const s = new Spool(opts(file));
    s.put({ op_id: 'a', lane: 1, body: { t: 'turn', n: 1 } });
    faults.outbox = 'short-write';
    s.put({ op_id: 'b', lane: 1, body: { t: 'turn', n: 2 } });
    expect(s.degraded).toBe('write-failed: ESHORTWRITE');
    faults.outbox = null;
    s.put({ op_id: 'c', lane: 1, body: { t: 'turn', n: 3 } });
    expect(s.degraded).toBeNull();
    s.close();
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
    expect(new Spool(opts(file)).pending().map((e) => e.op_id)).toEqual(['a', 'b', 'c']);
  });

  it('an unreadable outbox is left alone and merged once it can be read', () => {
    const faults = new FsFaults();
    const file = path.join(tmpDir(), OUTBOX_FILE);
    const a = new Spool(opts(file));
    a.put({ op_id: 'old', lane: 1, body: { t: 'turn', n: 1 } });
    a.close();
    faults.outbox = 'read';
    const b = new Spool(opts(file));
    expect(b.degraded).toBe('read-failed: EACCES');
    b.put({ op_id: 'new', lane: 1, body: { t: 'turn', n: 2 } });
    expect(b.degraded).toBe('read-failed: EACCES');
    faults.outbox = null;
    b.put({ op_id: 'newer', lane: 1, body: { t: 'turn', n: 3 } });
    expect(b.degraded).toBeNull();
    expect(b.pending().map((e) => e.op_id)).toEqual(['old', 'new', 'newer']);
    b.close();
    expect(new Spool(opts(file)).pending().map((e) => e.op_id)).toEqual(['old', 'new', 'newer']);
  });

  it('spool-full clears once acks make room', () => {
    const s = new Spool({ file: null, maxEntries: 1, maxBytes: 1 << 20, hardFactor: 2 });
    s.put({ op_id: 'a', lane: 1, body: { t: 'turn' } });
    s.put({ op_id: 'b', lane: 1, body: { t: 'turn' } });
    expect(s.put({ op_id: 'c', lane: 1, body: { t: 'turn' } }).ok).toBe(false);
    expect(s.degraded).toBe('spool-full');
    s.ack('a');
    expect(s.degraded).toBeNull();
  });
});

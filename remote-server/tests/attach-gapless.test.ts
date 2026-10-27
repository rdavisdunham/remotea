import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { TermSession, FLOW, buildSnapshot } from '../src/session';
import { applyMouseModeSequences, emptyMouseModeState } from '../../src/renderer/utils/mouse-modes';
import { DEFAULT_THEME } from '../src/queries';
import { drain, FakeConn, fakeSpawner, ManualTimers, rng, screenText, waitFor } from './helpers';
import type { ServerMsg } from '../../src/shared/remote-host-protocol';

const COLS = 40;
const ROWS = 8;

function makeSession(ringBytes = 1 << 20) {
  const timers = new ManualTimers();
  const sp = fakeSpawner();
  const session = new TermSession({
    id: 'surf-gapless', bootId: 'boot-1', cols: COLS, rows: ROWS, scrollback: 500, snapshotScrollback: 500,
    ringBytes, spawn: sp.spawn, theme: () => DEFAULT_THEME, onExit: () => {}, timers,
  });
  return { session, pty: sp.last(), timers };
}

function chunkGen(r: () => number): () => string {
  const pieces = [
    () => `line ${Math.floor(r() * 1000)}\r\n`,
    () => `\x1b[3${Math.floor(r() * 8)}mcolour\x1b[0m `,
    () => `\x1b[${1 + Math.floor(r() * ROWS)};${1 + Math.floor(r() * COLS)}H*`,
    () => '\x1b[2K',
    () => '漢字テスト ',
    () => 'x'.repeat(Math.floor(r() * 90)),
    () => '\r\n',
    () => '\x1b[?1049h\x1b[Halt screen\r\n',
    () => '\x1b[?1049l',
    () => '\x1b[1;4mbold-underline\x1b[22;24m',
  ];
  return () => {
    let out = '';
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) out += pieces[Math.floor(r() * pieces.length)]();
    return out;
  };
}


/** Rebuild a client terminal from what a FakeConn received for one session. */
async function rebuild(conn: FakeConn, base?: Terminal): Promise<Terminal> {
  const opened = conn.json('opened').at(-1)!;
  const term = base ?? new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
  if (opened.mode === 'snapshot') term.write(opened.snapshot!);
  let expected = opened.seq + 1;
  for (const o of conn.outputs()) {
    if (o.seq <= opened.seq && opened.mode !== 'delta') continue;
    if (opened.mode === 'delta' && o.seq <= (opened.fromSeq ?? 0)) continue;
    if (opened.mode === 'delta' && expected > (opened.fromSeq ?? 0) + 1 && o.seq < expected) continue;
    if (opened.mode === 'delta' && expected === opened.seq + 1) expected = (opened.fromSeq ?? 0) + 1;
    expect(o.seq).toBe(expected);
    expected++;
    term.write(o.data);
  }
  await drain(term);
  return term;
}

describe('gap-free attach (snapshot mode)', () => {
  /**
   * Run a random stream, attach at a random point, and return what the
   * client received plus every byte the PTY produced.
   */
  async function attachMidStream(seed: number) {
    const r = rng(seed);
    const gen = chunkGen(r);
    const { session, pty } = makeSession();
    let all = '';
    const attachAt = 5 + Math.floor(r() * 50);
    const conn = new FakeConn(1);
    for (let i = 0; i < 60; i++) {
      const c = gen();
      pty.emit(c);
      all += c;
      // Sometimes several emits coalesce into one seq, like real batching.
      if (r() < 0.7) session.flush();
      if (i === attachAt) session.attach(conn, { cols: COLS, rows: ROWS, created: false });
    }
    session.flush();
    await waitFor(() => conn.json('opened').length === 1);
    session.dispose();
    return { conn, all };
  }

  // The property that matters for "no byte twice, none missed": the snapshot is
  // EXACTLY the state after some byte prefix, and the stream is EXACTLY the rest.
  // Checked byte-for-byte, so it holds regardless of how faithfully
  // SerializeAddon can encode a given state.
  for (const seed of Array.from({ length: 200 }, (_, i) => i + 1)) {
    it(`snapshot + stream == the whole byte stream, split at one point (seed ${seed})`, async () => {
      const { conn, all } = await attachMidStream(seed);
      const opened = conn.json('opened')[0];
      expect(opened.mode).toBe('snapshot');
      const after = conn.outputs();
      expect(after.map((o) => o.seq)).toEqual(Array.from({ length: after.length }, (_, i) => opened.seq + 1 + i));
      const suffix = after.map((o) => o.data).join('');
      expect(all.endsWith(suffix)).toBe(true);
      const prefix = all.slice(0, all.length - suffix.length);
      const ref = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
      const ser = new SerializeAddon();
      ref.loadAddon(ser as never);
      ref.write(prefix);
      await drain(ref);
      expect(opened.snapshot).toBe(buildSnapshot(ref, ser, applyMouseModeSequences(emptyMouseModeState(), prefix), 500));
    });
  }

  // Fidelity smoke: replaying the snapshot reproduces what a person would see.
  // (Pathological mixes of wide characters, wraps and alt-screen switches can
  // still differ in SerializeAddon's encoding; these seeds are representative.)
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`a mid-stream attach reconstructs the visible screen (seed ${seed})`, async () => {
      const { conn, all } = await attachMidStream(seed);
      const reference = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
      reference.write(all);
      await drain(reference);
      const client = await rebuild(conn);
      expect(screenText(client)).toBe(screenText(reference));
    });
  }
});

describe('gap-free attach (delta mode)', () => {
  it('replays exactly the chunks after sinceSeq when the ring covers them', async () => {
    const r = rng(42);
    const gen = chunkGen(r);
    const { session, pty } = makeSession();
    const reference = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
    // A client that was attached and applied everything up to seq 20, then slept.
    const client = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
    for (let i = 0; i < 20; i++) {
      const c = gen();
      pty.emit(c);
      session.flush();
      reference.write(c);
      client.write(c);
    }
    const sinceSeq = session.seq;
    for (let i = 0; i < 25; i++) {
      const c = gen();
      pty.emit(c);
      session.flush();
      reference.write(c);
    }
    const conn = new FakeConn(2);
    session.attach(conn, { cols: COLS, rows: ROWS, created: false, sinceSeq, bootId: 'boot-1' });
    const opened = conn.json('opened')[0] as Extract<ServerMsg, { t: 'opened' }>;
    expect(opened.mode).toBe('delta');
    expect(opened.fromSeq).toBe(sinceSeq);
    const seqs = conn.outputs().map((o) => o.seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => sinceSeq + 1 + i));
    for (const o of conn.outputs()) client.write(o.data);
    // Live output after the attach keeps flowing in order.
    pty.emit('tail\r\n');
    session.flush();
    reference.write('tail\r\n');
    client.write(conn.outputs().at(-1)!.data);
    await drain(client);
    await drain(reference);
    expect(screenText(client)).toBe(screenText(reference));
    session.dispose();
  });

  it('falls back to a snapshot when the ring no longer covers the gap, or the boot changed', async () => {
    const { session, pty } = makeSession(64);
    for (let i = 0; i < 30; i++) {
      pty.emit(`chunk ${i} ${'y'.repeat(20)}\r\n`);
      session.flush();
    }
    const a = new FakeConn(3);
    session.attach(a, { cols: COLS, rows: ROWS, created: false, sinceSeq: 2, bootId: 'boot-1' });
    const b = new FakeConn(4);
    session.attach(b, { cols: COLS, rows: ROWS, created: false, sinceSeq: session.seq, bootId: 'other-boot' });
    await waitFor(() => a.json('opened').length === 1 && b.json('opened').length === 1);
    expect(a.json('opened')[0].mode).toBe('snapshot');
    expect(b.json('opened')[0].mode).toBe('snapshot');
    session.dispose();
  });

  it('a size change since sinceSeq forces a snapshot', async () => {
    const { session, pty } = makeSession();
    const owner = new FakeConn(5);
    session.attach(owner, { cols: COLS, rows: ROWS, created: true });
    pty.emit('before\r\n');
    session.flush();
    const sinceSeq = session.seq;
    session.resize(owner.id, 50, 10);
    pty.emit('after\r\n');
    session.flush();
    const late = new FakeConn(6);
    session.attach(late, { cols: COLS, rows: ROWS, created: false, sinceSeq, bootId: 'boot-1' });
    await waitFor(() => late.json('opened').length === 1);
    expect(late.json('opened')[0].mode).toBe('snapshot');
    session.dispose();
  });
});

describe('lagging subscribers', () => {
  it('stops streaming past the high-water mark and catches up from the ring once drained', async () => {
    const { session, pty } = makeSession();
    const conn = new FakeConn(7);
    session.attach(conn, { cols: COLS, rows: ROWS, created: true });
    pty.emit('one\r\n');
    session.flush();
    conn.backlog = FLOW.lagHigh + 1;
    pty.emit('two\r\n');
    session.flush();
    pty.emit('three\r\n');
    session.flush();
    expect(conn.outputs().map((o) => o.data)).toEqual(['one\r\n']);
    conn.backlog = 0;
    session.pumpLagging();
    expect(conn.outputs().map((o) => o.data)).toEqual(['one\r\n', 'two\r\n', 'three\r\n']);
    expect(conn.outputs().map((o) => o.seq)).toEqual([1, 2, 3]);
    session.dispose();
  });
});

/**
 * The TypeScript collector against the Python one: fixtures/collector holds a
 * small home (Claude transcripts, Codex databases, a Windows side) and what
 * ~/jarvis/scripts/session_collector/collector.py reported for it
 * (generate.py). The port must send byte-identical SessionInput bodies.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { Collector, formatRows, type ReportOut } from '../src/collector/collector';
import { CollectorState } from '../src/collector/state';
import { DatabaseSync } from 'node:sqlite';
import { DbReader, codexSources } from '../src/collector/codex-sqlite';
import { clip, redact } from '../src/collector/redact';
import { pyIso } from '../src/collector/iso';
import { shlexQuote, wslFolder } from '../src/collector/paths';
import { pyJsonDumps } from '../src/collector/pyjson';
import type { StatusLike } from '../src/collector/report';

const FIX = path.join(__dirname, 'fixtures', 'collector');
const status = JSON.parse(fs.readFileSync(path.join(FIX, 'status.json'), 'utf8')) as StatusLike;
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8')) as Record<string, unknown>;

/** The fixture home, copied so the Codex threads' absolute rollout_path can point at this checkout. */
const HOME = (() => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collector-home-')), 'home');
  fs.cpSync(path.join(FIX, 'home'), home, { recursive: true });
  const db = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
  db.prepare("UPDATE threads SET rollout_path = ? || '/.codex/sessions/' || substr(rollout_path, instr(rollout_path, '/.codex/sessions/') + 17)"
    + " WHERE rollout_path LIKE '%/.codex/sessions/%'").run(home);
  db.close();
  return home;
})();

function make(opts: { state?: CollectorState; send?: (r: ReportOut) => boolean; now?: () => number } = {}) {
  const sent: ReportOut[] = [];
  const state = opts.state ?? new CollectorState(null);
  const c = new Collector({
    home: HOME,
    windowsUsers: path.join(FIX, 'windows-users'),
    machine: 'fixturepc',
    state,
    status: () => status,
    send: opts.send ?? ((r) => (sent.push(r), true)),
    now: opts.now,
    repoOf: (cwd, origin) => (origin ? origin.replace(/\/+$/, '').split('/').pop()!.split(':').pop()!.replace(/\.git$/, '') : ''),
  });
  return { c, sent, state };
}

describe('collector parity with collector.py', () => {
  it('sends the same SessionInput for every session the Python collector sends', async () => {
    const { c, sent } = make();
    await c.scan();
    const got = Object.fromEntries(sent.map((r) => [r.entity, r.report]).sort(([a], [b]) => (a < b ? -1 : 1)));
    expect(Object.keys(got)).toEqual(Object.keys(expected));
    for (const key of Object.keys(expected)) expect(got[key], key).toEqual(expected[key]);
    // Key order too: the bodies are the same JSON, not just equal objects.
    for (const key of Object.keys(expected)) expect(JSON.stringify(got[key])).toBe(JSON.stringify(expected[key]));
  });

  it('prints the same dry-run table', async () => {
    const { c } = make();
    const res = await c.scan({ dryRun: true, days: 100000 });
    expect(formatRows(res.rows, 100000)).toBe(fs.readFileSync(path.join(FIX, 'expected-dry-run.txt'), 'utf8'));
  });

  it('advances a fingerprint only after delivery, and resends what was never acknowledged', async () => {
    const state = new CollectorState(null);
    const first = make({ state });
    await first.c.scan();
    expect(first.sent.length).toBe(8);
    // Nothing acknowledged: the next scan does not duplicate what is still on its way…
    const second = make({ state });
    await second.c.scan();
    expect(second.sent.length).toBe(0);
    // …but a new state (a restart that lost the pending set) sends everything again.
    const restarted = new CollectorState(null);
    restarted.data.sessions = JSON.parse(JSON.stringify(state.data.sessions));
    const third = make({ state: restarted });
    await third.c.scan();
    expect(third.sent.length).toBe(8);
    for (const r of third.sent) expect(restarted.delivered(r.entity, r.revision)).toBe(true);
    const fourth = make({ state: restarted });
    await fourth.c.scan();
    expect(fourth.sent.length).toBe(0);
    // An evicted report marks its entity dirty: forgotten, so it goes out again.
    restarted.dirty(third.sent[0].entity);
    const fifth = make({ state: restarted });
    await fifth.c.scan();
    expect(fifth.sent.map((r) => r.entity)).toEqual([third.sent[0].entity]);
  });

  it('a refused send leaves the source unrecorded', async () => {
    const state = new CollectorState(null);
    const { c } = make({ state, send: () => false });
    const res = await c.scan();
    expect(res.failed).toBe(8);
    expect(Object.keys(state.data.sessions)).toEqual([]);
  });

  it('scanOne reads only the named session', async () => {
    const { c, sent } = make();
    await c.scanOne('codex', 't9');
    expect(sent.map((r) => r.entity)).toEqual(['codex_cli:t9']);
  });

  it('state survives a restart on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-state-'));
    const file = path.join(dir, 'state.json');
    const state = new CollectorState(file);
    const { c, sent } = make({ state });
    await c.scan();
    for (const r of sent) state.delivered(r.entity, r.revision);
    expect((fs.statSync(file).mode & 0o777)).toBe(0o600);
    const again = make({ state: new CollectorState(file) });
    await again.c.scan();
    expect(again.sent.length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('collector helpers match Python', () => {
  it('redact and clip', () => {
    expect(redact('key sk-ant-' + 'a'.repeat(25) + ' and Bearer ' + 'b'.repeat(20))).toBe('key [redacted] and [redacted]');
    expect(redact('eri_bot_' + 'c'.repeat(20) + ' lin_api_' + 'd'.repeat(20) + ' AKIA' + 'A'.repeat(16))).toBe('[redacted] [redacted] [redacted]');
    expect(clip('  ab😀cd  ', 4)).toBe('ab😀…');
    expect(clip('abcd', 4)).toBe('abcd');
  });

  it('iso', () => {
    expect(pyIso(1760000600000)).toBe('2025-10-09T09:03:20+00:00');
    expect(pyIso(1760000600)).toBe('2025-10-09T09:03:20+00:00');
    expect(pyIso('2026-10-20T10:05:00.123Z')).toBe('2026-10-20T10:05:00.123000+00:00');
    expect(pyIso('2026-10-20T10:07:30.5+02:00')).toBe('2026-10-20T08:07:30.500000+00:00');
    expect(pyIso('garbage')).toBeNull();
    expect(pyIso(null)).toBeNull();
    expect(pyIso('')).toBeNull();
  });

  it('shlex.quote and json.dumps', () => {
    expect(shlexQuote('/home/davin/acme')).toBe('/home/davin/acme');
    expect(shlexQuote("Beta 'quoted'")).toBe(`'Beta '"'"'quoted'"'"''`);
    expect(shlexQuote('')).toBe("''");
    expect(shlexQuote('café')).toBe("'café'");
    expect(pyJsonDumps([true, null, { b: 'é', a: [1] }])).toBe('[true, null, {"a": [1], "b": "\\u00e9"}]');
  });

  it('a drive-letter WSL path becomes the Linux folder only when it exists', () => {
    expect(wslFolder('C:/home/davin/acme', (p) => p === '/home/davin/acme')).toBe('/home/davin/acme');
    expect(wslFolder('C:/home/davin/gone', () => false)).toBeNull();
    expect(wslFolder('C:/Users/davin', () => true)).toBeNull();
  });

  it('a database that cannot be opened in place is read through a snapshot', () => {
    const home = path.join(FIX, 'home', '.codex');
    const file = path.join(home, 'state_5.sqlite');
    let failedInPlace = 0;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const reader = new DbReader({
      open: (target, readOnly) => {
        if (target === file) {
          failedInPlace++;
          throw new Error('disk I/O error');
        }
        return new DatabaseSync(target, readOnly ? { readOnly: true } : {});
      },
    });
    const sources = codexSources(reader, home, 'codex_cli', () => '');
    expect(sources.map((s) => s.source.split('#')[1]).sort()).toEqual(['019a0000-0000-7000-8000-000000000001', 't3', 't9']);
    expect(failedInPlace).toBe(1);
    const snap = reader.target(file)!;
    expect(snap).not.toBe(file);
    expect(fs.existsSync(snap)).toBe(true);
    reader.close();
    expect(fs.existsSync(snap)).toBe(false);
  });
});

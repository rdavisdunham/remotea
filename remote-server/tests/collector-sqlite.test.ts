/**
 * The collector's node:sqlite check: on a Node without it the collector says
 * once, in one actionable line, why Codex threads are skipped (and keeps
 * collecting Claude transcripts); on a supported Node it opens a Codex
 * database read-only, in place.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Collector, type ReportOut } from '../src/collector/collector';
import { CollectorState } from '../src/collector/state';
import { DbReader, SQLITE_MIN_NODE, codexSources, probeSqlite } from '../src/collector/codex-sqlite';

const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function missingSqlite(): never {
  const err = new Error('No such built-in module: node:sqlite') as NodeJS.ErrnoException;
  err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
  throw err;
}

/** A home with one Claude transcript and a Codex state database holding one thread. */
function syntheticHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-sqlite-home-'));
  made.push(home);
  const project = path.join(home, '.claude', 'projects', '-home-me-acme');
  fs.mkdirSync(project, { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(project, 'c1a0de00-0000-4000-8000-000000000001.jsonl'), [
    { type: 'user', sessionId: 'c1a0de00-0000-4000-8000-000000000001', cwd: '/home/me/acme', timestamp: at, message: { role: 'user', content: 'fix the build' } },
    { type: 'assistant', sessionId: 'c1a0de00-0000-4000-8000-000000000001', cwd: '/home/me/acme', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const codex = path.join(home, '.codex');
  fs.mkdirSync(codex);
  const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, title TEXT, first_user_message TEXT,
    archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, rollout_path TEXT, git_branch TEXT, git_origin_url TEXT)`);
  const now = Date.now() - 60_000;
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL)')
    .run('019a0000-0000-7000-8000-00000000c0de', 'cli', '/home/me/acme', 'tidy', 'tidy the repo', now, now, 'main');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL)')
    .run('019a0000-0000-7000-8000-00000000505b', 'subagent', '/home/me/acme', '', 'helper', now, now, 'main');
  db.close();
  return home;
}

function collector(home: string, probe?: () => string | null) {
  const sent: ReportOut[] = [];
  const warnings: string[] = [];
  const c = new Collector({
    home,
    windowsUsers: null,
    machine: 'testpc',
    state: new CollectorState(null),
    status: () => null,
    send: (r) => (sent.push(r), true),
    warn: (m) => warnings.push(m),
    repoOf: () => '',
    probeSqlite: probe,
  });
  return { c, sent, warnings };
}

describe('node:sqlite missing', () => {
  it('probeSqlite turns the load failure into one actionable line', () => {
    const msg = probeSqlite(missingSqlite)!;
    expect(msg).toContain(`Node v${process.versions.node}`);
    expect(msg).toContain('ERR_UNKNOWN_BUILTIN_MODULE');
    expect(msg).toContain(`needs Node >= ${SQLITE_MIN_NODE}`);
    expect(msg).toContain('nvm install 22');
    expect(msg).toContain('remote-server/scripts/install.sh');
    expect(msg).not.toContain('\n');
    expect(msg).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  });

  it('the collector warns once at activation, skips Codex, and still collects Claude', async () => {
    const home = syntheticHome();
    const { c, sent, warnings } = collector(home, () => probeSqlite(missingSqlite));
    expect(c.codexUnavailable).toContain(`needs Node >= ${SQLITE_MIN_NODE}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('nvm install 22');
    expect(warnings[0]).toContain('Claude Code sessions are still collected');

    await c.scan();
    await c.scan();
    expect(warnings).toHaveLength(1);
    expect(sent.map((r) => r.tool)).toEqual(['claude_code']);
  });
});

describe('node:sqlite on a supported Node', () => {
  it('the probe passes and the collector reads Codex threads', async () => {
    expect(probeSqlite()).toBeNull();
    const { c, sent, warnings } = collector(syntheticHome());
    expect(c.codexUnavailable).toBeNull();
    await c.scan();
    expect(warnings).toEqual([]);
    expect(sent.map((r) => `${r.tool}:${r.session_id}`).sort()).toEqual([
      'claude_code:c1a0de00-0000-4000-8000-000000000001',
      'codex_cli:019a0000-0000-7000-8000-00000000c0de',
    ]);
  });

  it('opens a synthetic Codex database in place, read-only', () => {
    const home = path.join(syntheticHome(), '.codex');
    const file = path.join(home, 'state_5.sqlite');
    const reader = new DbReader();
    try {
      const sources = codexSources(reader, home, 'codex_cli', () => '');
      expect(sources.map((s) => s.source.split('#')[1])).toEqual(['019a0000-0000-7000-8000-00000000c0de']);
      expect(reader.target(file)).toBe(file); // no snapshot needed
      const db = reader.connect(file) as unknown as DatabaseSync;
      try {
        expect(() => db.prepare("UPDATE threads SET title = 'x'").run()).toThrow(/readonly/i);
      } finally {
        db.close();
      }
    } finally {
      reader.close();
    }
  });
});

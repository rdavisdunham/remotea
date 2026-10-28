/**
 * Codex threads (`~/.codex/state_5.sqlite` + `thread_history_1.sqlite`, or a
 * rollout file), ported from collector.py `codex_sources` / `codex_session`.
 *
 * Read-only through node:sqlite. A running Windows app keeps its database in
 * WAL mode, whose shared-memory index cannot be mapped across /mnt/c ("disk
 * I/O error"), and immutable=1 would miss the WAL's newest writes; such a
 * database is read through a private snapshot (database + WAL copied to
 * /dev/shm), taken once per scan and removed when the scan ends.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { Transcript, WRAPPERS } from './transcript';
import { clip, pyStrip } from './redact';
import { environmentOf, localPath, shlexQuote, windowsPath, wslFolder } from './paths';
import { pyIso } from './iso';
import type { RepoLookup } from './git';
import type { FoundSession, Source } from './types';

type Row = Record<string, any>;

interface Db {
  prepare(sql: string): { all(...params: unknown[]): Row[]; get(...params: unknown[]): Row | undefined };
  close(): void;
}

let sqliteModule: { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => Db } | null = null;

/** node:sqlite, without its one-time ExperimentalWarning on stderr. */
function sqlite(): NonNullable<typeof sqliteModule> {
  if (sqliteModule) return sqliteModule;
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String(typeof w === 'string' ? w : w.message).includes('SQLite')) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqliteModule = require('node:sqlite') as NonNullable<typeof sqliteModule>;
  } finally {
    process.emitWarning = emit;
  }
  return sqliteModule;
}

/** Per-scan database access: remembers which files need a snapshot, and cleans the snapshots up. */
export class DbReader {
  private readonly readable = new Map<string, string>();
  private readonly dirs: string[] = [];

  constructor(private readonly opts: { open?: (target: string, readOnly: boolean) => Db } = {}) {}

  private open(target: string, readOnly: boolean): Db {
    if (this.opts.open) return this.opts.open(target, readOnly);
    return new (sqlite().DatabaseSync)(target, readOnly ? { readOnly: true } : {});
  }

  private snapshot(file: string): string {
    const base = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
    const dir = fs.mkdtempSync(path.join(base, 'remotea-collector-'));
    this.dirs.push(dir);
    const copy = path.join(dir, path.basename(file));
    fs.copyFileSync(file, copy);
    if (fs.existsSync(file + '-wal')) fs.copyFileSync(file + '-wal', copy + '-wal');
    return copy;
  }

  connect(file: string): Db {
    if (!this.readable.has(file)) {
      let ok = false;
      try {
        const db = this.open(file, true);
        try {
          db.prepare('SELECT count(*) FROM sqlite_master').get();
          ok = true;
        } finally {
          db.close();
        }
      } catch {
        ok = false;
      }
      this.readable.set(file, ok ? file : this.snapshot(file));
    }
    const target = this.readable.get(file)!;
    return target === file ? this.open(file, true) : this.open(target, false);
  }

  /** Test seam and the scan's end: forget snapshots. */
  setTarget(file: string, target: string): void {
    this.readable.set(file, target);
  }

  target(file: string): string | undefined {
    return this.readable.get(file);
  }

  close(): void {
    for (const d of this.dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    this.readable.clear();
  }
}

function userText(item: Row): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return pyStrip(content.filter((c: Row) => c && c.type === 'text').map((c: Row) => c.text ?? '').join('\n'));
}

/** Recent prompts and the last reply from Codex's thread history, newest first. */
export function codexHistory(reader: DbReader, home: string, threadId: string, t: Transcript): boolean {
  const file = path.join(home, 'thread_history_1.sqlite');
  if (!fs.existsSync(file)) return false;
  const db = reader.connect(file);
  let rows: Row[];
  try {
    t.turns = Number(db.prepare("SELECT count(*) AS n FROM thread_items WHERE thread_id=? AND item_type='userMessage'").get(threadId)?.n ?? 0);
    if (!t.turns) return false;
    rows = db.prepare(
      "SELECT item_type, item_json FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage')"
      + ' ORDER BY rollout_ordinal DESC LIMIT 20',
    ).all(threadId);
  } finally {
    db.close();
  }
  for (const r of rows) {
    const item = JSON.parse(r.item_json) as Row;
    if (r.item_type === 'agentMessage' && !t.reply) t.reply = item.text || '';
    else if (r.item_type === 'userMessage' && t.recent.length < 3) {
      const text = pyStrip(userText(item).replace(WRAPPERS, ''));
      if (text) t.appendLeft(text);
    }
  }
  return true;
}

export async function codexRollout(file: string, t: Transcript): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    let d: Row;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    const payload = d.payload && typeof d.payload === 'object' && !Array.isArray(d.payload) ? d.payload : {};
    if (d.type === 'event_msg' && payload.type === 'user_message') t.prompt(payload.message);
    else if (d.type === 'event_msg' && payload.type === 'agent_message') t.reply = payload.message || t.reply;
  }
}

function rolloutPath(raw: unknown): string | null {
  const local = localPath(raw as string);
  if (local) return local;
  const w = windowsPath((raw as string) || '');
  return /^[A-Za-z]:/.test(w) ? '/mnt/' + w[0].toLowerCase() + w.slice(2) : null;
}

export async function codexSession(
  reader: DbReader, home: string, tool: 'codex_cli' | 'codex_desktop', row: Row, repoOf: RepoLookup,
  isDir?: (p: string) => boolean,
): Promise<FoundSession | null> {
  if (row.archived) return null;
  const t = new Transcript();
  t.firstPrompt = pyStrip((row.first_user_message || '').replace(WRAPPERS, ''));
  if (!codexHistory(reader, home, row.id, t)) {
    const rollout = rolloutPath(row.rollout_path);
    if (rollout && fs.existsSync(rollout)) await codexRollout(rollout, t);
    t.firstPrompt = pyStrip((row.first_user_message || '').replace(WRAPPERS, '')) || t.firstPrompt;
  }
  if (!(t.turns || t.firstPrompt)) return null;
  let cwd = windowsPath(row.cwd);
  let environment = environmentOf(cwd, tool === 'codex_cli' ? 'wsl' : 'windows');
  const linux = wslFolder(cwd, isDir);
  if (linux) {
    cwd = linux;
    environment = 'wsl';
  }
  const title: string = row.name || row.title || '';
  const resume = tool === 'codex_cli'
    ? { cmd: `cd ${shlexQuote(cwd)} && codex resume ${row.id}` }
    : { hint: clip('ChatGPT desktop → ' + (title || 'this thread'), 200) };
  return {
    tool,
    session_id: row.id,
    environment,
    cwd,
    repo: repoOf(cwd, row.git_origin_url || ''),
    branch: row.git_branch || '',
    title,
    transcript: t,
    pr_urls: [],
    started_at: pyIso(row.created_at_ms || row.created_at),
    last_active_at: pyIso(row.updated_at_ms || row.updated_at),
    resume,
  };
}

/** Codex keeps its thread list in state_5.sqlite; reviewer and spawned subagent threads are skipped. */
export function codexSources(
  reader: DbReader, home: string, tool: 'codex_cli' | 'codex_desktop', repoOf: RepoLookup,
  warn: (msg: string) => void = () => {},
): Source[] {
  const file = path.join(home, 'state_5.sqlite');
  if (!fs.existsSync(file)) return [];
  let rows: Row[];
  try {
    const db = reader.connect(file);
    try {
      rows = db.prepare("SELECT * FROM threads WHERE source NOT LIKE '%subagent%'").all().map((r) => ({ ...r }));
    } finally {
      db.close();
    }
  } catch (err) {
    warn(`skipped ${file} this run: ${(err as Error).message}`);
    return [];
  }
  return rows.map((row) => {
    const updated = row.updated_at_ms || (row.updated_at || 0) * 1000;
    return {
      source: `${file}#${row.id}`,
      version: String(updated) + (row.archived ? ':a' : ''),
      modified: updated / 1000,
      read: () => codexSession(reader, home, tool, row, repoOf),
    };
  });
}

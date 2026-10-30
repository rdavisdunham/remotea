/**
 * The session collector, inside the server: a port of
 * ~/jarvis/scripts/session_collector/collector.py that reports through the
 * Eridani link instead of HTTP PUTs.
 *
 * Stage B runs it in PARITY mode: every report goes out with `parity: true`,
 * Eridani compares it field by field with what the Python collector stored,
 * and nothing is upserted. The Python collector stays authoritative until the
 * parity report has been clean for long enough (plan decision 23); then
 * `remotea eridani collector authoritative` makes this one the store's source
 * (stage E). The mode is the runtime's business: this class only scans.
 *
 *   scan()          every source (Claude transcripts, Codex threads; WSL and
 *                   the Windows side under /mnt/c), reporting what changed
 *   scanOne(p, id)  one session, right after one of its turns ended (or,
 *                   forced, on Eridani's `worktrees.scan`: sent even unchanged)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SessionReportInput, SessionTool } from '../../../src/shared/eridani-link-protocol';
import { claudeSources } from './claude-jsonl';
import { codexSources, DbReader, probeSqlite } from './codex-sqlite';
import { repoLookup, type RepoLookup } from './git';
import { pyDigest } from './pyjson';
import { redact } from './redact';
import { payload, remoteaTerminals, resumeInRemotea, type StatusLike, type Terminals } from './report';
import { CollectorState } from './state';
import type { FoundSession, Source } from './types';

/** collector.py READER: bump when the way sessions are read changes. */
export const READER = 2;
export const SETTLED_MS = 10 * 60 * 1000;

export interface ReportOut {
  entity: string;
  revision: string;
  tool: SessionTool;
  session_id: string;
  report: SessionReportInput;
}

export interface CollectorOptions {
  /** Linux home (~/.claude, ~/.codex). */
  home?: string;
  /** Where Windows user folders are (/mnt/c/Users); null = skip the Windows side. */
  windowsUsers?: string | null;
  machine?: string;
  state: CollectorState;
  /** The remotea registry as status --json shows it; null = remotea unavailable this time. */
  status: () => StatusLike | null;
  /** Hand a report to the link. Returns false when it could not be queued. */
  send?: (r: ReportOut) => boolean;
  now?: () => number;
  warn?: (msg: string) => void;
  repoOf?: RepoLookup;
  /** Test seam for the node:sqlite check made when the collector starts. */
  probeSqlite?: () => string | null;
}

export interface ScanOptions {
  dryRun?: boolean;
  days?: number;
  /** Only sources whose session id is this (scanOne). */
  only?: (sid: string) => boolean;
  /** Only sessions of this tool (scanOne for `worktrees.scan`). */
  tool?: SessionTool;
  /** Report every matching session even when its fingerprint is unchanged or already queued. */
  force?: boolean;
}

export interface ScanResult {
  seen: number;
  queued: number;
  failed: number;
  rows: Array<{ last: string; tool: string; title: string; cwd: string; where: string; report: SessionReportInput; session_id: string }>;
}

export function sourceId(source: string): string {
  if (source.includes('#')) return source.slice(source.lastIndexOf('#') + 1);
  const base = path.basename(source);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class Collector {
  private running: Promise<ScanResult> | null = null;
  /** Why Codex threads are skipped (node:sqlite missing), or null when they are read. */
  readonly codexUnavailable: string | null;

  constructor(private readonly opts: CollectorOptions) {
    // Checked once, here: an unsupported Node gets one actionable line, not a
    // stack trace or a warning per database per scan. Claude transcripts need no SQLite.
    this.codexUnavailable = (opts.probeSqlite ?? probeSqlite)();
    if (this.codexUnavailable) opts.warn?.(`${this.codexUnavailable} Claude Code sessions are still collected.`);
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private settled(lastActive: string | null | undefined): boolean {
    if (!lastActive) return false;
    const t = Date.parse(lastActive);
    return Number.isFinite(t) && this.now - t >= SETTLED_MS;
  }

  /** The Windows user folders that hold a .claude or .codex (collector.py `windows_homes`). */
  private windowsHomes(): string[] {
    const root = this.opts.windowsUsers;
    if (!root) return [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(root).filter((n) => !n.startsWith('.')).sort();
    } catch {
      return [];
    }
    const skip = new Set(['Public', 'Default', 'Default User', 'All Users']);
    return names
      .filter((n) => !skip.has(n))
      .map((n) => path.join(root, n))
      .filter((h) => {
        const isDir = (p: string) => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        };
        return isDir(h) && (isDir(path.join(h, '.claude')) || isDir(path.join(h, '.codex')));
      });
  }

  private sources(reader: DbReader, repoOf: RepoLookup): Source[] {
    const home = this.opts.home ?? os.homedir();
    const warn = this.opts.warn;
    const codex = !this.codexUnavailable;
    const out = [
      ...claudeSources(path.join(home, '.claude/projects'), 'wsl', repoOf),
      ...(codex ? codexSources(reader, path.join(home, '.codex'), 'codex_cli', repoOf, warn) : []),
    ];
    for (const w of this.windowsHomes()) {
      out.push(...claudeSources(path.join(w, '.claude/projects'), 'windows', repoOf));
      if (codex) out.push(...codexSources(reader, path.join(w, '.codex'), 'codex_desktop', repoOf, warn));
    }
    return out;
  }

  /** Terminals from the registry. A failed read reuses the last good one so resumes don't flap. */
  private terminals(): Terminals {
    const known = this.opts.state.data.remotea;
    let status: StatusLike | null = null;
    try {
      status = this.opts.status();
    } catch {
      status = null;
    }
    if (!status || (status.version !== 1 && status.version !== 2)) return known;
    const { live, groups } = remoteaTerminals(status);
    known.installed = true;
    known.live = live;
    known.groups = { ...known.groups, ...groups };
    return known;
  }

  /** One scan at a time; a request while one runs joins it. */
  scan(opts: ScanOptions = {}): Promise<ScanResult> {
    if (this.running && !opts.only) return this.running;
    const run = this.scanNow(opts).finally(() => {
      if (this.running === run) this.running = null;
    });
    if (!opts.only) this.running = run;
    return run;
  }

  scanOne(provider: string, sessionId: string, opts: { tool?: SessionTool; force?: boolean } = {}): Promise<ScanResult> {
    if (provider !== 'claude' && provider !== 'codex') return Promise.resolve({ seen: 0, queued: 0, failed: 0, rows: [] });
    return this.scanNow({ only: (sid) => sid === sessionId, tool: opts.tool, force: opts.force });
  }

  private async scanNow(opts: ScanOptions): Promise<ScanResult> {
    const state = this.opts.state;
    const known = state.data.sessions;
    const dry = !!opts.dryRun;
    const days = opts.days !== undefined ? opts.days : dry ? 7 : undefined;
    const cutoff = days ? this.now / 1000 - days * 86400 : 0;
    const machine = this.opts.machine || os.hostname();
    const reader = new DbReader();
    const repoOf = this.opts.repoOf ?? repoLookup();
    const reported = new Set<string>();
    const result: ScanResult = { seen: 0, queued: 0, failed: 0, rows: [] };
    try {
      const terminals = this.terminals();
      for (const src of this.sources(reader, repoOf)) {
        if (src.modified < cutoff) continue;
        const sid = sourceId(src.source);
        if (opts.only && !opts.only(sid)) continue;
        const version = [src.version, READER, pyDigest([terminals.installed, terminals.live[sid] ?? null, terminals.groups[sid] ?? null]).slice(0, 16)];
        const previous: Partial<typeof known[string]> = known[src.source] ?? {};
        if (!dry && !opts.force && sameJson(previous.version, version) && (previous.settled || !this.settled(previous.last_active))) continue;
        let session: FoundSession | null;
        try {
          session = await src.read();
        } catch (err) {
          this.opts.warn?.(`skipped a session store entry: ${(err as Error).message}`);
          continue;
        }
        const name = session ? `${session.tool}:${session.session_id}` : '';
        // Claude Desktop mirrors SSH sessions under ssh-<id> on Windows; the host's copy (read first) wins.
        if (!session || reported.has(name) || (opts.tool && session.tool !== opts.tool)) continue;
        reported.add(name);
        result.seen++;
        session.resume = resumeInRemotea(session, terminals);
        const body = payload(session, machine);
        if (dry) {
          const where = 'live' in body.resume ? 'live' : body.branch;
          result.rows.push({ last: body.last_active_at ?? '', tool: session.tool, title: body.title || Array.from(body.first_prompt).slice(0, 60).join(''), cwd: body.cwd, where, report: body, session_id: session.session_id });
          continue;
        }
        const fingerprint = pyDigest(body);
        const quiet = this.settled(body.last_active_at);
        if (!opts.force && previous.fingerprint === fingerprint && (previous.settled || !quiet)) {
          if (known[src.source]) known[src.source].version = version;
          continue;
        }
        if (!opts.force && state.pendingFingerprint(name) === fingerprint) continue;
        const queued = this.opts.send?.({ entity: name, revision: fingerprint, tool: session.tool, session_id: session.session_id, report: body }) ?? false;
        if (!queued) {
          result.failed++;
          continue;
        }
        state.expect(name, src.source, { version, fingerprint, settled: quiet, last_active: body.last_active_at });
        result.queued++;
      }
    } finally {
      reader.close();
      if (!dry) state.save();
    }
    return result;
  }
}

/** collector.py's dry-run table. */
export function formatRows(rows: ScanResult['rows'], days: number | undefined): string {
  const cut = (s: string, n: number) => Array.from(s).slice(0, n).join('');
  const tail = (s: string, n: number) => Array.from(s).slice(-n).join('');
  const padE = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - Array.from(s).length));
  const sorted = [...rows].sort((a, b) => {
    const ka = [a.last, a.tool, a.title, a.cwd, a.where];
    const kb = [b.last, b.tool, b.title, b.cwd, b.where];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? 1 : -1;
    return 0;
  });
  const lines = sorted.map((r) => `${padE(cut(r.last, 16), 16)}  ${padE(r.tool, 14)}  ${padE(cut(redact(r.title), 48), 48)}  ${padE(tail(r.cwd, 40), 40)}  ${cut(r.where, 24)}`);
  lines.push(`${rows.length} sessions` + (days ? ` active in the last ${days} days` : ''));
  return lines.join('\n') + '\n';
}

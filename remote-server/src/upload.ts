/**
 * Files pasted or dropped onto a remote pane, carried here from the app so the
 * program in the pane (an agent, usually: a screenshot for Claude Code) can
 * open them. `POST /upload?surf=<session>&name=<file name>` with the raw bytes
 * as the body, authenticated exactly like the WebSocket (server.ts).
 *
 * Each file gets a private directory, /tmp/remotea-drop-<uuid>/<name> (0700 /
 * 0600), the same place wmux's ssh uploads go (/tmp/wmux-drop-…): out of the
 * way, cleared with /tmp, and a name the user recognises when the path is
 * typed into the pane.
 *
 * Lifecycle (S-S3, UploadStore): the drops together are held to a budget
 * (`uploadBudgetMiB`, default 2 GiB) and an age (`uploadMaxAgeDays`, default
 * 7). Before each upload, and every few minutes, expired drops are removed,
 * then the oldest until the new one fits. A drop still referenced is kept:
 * one of the few most recent a session received, while that session is live
 * (and for a short grace after it stops, or right after the upload). When the
 * budget cannot be freed the upload is refused (507) with the reason. Usage
 * goes to `uploads-status.json` in the config dir and `remotea status --json`;
 * under 5% free space on the temp filesystem it carries a degraded note.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type http from 'http';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** A file name safe to create and to type into a shell: no path, no control or shell-special characters. */
export function safeUploadName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, '/'));
  let safe = base.replace(/[^A-Za-z0-9._ +-]/g, '_').replace(/\s+/g, ' ').trim();
  safe = safe.replace(/^[.-]+/, '');
  if (safe.length > 120) {
    const ext = path.extname(safe).slice(0, 16);
    safe = safe.slice(0, 120 - ext.length) + ext;
  }
  return safe || 'upload';
}

export type UploadOutcome = { ok: true; path: string; bytes: number } | { ok: false; status: number; error: string };

/**
 * Stream one request body to a new private file. The declared length is
 * required and enforced both ways: more is cut off (413), less is rejected
 * (400); either way nothing is left behind.
 */
export function receiveUpload(req: http.IncomingMessage, name: string, opts: { maxBytes?: number; tmpDir?: string; dir?: string } = {}): Promise<UploadOutcome> {
  const max = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const declared = Number(req.headers['content-length']);
  if (!Number.isInteger(declared) || declared < 0) return drain(req, { ok: false, status: 411, error: 'Content-Length required' });
  if (declared > max) return drain(req, { ok: false, status: 413, error: `larger than ${Math.round(max / 1024 / 1024)} MB` });
  const dir = opts.dir ?? newDropDir(opts.tmpDir);
  const file = path.join(dir, safeUploadName(name));
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    return drain(req, { ok: false, status: 500, error: (err as Error).message });
  }
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return new Promise((resolve) => {
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let done = false;
    const finish = (r: UploadOutcome) => {
      if (done) return;
      done = true;
      if (!r.ok) {
        out.destroy();
        cleanup();
      }
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > declared) {
        req.unpipe(out);
        req.resume();
        finish({ ok: false, status: 413, error: 'body longer than Content-Length' });
      }
    });
    req.on('aborted', () => finish({ ok: false, status: 400, error: 'upload aborted' }));
    req.on('error', () => finish({ ok: false, status: 400, error: 'upload failed' }));
    out.on('error', (err) => finish({ ok: false, status: 500, error: err.message }));
    out.on('finish', () => {
      if (bytes !== declared) finish({ ok: false, status: 400, error: `got ${bytes} of ${declared} bytes` });
      else finish({ ok: true, path: file, bytes });
    });
    req.pipe(out);
  });
}

function drain(req: http.IncomingMessage, r: UploadOutcome): Promise<UploadOutcome> {
  req.resume();
  return Promise.resolve(r);
}

// ── Lifecycle: budget, age, references (S-S3) ───────────────────────────────

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_UPLOAD_BUDGET_BYTES = 2048 * MiB;
export const DEFAULT_UPLOAD_MAX_AGE_MS = 7 * DAY;
/** A drop stays referenced this long after its upload, and after its session stops being live. */
export const UPLOAD_REF_GRACE_MS = 10 * 60 * 1000;
/** Only a session's most recent drops count as referenced while it lives. */
export const UPLOAD_REFS_PER_SURFACE = 8;
/** Under this share of free space on the temp filesystem, usage carries a degraded note. */
export const LOW_SPACE_RATIO = 0.05;
export const UPLOADS_STATUS_FILE = 'uploads-status.json';
const DROP_RE = /^remotea-drop-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newDropDir(tmpDir?: string): string {
  return path.join(tmpDir ?? os.tmpdir(), `remotea-drop-${crypto.randomUUID()}`);
}

/** One upload's private directory as found on disk. */
export interface DropEntry {
  dir: string;
  bytes: number;
  files: number;
  /** The newest of the folder's and its files' modification times. */
  mtimeMs: number;
}

/** Usage as `remotea status --json` (`uploads`) and `uploads-status.json` report it. */
export interface UploadUsage {
  bytes: number;
  files: number;
  budget: number;
  maxAgeDays: number;
  tempDir: string;
  /** Free bytes and their share on the temp filesystem; null when it cannot be read. */
  freeBytes: number | null;
  freeRatio: number | null;
  /** Why uploads are degraded (under 5% free space, or over budget with referenced files), else null. */
  degraded: string | null;
  /** Drops removed by the lifecycle since the server started. */
  reclaimed: { files: number; bytes: number };
  at: number;
}

export interface FsSpace {
  /** Bytes available to this user, and the filesystem's size. */
  free: number;
  total: number;
}

export function tempSpace(dir: string): FsSpace | null {
  try {
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** This user's drop folders under `tmpDir`, oldest first (never a symlink, never another user's). */
export function scanDrops(tmpDir: string): DropEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(tmpDir);
  } catch {
    return [];
  }
  const uid = process.getuid?.();
  const out: DropEntry[] = [];
  for (const name of names) {
    if (!DROP_RE.test(name)) continue;
    const dir = path.join(tmpDir, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
      const e: DropEntry = { dir, bytes: 0, files: 0, mtimeMs: st.mtimeMs };
      for (const f of fs.readdirSync(dir)) {
        const fst = fs.lstatSync(path.join(dir, f));
        if (!fst.isFile()) continue;
        e.files++;
        e.bytes += fst.size;
        e.mtimeMs = Math.max(e.mtimeMs, fst.mtimeMs);
      }
      out.push(e);
    } catch {
      /* vanished or unreadable: not ours to count */
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * MiB) return `${(n / 1024 / MiB).toFixed(1)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(1)} MiB`;
  return `${Math.ceil(n / 1024)} KiB`;
}

export interface UploadStoreOptions {
  tmpDir?: string;
  budgetBytes?: number;
  maxAgeMs?: number;
  graceMs?: number;
  /** Is this session running here? The recent drops of a live session are kept. */
  isLive?: (surf: string) => boolean;
  /** Where usage is written (`<config dir>/uploads-status.json`); null or absent: nowhere. */
  statusFile?: string | null;
  now?: () => number;
  space?: (dir: string) => FsSpace | null;
  log?: (m: string) => void;
}

export type AdmitOutcome = { ok: true } | { ok: false; status: number; error: string };

interface Swept {
  bytes: number;
  files: number;
}

/**
 * The drops' budget, age limit and references. Each check and the
 * reservation that follows it run with no await in between, so two
 * concurrent uploads cannot both claim the same room.
 */
export class UploadStore {
  readonly tmpDir: string;
  readonly budget: number;
  readonly maxAgeMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  /** Each session's most recent drops, oldest first (at most UPLOAD_REFS_PER_SURFACE). */
  private readonly recent = new Map<string, Array<{ dir: string; at: number }>>();
  /** When a session was first seen not live (its drops keep a grace from then). */
  private readonly goneAt = new Map<string, number>();
  /** Uploads being received: their folder and declared size. */
  private readonly inflight = new Map<string, number>();
  private readonly reclaimed = { files: 0, bytes: 0 };

  constructor(private readonly opts: UploadStoreOptions = {}) {
    this.tmpDir = opts.tmpDir ?? os.tmpdir();
    this.budget = opts.budgetBytes ?? DEFAULT_UPLOAD_BUDGET_BYTES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_UPLOAD_MAX_AGE_MS;
    this.graceMs = opts.graceMs ?? UPLOAD_REF_GRACE_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Is this drop folder kept because a session still refers to it? */
  referenced(dir: string): boolean {
    const now = this.now();
    for (const [surf, list] of this.recent) {
      const ref = list.find((r) => r.dir === dir);
      if (!ref) continue;
      if (now - ref.at < this.graceMs) return true;
      if (this.opts.isLive?.(surf)) {
        this.goneAt.delete(surf);
        return true;
      }
      if (!this.goneAt.has(surf)) this.goneAt.set(surf, now);
      return now - this.goneAt.get(surf)! < this.graceMs;
    }
    return false;
  }

  /** A drop was received for `surf`: it is referenced (only the session's latest few are). */
  reference(surf: string, dir: string): void {
    const list = this.recent.get(surf) ?? [];
    list.push({ dir, at: this.now() });
    while (list.length > UPLOAD_REFS_PER_SURFACE) list.shift();
    this.recent.set(surf, list);
  }

  private pending(): number {
    let n = 0;
    for (const b of this.inflight.values()) n += b;
    return n;
  }

  /**
   * Remove expired unreferenced drops, then the oldest unreferenced ones
   * until `incoming` more bytes fit the budget. Returns what remains
   * (uploads in progress counted at their declared size).
   */
  sweep(incoming = 0): Swept {
    const now = this.now();
    const entries = scanDrops(this.tmpDir).filter((e) => !this.inflight.has(e.dir));
    let bytes = entries.reduce((n, e) => n + e.bytes, 0);
    let files = entries.reduce((n, e) => n + e.files, 0);
    const pending = this.pending();
    const keep = entries.map((e) => this.referenced(e.dir));
    const gone = new Set<string>();
    const remove = (e: DropEntry, why: string): void => {
      try {
        fs.rmSync(e.dir, { recursive: true, force: true });
      } catch (err) {
        this.log(`uploads: cannot remove ${e.dir}: ${(err as Error).message}`);
        return;
      }
      gone.add(e.dir);
      bytes -= e.bytes;
      files -= e.files;
      this.reclaimed.files += e.files;
      this.reclaimed.bytes += e.bytes;
      this.log(`uploads: removed ${path.basename(e.dir)} (${fmtBytes(e.bytes)}, ${why})`);
    };
    // Expired ones go regardless of the budget; then the oldest, until the incoming file fits.
    entries.forEach((e, i) => {
      if (!keep[i] && now - e.mtimeMs > this.maxAgeMs) remove(e, 'expired');
    });
    for (let i = 0; i < entries.length && bytes + pending + incoming > this.budget; i++) {
      if (!keep[i] && !gone.has(entries[i].dir)) remove(entries[i], 'over budget');
    }
    for (const [surf, list] of this.recent) {
      const left = list.filter((r) => !gone.has(r.dir) && fs.existsSync(r.dir));
      if (left.length) this.recent.set(surf, left);
      else {
        this.recent.delete(surf);
        this.goneAt.delete(surf);
      }
    }
    return { bytes: bytes + pending, files };
  }

  /** Make room for `declared` more bytes, or say why there is none. Writes the status either way. */
  admit(declared: number): AdmitOutcome {
    const r = this.sweep(declared);
    const space = (this.opts.space ?? tempSpace)(this.tmpDir);
    let out: AdmitOutcome = { ok: true };
    if (r.bytes + declared > this.budget) {
      out = {
        ok: false,
        status: 507,
        error: `upload budget full: ${fmtBytes(r.bytes)} of ${fmtBytes(this.budget)} is held by files sessions still refer to (or uploads in progress); try again later, or raise uploadBudgetMiB in config.json`,
      };
    } else if (space && declared > space.free) {
      out = { ok: false, status: 507, error: `not enough free space in ${this.tmpDir}: ${fmtBytes(space.free)} free` };
    }
    this.write(this.usage(r, space));
    return out;
  }

  /**
   * Receive one upload for `surf` within the budget: refused (507) before any
   * byte is written when it cannot fit, referenced once it has arrived.
   */
  async receive(req: http.IncomingMessage, surf: string, name: string, opts: { maxBytes?: number } = {}): Promise<UploadOutcome> {
    const declared = Number(req.headers['content-length']);
    const max = opts.maxBytes ?? MAX_UPLOAD_BYTES;
    const sized = Number.isInteger(declared) && declared >= 0 && declared <= max;
    if (sized) {
      const room = this.admit(declared);
      if (!room.ok) return drain(req, room);
    }
    const dir = newDropDir(this.tmpDir);
    if (sized) this.inflight.set(dir, declared);
    let r: UploadOutcome;
    try {
      r = await receiveUpload(req, name, { maxBytes: max, dir });
    } finally {
      this.inflight.delete(dir);
    }
    if (r.ok) this.reference(surf, dir);
    if (sized) this.write(this.usage());
    return r;
  }

  /** Current usage (measured now when `swept` is not given). */
  usage(swept?: Swept, space?: FsSpace | null): UploadUsage {
    const r = swept ?? this.measure();
    const sp = space === undefined ? (this.opts.space ?? tempSpace)(this.tmpDir) : space;
    const freeRatio = sp && sp.total > 0 ? sp.free / sp.total : null;
    const notes: string[] = [];
    if (sp && freeRatio !== null && freeRatio < LOW_SPACE_RATIO) notes.push(`low space: ${(freeRatio * 100).toFixed(1)}% free in ${this.tmpDir} (${fmtBytes(sp.free)})`);
    if (r.bytes > this.budget) notes.push(`over budget: ${fmtBytes(r.bytes)} of ${fmtBytes(this.budget)}, held by files sessions still refer to`);
    return {
      bytes: r.bytes,
      files: r.files,
      budget: this.budget,
      maxAgeDays: Math.round((this.maxAgeMs / DAY) * 100) / 100,
      tempDir: this.tmpDir,
      freeBytes: sp?.free ?? null,
      freeRatio: freeRatio === null ? null : Math.round(freeRatio * 10_000) / 10_000,
      degraded: notes.length ? notes.join('; ') : null,
      reclaimed: { ...this.reclaimed },
      at: this.now(),
    };
  }

  private measure(): Swept {
    const entries = scanDrops(this.tmpDir).filter((e) => !this.inflight.has(e.dir));
    return { bytes: entries.reduce((n, e) => n + e.bytes, 0) + this.pending(), files: entries.reduce((n, e) => n + e.files, 0) };
  }

  /** The periodic tick: sweep, then write the status. */
  tick(): UploadUsage {
    const usage = this.usage(this.sweep());
    this.write(usage);
    return usage;
  }

  private write(usage: UploadUsage): void {
    const file = this.opts.statusFile;
    if (!file) return;
    try {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(usage, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log(`uploads: cannot write ${path.basename(file)}: ${(err as Error).message}`);
    }
  }
}

/** The usage the running server last wrote, or null. */
export function readUploadsStatus(configDir: string): UploadUsage | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, UPLOADS_STATUS_FILE), 'utf8')) as UploadUsage;
  } catch {
    return null;
  }
}

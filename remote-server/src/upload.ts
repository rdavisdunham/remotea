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
export function receiveUpload(req: http.IncomingMessage, name: string, opts: { maxBytes?: number; tmpDir?: string } = {}): Promise<UploadOutcome> {
  const max = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const declared = Number(req.headers['content-length']);
  if (!Number.isInteger(declared) || declared < 0) return drain(req, { ok: false, status: 411, error: 'Content-Length required' });
  if (declared > max) return drain(req, { ok: false, status: 413, error: `larger than ${Math.round(max / 1024 / 1024)} MB` });
  const dir = path.join(opts.tmpDir ?? os.tmpdir(), `remotea-drop-${crypto.randomUUID()}`);
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

/**
 * Upload a local file to a remote host for a pane that runs there (a pasted
 * screenshot, a dropped file): `POST /upload` on the server the app already
 * talks to, authenticated with the same token (remote-server/src/upload.ts).
 * Answers with the path the file now has on the server, to type into the pane.
 */
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

/** The server's HTTP address for a host URL (ws://h:p → http://h:p). */
export function uploadUrl(hostUrl: string, surfaceId: string, name: string): URL {
  const u = new URL(hostUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/upload';
  u.search = new URLSearchParams({ surf: surfaceId, name }).toString();
  return u;
}

export type UploadResult = { ok: true; path: string } | { ok: false; error: string };

export function uploadFile(opts: { hostUrl: string; token: string; surfaceId: string; localPath: string; signal?: AbortSignal }): Promise<UploadResult> {
  return new Promise((resolve) => {
    let size: number;
    try {
      size = fs.statSync(opts.localPath).size;
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
      return;
    }
    const url = uploadUrl(opts.hostUrl, opts.surfaceId, path.basename(opts.localPath));
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (r: UploadResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = lib.request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/octet-stream', 'content-length': size },
      signal: opts.signal,
      // Generous for a slow link, finite for a dead one: 15 s plus 1 s per MB.
      timeout: 15_000 + Math.ceil(size / 1_000_000) * 1000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { if (body.length < 4096) body += d; });
      res.on('end', () => {
        let parsed: { path?: unknown; error?: unknown } = {};
        try { parsed = JSON.parse(body); } catch { /* not JSON */ }
        if (res.statusCode === 200 && typeof parsed.path === 'string') done({ ok: true, path: parsed.path });
        else done({ ok: false, error: typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.statusCode}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('upload timed out')));
    req.on('error', (err) => done({ ok: false, error: opts.signal?.aborted ? 'cancelled' : err.message }));
    const file = fs.createReadStream(opts.localPath);
    file.on('error', (err) => {
      req.destroy(err);
      done({ ok: false, error: err.message });
    });
    file.pipe(req);
  });
}

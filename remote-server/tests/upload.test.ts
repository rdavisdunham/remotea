/**
 * Paste/drop uploads: the server route (same admission rules as the
 * WebSocket), the file it writes, and the app's real uploader against it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { RemoteaServer } from '../src/server';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { safeUploadName } from '../src/upload';
import { fakeSpawner, FakeConn, ManualTimers } from './helpers';
import { uploadFile, uploadUrl } from '../../src/main/remote-hosts/upload';

const TOKEN = 'upload-token-0123456789';
const SURF = 'surf-up-1';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function rig() {
  const hub = new Hub({ registry: Registry.load({ file: null, bootId: 'b' }), spawn: fakeSpawner().spawn, bootId: 'b', serverId: 's', timers: new ManualTimers(), probe: () => ({}) });
  const c = new FakeConn(1);
  hub.connect(c);
  hub.handle(c, { t: 'hello', proto: 1, device: { id: 'device-aaaaaaaa', name: 'a' }, app: { name: 't', version: '0' } });
  hub.handle(c, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24, create: {} });
  const server = new RemoteaServer({ hub, token: () => TOKEN });
  const port = await server.listen('127.0.0.1', 0);
  cleanup.push(async () => {
    hub.shutdown();
    await server.close();
  });
  return { port, url: `ws://127.0.0.1:${port}` };
}

function post(port: number, query: string, body: Buffer | string, headers: Record<string, string | number> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/upload?${query}`, headers: { authorization: `Bearer ${TOKEN}`, 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const forget = (p: string) => cleanup.push(() => fs.rmSync(path.dirname(p), { recursive: true, force: true }));

describe('upload route', () => {
  it('writes the file privately under /tmp/remotea-drop-*/ and answers its path', async () => {
    const { port } = await rig();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const r = await post(port, `surf=${SURF}&name=${encodeURIComponent('Screenshot 2026-10-27.png')}`, png);
    expect(r.status).toBe(200);
    forget(r.body.path);
    expect(r.body.path).toMatch(new RegExp(`^${os.tmpdir()}/remotea-drop-[0-9a-f-]{36}/Screenshot 2026-10-27\\.png$`));
    expect(fs.readFileSync(r.body.path)).toEqual(png);
    expect(fs.statSync(r.body.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(r.body.path)).mode & 0o777).toBe(0o700);
  });

  it('is shut to a bad token, a browser, an unknown session and an oversized or short body', async () => {
    const { port } = await rig();
    expect((await post(port, `surf=${SURF}&name=a.txt`, 'x', { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(port, `surf=${SURF}&name=a.txt`, 'x', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(port, `surf=surf-nope&name=a.txt`, 'x')).status).toBe(404);
    expect((await post(port, `name=a.txt`, 'x')).status).toBe(400);
    expect((await post(port, `surf=${SURF}&name=a.txt`, 'x', { 'content-length': 500 * 1024 * 1024 })).status).toBe(413);
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('remotea-drop-')).length;
    // Declares more than it sends, then ends: rejected, and nothing left behind.
    const short = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/upload?surf=${SURF}&name=a.txt`, headers: { authorization: `Bearer ${TOKEN}`, 'content-length': 10 } }, (res) => resolve(res.statusCode ?? 0));
      req.on('error', () => resolve(-1));
      req.write('abc');
      setTimeout(() => req.destroy(), 50);
    });
    expect(short === -1 || short === 400).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('remotea-drop-')).length).toBe(before);
  });

  it('names are safe to create and to type into a shell', () => {
    expect(safeUploadName('../../etc/passwd')).toBe('passwd');
    expect(safeUploadName('C:\\Users\\me\\Pictures\\shot.png')).toBe('shot.png');
    expect(safeUploadName('a$(rm -rf ~);`x`.png')).toBe('a__rm -rf ____x_.png');
    expect(safeUploadName('-rf')).toBe('rf');
    expect(safeUploadName('...')).toBe('upload');
    expect(safeUploadName('x'.repeat(300) + '.jpeg')).toMatch(/^x{115}\.jpeg$/);
  });
});

describe('upload route with Expect: 100-continue', () => {
  /** A request that waits for 100 Continue; `continued` says whether the server asked for the body. */
  function expecting(port: number, query: string, headers: Record<string, string | number> = {}): Promise<{ status: number; continued: boolean }> {
    return new Promise((resolve, reject) => {
      let continued = false;
      const body = Buffer.alloc(1024, 1);
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/upload?${query}`, headers: { authorization: `Bearer ${TOKEN}`, 'content-length': body.length, expect: '100-continue', ...headers } }, (res) => {
        res.resume();
        res.on('end', () => {
          if (!continued) req.destroy();
          resolve({ status: res.statusCode ?? 0, continued });
        });
      });
      req.on('continue', () => {
        continued = true;
        req.end(body);
      });
      req.on('error', reject);
    });
  }

  it('refuses before the body is sent, and asks for it only when the upload is admitted', async () => {
    const { port } = await rig();
    expect(await expecting(port, `surf=${SURF}&name=a.txt`, { authorization: 'Bearer nope' })).toEqual({ status: 401, continued: false });
    expect(await expecting(port, `surf=surf-nope&name=a.txt`)).toEqual({ status: 404, continued: false });
    expect(await expecting(port, `name=a.txt`)).toEqual({ status: 400, continued: false });
    expect(await expecting(port, `surf=${SURF}&name=a.txt`, { 'content-length': 500 * 1024 * 1024 })).toEqual({ status: 413, continued: false });
    const ok = await expecting(port, `surf=${SURF}&name=${encodeURIComponent('continued.bin')}`);
    expect(ok).toEqual({ status: 200, continued: true });
    for (const f of fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('remotea-drop-'))) {
      if (fs.existsSync(path.join(os.tmpdir(), f, 'continued.bin'))) fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true });
    }
  });
});

describe('app uploader against the server', () => {
  it('streams a local file and returns the server path; errors come back as text', async () => {
    const { url } = await rig();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-local-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const local = path.join(dir, 'big image.png');
    const data = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    fs.writeFileSync(local, data);
    const ok = await uploadFile({ hostUrl: url, token: TOKEN, surfaceId: SURF, localPath: local });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      forget(ok.path);
      expect(path.basename(ok.path)).toBe('big image.png');
      expect(fs.readFileSync(ok.path).equals(data)).toBe(true);
    }
    // A refusal is answered, never a write into a closed connection (it used to come back as `write EPIPE`).
    for (let i = 0; i < 5; i++) {
      expect(await uploadFile({ hostUrl: url, token: 'wrong', surfaceId: SURF, localPath: local })).toEqual({ ok: false, error: 'Unauthorized' });
    }
    expect(await uploadFile({ hostUrl: url, token: TOKEN, surfaceId: 'surf-gone', localPath: local })).toEqual({ ok: false, error: 'no such live session' });
    expect((await uploadFile({ hostUrl: url, token: TOKEN, surfaceId: SURF, localPath: path.join(dir, 'missing.png') })).ok).toBe(false);
    expect(uploadUrl('wss://h.example:7717/x', SURF, 'a b.png').toString()).toBe(`https://h.example:7717/upload?surf=${SURF}&name=a+b.png`);
  });
});

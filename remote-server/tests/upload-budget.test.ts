/**
 * S-S3: pasted/dropped files are held to a budget and an age. Old
 * unreferenced drops are reclaimed oldest first, drops a live session still
 * refers to are kept, usage is reported (status file and `remotea status`),
 * an upload that cannot fit is refused, and low free space is noted.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteaServer } from '../src/server';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { DEFAULT_CONFIG } from '../src/config';
import { uploadsStatus } from '../src/cli';
import { UPLOADS_STATUS_FILE, UPLOAD_REFS_PER_SURFACE, UploadStore, readUploadsStatus, scanDrops } from '../src/upload';
import { fakeSpawner, FakeConn, ManualTimers } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const KiB = 1024;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmp(prefix = 'upb-'): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A drop folder as an upload leaves it, `ageMs` old. */
function drop(tmpDir: string, bytes: number, ageMs: number, now: number, name = 'shot.png'): string {
  const dir = path.join(tmpDir, `remotea-drop-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1), { mode: 0o600 });
  const t = new Date(now - ageMs);
  fs.utimesSync(file, t, t);
  fs.utimesSync(dir, t, t);
  return dir;
}

const PLENTY = () => ({ free: 100 * 1024 * 1024 * 1024, total: 200 * 1024 * 1024 * 1024 });

describe('upload budget and lifecycle', () => {
  it('reclaims expired unreferenced drops, then the oldest until the new file fits the budget', () => {
    const t = tmp();
    const now = Date.now();
    const expired = drop(t, 10 * KiB, 8 * DAY, now);
    const oldest = drop(t, 40 * KiB, 3 * DAY, now);
    const middle = drop(t, 40 * KiB, 2 * DAY, now);
    const newest = drop(t, 40 * KiB, 1 * DAY, now);
    // Not a drop of ours: never counted, never touched.
    fs.mkdirSync(path.join(t, 'wmux-drop-x'));
    const store = new UploadStore({ tmpDir: t, budgetBytes: 100 * KiB, now: () => now, space: PLENTY });
    expect(store.usage()).toMatchObject({ bytes: 130 * KiB, files: 4, budget: 100 * KiB, maxAgeDays: 7 });
    // 20 KiB incoming: the expired one goes, then the oldest (80 + 20 <= 100), and no more.
    expect(store.admit(20 * KiB)).toEqual({ ok: true });
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.existsSync(path.join(t, 'wmux-drop-x'))).toBe(true);
    expect(store.usage()).toMatchObject({ bytes: 80 * KiB, files: 2, reclaimed: { files: 2, bytes: 50 * KiB } });
  });

  it('keeps drops a live session still refers to, even when expired or over budget, and refuses when it cannot free room', () => {
    const t = tmp();
    let now = Date.now();
    let live = true;
    const store = new UploadStore({ tmpDir: t, budgetBytes: 100 * KiB, now: () => now, isLive: () => live, space: PLENTY, graceMs: 60_000 });
    const kept = drop(t, 60 * KiB, 9 * DAY, now);
    const other = drop(t, 30 * KiB, 1 * DAY, now);
    store.reference('surf-a', kept);
    now += 2 * 60_000; // past the upload's own grace: kept only because surf-a is live
    const refused = store.admit(50 * KiB);
    expect(refused).toMatchObject({ ok: false, status: 507 });
    expect(refused.ok ? '' : refused.error).toMatch(/^upload budget full: 60\.0 MiB|^upload budget full: 60 KiB/);
    expect(refused.ok ? '' : refused.error).toMatch(/uploadBudgetMiB/);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(other)).toBe(false); // freed what it could
    // The session ends: its drops keep a short grace, then go.
    live = false;
    expect(store.admit(50 * KiB)).toMatchObject({ ok: false });
    expect(fs.existsSync(kept)).toBe(true);
    now += 61_000;
    expect(store.admit(50 * KiB)).toEqual({ ok: true });
    expect(fs.existsSync(kept)).toBe(false);
  });

  it("only a session's most recent drops count as referenced", () => {
    const t = tmp();
    const now = Date.now();
    const store = new UploadStore({ tmpDir: t, budgetBytes: 1, now: () => now, isLive: () => true, space: PLENTY, graceMs: 0 });
    const dirs = Array.from({ length: UPLOAD_REFS_PER_SURFACE + 2 }, (_, i) => drop(t, 1 * KiB, (100 - i) * 1000, now));
    for (const d of dirs) store.reference('surf-a', d);
    store.tick();
    expect(dirs.map((d) => fs.existsSync(d))).toEqual(dirs.map((_, i) => i >= 2));
  });

  it('reports usage in the status file and in remotea status, with a low-space note under 5%', () => {
    const t = tmp();
    const conf = tmp('upb-conf-');
    const now = Date.now();
    drop(t, 3 * KiB, 1000, now);
    const store = new UploadStore({ tmpDir: t, budgetBytes: 2048 * 1024 * 1024, now: () => now, statusFile: path.join(conf, UPLOADS_STATUS_FILE), space: () => ({ free: 4 * 1024 * 1024, total: 100 * 1024 * 1024 }) });
    const u = store.tick();
    expect(u).toMatchObject({ bytes: 3 * KiB, files: 1, budget: 2048 * 1024 * 1024, freeRatio: 0.04, tempDir: t });
    expect(u.degraded).toMatch(/^low space: 4\.0% free in /);
    expect(readUploadsStatus(conf)).toEqual(u);
    expect(fs.statSync(path.join(conf, UPLOADS_STATUS_FILE)).mode & 0o777).toBe(0o600);
    // `remotea status --json` (uploads): what the running server wrote.
    expect(uploadsStatus(conf, DEFAULT_CONFIG, true)).toEqual({ bytes: 3 * KiB, files: 1, budget: 2048 * 1024 * 1024, maxAgeDays: 7, tempDir: t, freeBytes: 4 * 1024 * 1024, freeRatio: 0.04, degraded: u.degraded, at: now });
    // Server down: measured here, against the configured budget.
    const down = uploadsStatus(conf, { ...DEFAULT_CONFIG, uploadBudgetMiB: 10, uploadMaxAgeDays: 2 }, false);
    expect(down).toMatchObject({ budget: 10 * 1024 * 1024, maxAgeDays: 2, tempDir: os.tmpdir() });
    // Plenty of space: no note.
    expect(new UploadStore({ tmpDir: t, now: () => now, space: PLENTY }).usage().degraded).toBeNull();
  });

  it('refuses an upload that would not fit the free space', () => {
    const t = tmp();
    const store = new UploadStore({ tmpDir: t, space: () => ({ free: 10 * KiB, total: 1000 * KiB }) });
    expect(store.admit(20 * KiB)).toMatchObject({ ok: false, status: 507, error: expect.stringMatching(/^not enough free space in /) });
  });
});

describe('upload route within the budget', () => {
  const TOKEN = 'upload-budget-token-0123456789';
  const SURF = 'surf-upb-1';

  async function rig(store: UploadStore) {
    const hub = new Hub({ registry: Registry.load({ file: null, bootId: 'b' }), spawn: fakeSpawner().spawn, bootId: 'b', serverId: 's', timers: new ManualTimers(), probe: () => ({}) });
    const c = new FakeConn(1);
    hub.connect(c);
    hub.handle(c, { t: 'hello', proto: 1, device: { id: 'device-aaaaaaaa', name: 'a' }, app: { name: 't', version: '0' } });
    hub.handle(c, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24, create: {} });
    const server = new RemoteaServer({ hub, token: () => TOKEN, uploads: store });
    const port = await server.listen('127.0.0.1', 0);
    cleanups.push(async () => {
      hub.shutdown();
      await server.close();
    });
    return port;
  }

  function post(port: number, name: string, body: Buffer, expectContinue = false): Promise<{ status: number; body: any; continued: boolean }> {
    return new Promise((resolve, reject) => {
      let continued = false;
      const headers: Record<string, string | number> = { authorization: `Bearer ${TOKEN}`, 'content-length': body.length };
      if (expectContinue) headers.expect = '100-continue';
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/upload?surf=${SURF}&name=${name}`, headers }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if (expectContinue && !continued) req.destroy();
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null, continued });
        });
      });
      req.on('continue', () => {
        continued = true;
        req.end(body);
      });
      req.on('error', reject);
      if (!expectContinue) req.end(body);
    });
  }

  it('stores into the managed temp dir, references the file for its session, and refuses (507) when the budget is held', async () => {
    const t = tmp();
    const store = new UploadStore({ tmpDir: t, budgetBytes: 10 * KiB, isLive: () => true, space: PLENTY });
    const port = await rig(store);
    const a = await post(port, 'a.png', Buffer.alloc(6 * KiB, 1));
    expect(a.status).toBe(200);
    expect(path.dirname(path.dirname(a.body.path))).toBe(t);
    expect(store.referenced(path.dirname(a.body.path))).toBe(true);
    // a.png is referenced by a live session: 6 + 6 KiB cannot fit 10 KiB.
    const b = await post(port, 'b.png', Buffer.alloc(6 * KiB, 2));
    expect(b.status).toBe(507);
    expect(b.body.error).toMatch(/^upload budget full/);
    // With Expect: 100-continue the refusal comes before the body is sent.
    expect(await post(port, 'c.png', Buffer.alloc(6 * KiB, 3), true)).toMatchObject({ status: 507, continued: false });
    expect(scanDrops(t).map((e) => e.dir)).toEqual([path.dirname(a.body.path)]);
    // A small one still fits.
    expect((await post(port, 'd.png', Buffer.alloc(2 * KiB, 4), true)).status).toBe(200);
  });
});

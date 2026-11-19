/**
 * The explorer on a remote pane: remotea's own jail and readers, run on the
 * server, rooted at the session's directory — never a path the app names.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runFsOp } from '../src/remote-fs';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { FakeConn, fakeSpawner, ManualTimers, waitFor } from './helpers';
import { parseClientMsg } from '../../src/shared/remote-host-protocol';

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-fs-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(os.tmpdir(), 'remotea-fs-outside.txt'), 'secret');
  cleanup.push(() => fs.rmSync(path.join(os.tmpdir(), 'remotea-fs-outside.txt'), { force: true }));
  fs.symlinkSync(path.join(os.tmpdir(), 'remotea-fs-outside.txt'), path.join(root, 'link.txt'));
  return root;
}

describe('remote fs operations', () => {
  it('lists, reads code and markdown, and writes back with the mtime guard', async () => {
    const root = tree();
    const list = (await runFsOp(root, { op: 'list' })) as { entries: Array<{ name: string; kind: string }> };
    expect(list.entries.map((e) => `${e.name}:${e.kind}`)).toEqual(expect.arrayContaining(['src:dir', 'README.md:file']));
    const code = (await runFsOp(root, { op: 'readCode', path: 'src/a.ts' })) as { content: string; mtimeMs: number };
    expect(code.content).toBe('export const a = 1;\n');
    expect(((await runFsOp(root, { op: 'readMarkdown', path: 'README.md' })) as { content: string }).content).toBe('# hi\n');
    expect(await runFsOp(root, { op: 'write', path: 'src/a.ts', content: 'export const a = 2;\n', expectedMtimeMs: code.mtimeMs })).not.toHaveProperty('error');
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(await runFsOp(root, { op: 'write', path: 'src/a.ts', content: 'stale', expectedMtimeMs: code.mtimeMs - 10_000 })).toMatchObject({ code: 'conflict' });
  });

  it('stays inside the session folder: no .., no absolute path, no symlink out', async () => {
    const root = tree();
    expect(await runFsOp(root, { op: 'readCode', path: '../remotea-fs-outside.txt' })).toMatchObject({ code: 'outside_root' });
    expect(await runFsOp(root, { op: 'readCode', path: '/etc/passwd' })).toMatchObject({ code: 'invalid_path' });
    expect(await runFsOp(root, { op: 'readCode', path: 'link.txt' })).toMatchObject({ code: 'outside_root' });
    expect(await runFsOp(root, { op: 'write', path: 'link.txt', content: 'x' })).toMatchObject({ code: 'outside_root' });
    expect(fs.readFileSync(path.join(os.tmpdir(), 'remotea-fs-outside.txt'), 'utf8')).toBe('secret');
    expect(await runFsOp(undefined, { op: 'list' })).toMatchObject({ code: 'no_root' });
    expect(await runFsOp(path.join(root, 'gone'), { op: 'list' })).toMatchObject({ code: 'no_root' });
  });

  it('the hub roots requests at the session\'s own directory, for live, visible sessions only', async () => {
    const root = tree();
    const seen: Array<string | undefined> = [];
    const hub = new Hub({
      registry: Registry.load({ file: null, bootId: 'b' }), spawn: fakeSpawner().spawn, bootId: 'b', serverId: 's', timers: new ManualTimers(), probe: () => ({}),
      fs: (cwd, req) => { seen.push(cwd); return runFsOp(cwd, req); },
    });
    const c = new FakeConn(1);
    hub.connect(c);
    hub.handle(c, { t: 'hello', proto: 1, device: { id: 'device-aaaaaaaa', name: 'a' }, app: { name: 't', version: '0' } });
    expect(c.json('welcome')[0].features).toContain('fs');
    hub.handle(c, { t: 'open', rid: 1, id: 'surf-fs', cols: 80, rows: 24, create: { cwd: root } });
    const msg = parseClientMsg({ t: 'fs', rid: 2, id: 'surf-fs', op: 'readCode', path: 'src/a.ts' });
    expect(msg).not.toBeNull();
    hub.handle(c, msg!);
    await waitFor(() => c.json('fsResult').length > 0);
    expect(c.json('fsResult')[0]).toMatchObject({ rid: 2, result: { content: 'export const a = 1;\n' } });
    expect(seen).toEqual([root]);
    hub.handle(c, { t: 'fs', rid: 3, id: 'surf-other', op: 'list' });
    await waitFor(() => c.json('fsResult').length > 1);
    expect(c.json('fsResult')[1].result).toMatchObject({ code: 'no_root' });
    expect(parseClientMsg({ t: 'fs', rid: 4, id: 'surf-fs', op: 'exec', path: 'x' })).toBeNull();
  });
});

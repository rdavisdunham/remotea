/**
 * `remotea move` on a host: old path-proven hook entries rewritten, a wmux
 * install's left, unproven plugin files kept unless the answer is yes, old
 * helper files removed with the reopen-terminals line, marker last.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatHostMoveResult, hostMoveMarker, REOPEN_LINE, runHostMove } from '../src/move';

const SOURCE = path.resolve(__dirname, '..', '..', 'resources', 'cli');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function host() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-move-'));
  dirs.push(home);
  const paths = { home, cliDir: path.join(home, '.local', 'share', 'remotea', 'cli'), sourceDir: SOURCE };
  fs.mkdirSync(paths.cliDir, { recursive: true });
  for (const f of ['wmux-hook.js', 'wmux.js', 'remotea-hook.js']) fs.writeFileSync(path.join(paths.cliDir, f), '// helper');
  fs.mkdirSync(path.join(home, '.claude'));
  const wmux = path.join(home, 'src', 'wmux');
  fs.mkdirSync(path.join(wmux, 'resources', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(wmux, 'package.json'), JSON.stringify({ name: 'wmux' }));
  const ours = { hooks: [{ type: 'command', command: `node "${paths.cliDir}/wmux-hook.js" --event Stop` }] };
  const theirs = { hooks: [{ type: 'command', command: `node "${wmux}/resources/cli/wmux-hook.js" --event Stop` }] };
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [ours, theirs] } }));
  return { home, paths, theirs };
}

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('runHostMove', () => {
  it('rewrites our old entries, removes the old helpers, and says to reopen terminals', async () => {
    const { home, paths, theirs } = host();
    const r = await runHostMove({ paths, env: {}, confirmRemovePlugins: () => false });
    expect(r.ok).toBe(true);
    const stop = read(path.join(home, '.claude', 'settings.json')).hooks.Stop;
    expect(stop.map((e: any) => e.hooks[0].command)).toEqual([
      theirs.hooks[0].command, `node "${path.join(paths.cliDir, 'remotea-hook.js')}" --event Stop`,
    ]);
    expect(fs.existsSync(path.join(paths.cliDir, 'wmux-hook.js'))).toBe(false);
    expect(fs.existsSync(path.join(paths.cliDir, 'wmux.js'))).toBe(false);
    expect(fs.existsSync(path.join(paths.cliDir, 'remotea-hook.js'))).toBe(true);
    expect(formatHostMoveResult(r)).toContain(REOPEN_LINE);
    expect(fs.existsSync(hostMoveMarker(paths))).toBe(true);
  });

  it('keeps unproven old plugin files on no and lists them; removes them on yes', async () => {
    const { home, paths } = host();
    const plugin = path.join(home, '.config', 'opencode', 'plugin', 'wmux.js');
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, '// plugin');
    const asked: string[][] = [];
    const no = await runHostMove({ paths, env: {}, confirmRemovePlugins: (p) => { asked.push(p); return false; } });
    expect(asked).toEqual([[plugin]]);
    expect(fs.existsSync(plugin)).toBe(true);
    expect(formatHostMoveResult(no)).toContain(plugin);
    await runHostMove({ paths, env: {}, confirmRemovePlugins: () => true });
    expect(fs.existsSync(plugin)).toBe(false);
  });

  it('says already moved on a second run and changes nothing more', async () => {
    const { paths } = host();
    await runHostMove({ paths, env: {}, confirmRemovePlugins: () => false });
    const again = await runHostMove({ paths, env: {}, confirmRemovePlugins: () => false });
    expect(again.alreadyMoved).toBe(true);
    expect(again.reopenTerminals).toBe(false);
    expect(formatHostMoveResult(again)).toContain('already moved');
  });
});

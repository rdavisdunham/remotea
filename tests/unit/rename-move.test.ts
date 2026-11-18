import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatMoveResult,
  isRemoteaExecutable,
  renameSettingsKeys,
  runDesktopMove,
  SETTINGS_BACKUP,
  type DesktopMoveDeps,
  type MoveRegistry,
} from '../../src/main/rename-move';
import { MOVE_MARKER_FILE, oldStateNeedsMove } from '../../src/main/old-state-notice';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-move-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SETTINGS = {
  'wmux-terminal-prefs': { fontSize: 15 },
  'wmux-language': 'fr',
  // Written by a launch of the renamed app before the move: the old value wins.
  'remotea-language': 'en',
  agentIntegration: { decision: 'granted' },
};

function setup() {
  const home = tmp();
  const appDataDir = tmp();
  fs.writeFileSync(path.join(appDataDir, 'settings.json'), JSON.stringify(SETTINGS));
  fs.mkdirSync(path.join(home, '.wmux', 'locales'), { recursive: true });
  fs.writeFileSync(path.join(home, '.wmux', 'config.toml'), '[terminal]\nfont-size = 15\n');
  fs.writeFileSync(path.join(home, '.wmux', 'locales', 'xx.json'), '{"a":"b"}');
  fs.mkdirSync(path.join(home, 'proj'));
  fs.writeFileSync(path.join(home, 'proj', '.wmux.json'), '{"profiles":[]}');
  return { home, appDataDir };
}

function deps(over: Partial<DesktopMoveDeps> & Pick<DesktopMoveDeps, 'home' | 'appDataDir'>): DesktopMoveDeps {
  return {
    registry: null,
    agentConfigs: () => [{ step: 'agent configs', status: 'done', detail: 'ok' }],
    oldPlugins: () => [],
    confirmRemovePlugins: () => false,
    now: () => new Date('2026-11-18T00:00:00Z'),
    ...over,
  };
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

describe('renameSettingsKeys', () => {
  it('renames every old key and lets the old value win', () => {
    const { next, renamed } = renameSettingsKeys(SETTINGS);
    expect(renamed.sort()).toEqual(['wmux-language', 'wmux-terminal-prefs']);
    expect(next).toEqual({
      'remotea-terminal-prefs': { fontSize: 15 },
      'remotea-language': 'fr',
      agentIntegration: { decision: 'granted' },
    });
  });
});

describe('runDesktopMove', () => {
  it('moves a whole install and leaves the old folder and project files', async () => {
    const { home, appDataDir } = setup();
    const r = await runDesktopMove(deps({ home, appDataDir }));
    expect(r.ok).toBe(true);
    const settings = readJson(path.join(appDataDir, 'settings.json'));
    expect(Object.keys(settings).some((k) => k.startsWith('wmux-'))).toBe(false);
    expect(settings['remotea-language']).toBe('fr');
    expect(readJson(path.join(appDataDir, SETTINGS_BACKUP))).toEqual(SETTINGS);
    expect(fs.readFileSync(path.join(home, '.remotea', 'config.toml'), 'utf-8')).toContain('font-size = 15');
    expect(fs.existsSync(path.join(home, '.remotea', 'locales', 'xx.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.wmux', 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'proj', '.wmux.json'))).toBe(true);
    expect(fs.existsSync(path.join(appDataDir, MOVE_MARKER_FILE))).toBe(true);
    // The notice is quiet now.
    expect(oldStateNeedsMove({ settings, home, appDataDir, exists: fs.existsSync })).toBe(false);
  });

  it('says it is already moved on a second run', async () => {
    const { home, appDataDir } = setup();
    await runDesktopMove(deps({ home, appDataDir }));
    const r = await runDesktopMove(deps({ home, appDataDir }));
    expect(r.alreadyMoved).toBe(true);
    expect(formatMoveResult(r)).toContain('already moved');
  });

  it('writes no marker when a copy fails, and a rerun finishes', async () => {
    const { home, appDataDir } = setup();
    const busy = (src: string, dst: string) => {
      if (src.endsWith('config.toml')) throw new Error('EBUSY: resource busy');
      fs.copyFileSync(src, dst);
    };
    const first = await runDesktopMove(deps({ home, appDataDir, copyFile: busy }));
    expect(first.ok).toBe(false);
    expect(first.steps.at(-1)).toMatchObject({ step: 'config folder', status: 'failed' });
    expect(fs.existsSync(path.join(appDataDir, MOVE_MARKER_FILE))).toBe(false);
    // Keys were not renamed yet: the file is as it was.
    expect(readJson(path.join(appDataDir, 'settings.json'))).toEqual(SETTINGS);

    const second = await runDesktopMove(deps({ home, appDataDir }));
    expect(second.ok).toBe(true);
    expect(readJson(path.join(appDataDir, SETTINGS_BACKUP))).toEqual(SETTINGS);
    expect(fs.existsSync(path.join(appDataDir, MOVE_MARKER_FILE))).toBe(true);
  });

  it('still writes the marker when one agent config fails, and reports it', async () => {
    const { home, appDataDir } = setup();
    const r = await runDesktopMove(deps({
      home, appDataDir,
      agentConfigs: () => [{ step: 'agent configs (Qwen Code)', status: 'failed', detail: 'write failed: EACCES' }],
    }));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(appDataDir, MOVE_MARKER_FILE))).toBe(true);
    expect(formatMoveResult(r)).toContain('failed  agent configs (Qwen Code)');
  });

  it('moves the right-click entry only where it runs remotea', async () => {
    const { home, appDataDir } = setup();
    const commands: Record<string, string | null> = {
      Directory: '"C:\\Users\\x\\AppData\\Local\\Programs\\remotea\\remotea.exe" "%V"',
      'Directory\\Background': '"C:\\Users\\x\\AppData\\Local\\Programs\\wmux\\wmux.exe" "%V"',
      Drive: null,
    };
    const removed: string[] = [];
    const installNew = vi.fn();
    const registry: MoveRegistry = {
      roots: Object.keys(commands),
      oldCommand: (root) => commands[root],
      removeOld: (root) => { removed.push(root); },
      installNew,
    };
    const r = await runDesktopMove(deps({ home, appDataDir, registry }));
    expect(removed).toEqual(['Directory']);
    expect(installNew).toHaveBeenCalledTimes(1);
    expect(r.steps.find((s) => s.step === 'right-click entry')?.detail).toContain('not remotea\'s');
  });

  it('keeps old plugin files when the answer is no, and lists them', async () => {
    const { home, appDataDir } = setup();
    const plugin = path.join(home, '.config', 'opencode', 'plugin', 'wmux.js');
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, '// plugin');
    const asked: string[][] = [];
    const r = await runDesktopMove(deps({
      home, appDataDir,
      oldPlugins: () => [plugin],
      confirmRemovePlugins: (paths) => { asked.push(paths); return false; },
    }));
    expect(asked).toEqual([[plugin]]);
    expect(fs.existsSync(plugin)).toBe(true);
    expect(r.steps.find((s) => s.step === 'old plugin files')?.detail).toContain(plugin);
  });

  it('removes them when the answer is yes', async () => {
    const { home, appDataDir } = setup();
    const agy = path.join(home, '.gemini', 'config', 'plugins', 'wmux');
    fs.mkdirSync(agy, { recursive: true });
    fs.writeFileSync(path.join(agy, 'wmux-agy-hook.cjs'), '');
    await runDesktopMove(deps({ home, appDataDir, oldPlugins: () => [agy], confirmRemovePlugins: () => true }));
    expect(fs.existsSync(agy)).toBe(false);
  });
});

describe('isRemoteaExecutable', () => {
  it('takes remotea.exe and a source run of a remotea checkout, never wmux.exe', () => {
    const files: Record<string, string> = {
      'C:/w/remotea/package.json': JSON.stringify({ name: 'remotea' }),
      'C:/w/wmux/package.json': JSON.stringify({ name: 'wmux' }),
    };
    const read = (p: string) => files[p] ?? null;
    expect(isRemoteaExecutable('C:\\Programs\\remotea\\remotea.exe', read)).toBe(true);
    expect(isRemoteaExecutable('C:\\w\\remotea\\node_modules\\electron\\dist\\electron.exe', read)).toBe(true);
    expect(isRemoteaExecutable('C:\\w\\wmux\\node_modules\\electron\\dist\\electron.exe', read)).toBe(false);
    expect(isRemoteaExecutable('C:\\Programs\\wmux\\wmux.exe', read)).toBe(false);
  });
});

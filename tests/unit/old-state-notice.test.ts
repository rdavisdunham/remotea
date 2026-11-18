import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MOVE_MARKER_FILE, oldProjectFileHints, oldStateNeedsMove } from '../../src/main/old-state-notice';
import { noManifestErrors } from '../../src/main/workspace-open';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'old-state-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function probe(settings: Record<string, unknown> = {}) {
  const home = tmp();
  const appDataDir = tmp();
  return { settings, home, appDataDir, exists: (p: string) => fs.existsSync(p) };
}

describe('oldStateNeedsMove', () => {
  it('is due when only ~/.wmux/config.toml exists', () => {
    const p = probe();
    fs.mkdirSync(path.join(p.home, '.wmux'));
    fs.writeFileSync(path.join(p.home, '.wmux', 'config.toml'), '[terminal]\n');
    expect(oldStateNeedsMove(p)).toBe(true);
  });

  it('is due when settings.json still has an old key', () => {
    expect(oldStateNeedsMove(probe({ 'wmux-terminal-prefs': {}, 'remotea-language': 'en' }))).toBe(true);
  });

  it('is not due on new names only', () => {
    const p = probe({ 'remotea-terminal-prefs': {}, agentIntegration: 'granted' });
    fs.mkdirSync(path.join(p.home, '.remotea'));
    expect(oldStateNeedsMove(p)).toBe(false);
  });

  it('is not due when ~/.remotea exists beside ~/.wmux (a real wmux shares the folder)', () => {
    const p = probe();
    fs.mkdirSync(path.join(p.home, '.wmux'));
    fs.mkdirSync(path.join(p.home, '.remotea'));
    expect(oldStateNeedsMove(p)).toBe(false);
  });

  it('stays quiet once the marker exists, even when ~/.wmux/config.toml appears later (AE7)', () => {
    const p = probe({ 'wmux-shortcuts': {} });
    fs.writeFileSync(path.join(p.appDataDir, MOVE_MARKER_FILE), '{}');
    fs.mkdirSync(path.join(p.home, '.wmux'));
    fs.writeFileSync(path.join(p.home, '.wmux', 'config.toml'), '[terminal]\n');
    expect(oldStateNeedsMove(p)).toBe(false);
  });
});

describe('old project file hints', () => {
  it('names each old-only project file and its new name', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.wmux.json'), 'not read');
    fs.mkdirSync(path.join(d, '.wmux'));
    fs.writeFileSync(path.join(d, '.wmux', 'workspace.json'), 'not read');
    const hints = oldProjectFileHints(d);
    expect(hints).toHaveLength(2);
    expect(hints[0]).toContain('.remotea.json');
    expect(hints[1]).toContain('.remotea/workspace.json');
  });

  it('says nothing when the new file is there too', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'wmux.workspace.json'), '{}');
    fs.writeFileSync(path.join(d, 'remotea.workspace.json'), '{}');
    expect(oldProjectFileHints(d)).toEqual([]);
  });

  it('adds the hint to the no-manifest error for a folder with only an old manifest', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'wmux.workspace.json'), '{}');
    const errors = noManifestErrors(d);
    expect(errors[0]).toContain('no workspace manifest');
    expect(errors[1]).toContain('rename it to remotea.workspace.json');
  });
});

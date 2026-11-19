import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  checkFiles,
  checkRepo,
  formatResult,
  globToRegExp,
  loadAllowlist,
  repoRoot,
  trackedFiles,
  type Allowlist,
  type TrackedFile,
} from '../name-guard';

const ROOT = repoRoot(path.resolve(__dirname, '..', '..'));

const file = (p: string, content: string | Buffer): TrackedFile => ({
  path: p,
  read: () => (typeof content === 'string' ? Buffer.from(content) : content),
});

const NONE: Allowlist = { files: [], lines: [], spans: [], keys: [] };

describe('name guard (R26)', () => {
  it('the tree says wmux only where the allowlist says why', () => {
    const result = checkRepo(ROOT);
    expect(formatResult(result)).toBe('');
  });

  it('a help string that says wmux fails and names the file and line (AE8)', () => {
    const EN = 'src/renderer/i18n/locales/en.ts';
    const files = trackedFiles(ROOT);
    const en = files.find((f) => f.path === EN)!;
    const lines = en.read().toString('utf8').split('\n');
    const at = lines.findIndex((l) => l.includes('"settings.help.') && !l.includes('settings.help.credits'));
    expect(at).toBeGreaterThan(-1);
    lines[at] = lines[at].replace(/",\s*$/, ' in wmux",');
    const edited = files.map((f) => (f.path === EN ? file(EN, lines.join('\n')) : f));

    const result = checkFiles(edited, loadAllowlist(ROOT));
    expect(result.violations).toEqual([expect.objectContaining({ path: EN, line: at + 1 })]);
    expect(formatResult(result)).toContain(`${EN}:${at + 1}: `);
  });

  it('a new file named after wmux fails by its name', () => {
    const result = checkFiles([file('src/main/wmux-x.ts', 'export {};\n')], NONE);
    expect(result.violations).toEqual([{ path: 'src/main/wmux-x.ts', text: 'src/main/wmux-x.ts' }]);
    expect(formatResult(result)).toContain('src/main/wmux-x.ts: the file name says wmux');
  });

  it('matches any case: WMUX_ variables and Wmux names', () => {
    const result = checkFiles([file('src/main/x.ts', 'const a = process.env.WMUX_FOO;\nok\nclass WmuxThing {}\n')], NONE);
    expect(result.violations.map((v) => v.line)).toEqual([1, 3]);
  });

  it('checks a binary file by its name only', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from('wmux')]);
    expect(checkFiles([file('resources/x.png', png)], NONE).violations).toEqual([]);
    expect(checkFiles([file('resources/wmux.png', png)], NONE).violations).toHaveLength(1);
  });

  it('lets the credits key say wmux in a locale file, and nowhere else', () => {
    const allow: Allowlist = { ...NONE, keys: [{ key: 'settings.help.credits', paths: 'src/renderer/i18n/locales/*.ts', reason: '' }] };
    const line = '  "settings.help.credits": "Credits — built on wmux",\n';
    expect(checkFiles([file('src/renderer/i18n/locales/fr.ts', line)], allow).violations).toEqual([]);
    expect(checkFiles([file('src/main/x.ts', line)], allow).violations).toHaveLength(1);
    expect(checkFiles([file('src/renderer/i18n/locales/fr.ts', '  "settings.help.title": "wmux",\n')], allow).violations).toHaveLength(1);
  });

  it('ignores an allowed span but not a second mention on the same line', () => {
    const allow: Allowlist = { ...NONE, spans: [{ text: 'amirlehmam/wmux', reason: '' }] };
    expect(checkFiles([file('a.ts', 'https://github.com/AmirLehmam/WMUX/issues\n')], allow).violations).toEqual([]);
    expect(checkFiles([file('a.ts', 'amirlehmam/wmux is wmux\n')], allow).violations).toHaveLength(1);
  });

  it('allows a listed line wherever it moves, and reports a line entry nothing matches', () => {
    const allow: Allowlist = {
      ...NONE,
      lines: [
        { path: 'a.ts', contains: 'a stock wmux install', reason: '' },
        { path: 'a.ts', contains: 'gone', reason: '' },
      ],
    };
    const result = checkFiles([file('a.ts', 'x\n// beside a stock wmux install\n')], allow);
    expect(result.violations).toEqual([]);
    expect(result.unusedLines).toEqual([allow.lines[1]]);
    expect(formatResult(result)).toContain('unused entry for a.ts ("gone")');
  });

  it('globs: * stays in one folder, ** crosses folders', () => {
    expect(globToRegExp('docs/upstream/**').test('docs/upstream/a/b.md')).toBe(true);
    expect(globToRegExp('docs/assets/wmux*').test('docs/assets/wmux-full.png')).toBe(true);
    expect(globToRegExp('docs/assets/wmux*').test('docs/assets/x/wmux.png')).toBe(false);
    expect(globToRegExp('docs/**/x.md').test('docs/x.md')).toBe(true);
  });
});

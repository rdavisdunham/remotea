// `--smoke` (src/main/smoke.ts): argument parsing, the output check, and the
// step runner against fakes with a virtual clock. The Electron glue is
// exercised for real by .github/workflows/smoke.yml (Windows) and by
// `npx electron . --smoke` on Linux (see docs/remotea/desktop-security.md).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOKE_TIMEOUT_MS,
  parseSmokeArgs,
  runSmoke,
  screenShowsToken,
  type RendererProbe,
  type SmokeDeps,
} from '../../src/main/smoke';

describe('parseSmokeArgs', () => {
  it('is off for a normal launch', () => {
    expect(parseSmokeArgs(['remotea.exe'], {})).toBeNull();
    expect(parseSmokeArgs(['remotea.exe', '--smokey'], {})).toBeNull();
  });

  it('reads the flag, the out file and the timeout', () => {
    expect(parseSmokeArgs(['remotea.exe', '--smoke'], {})).toEqual({ outFile: null, timeoutMs: DEFAULT_SMOKE_TIMEOUT_MS });
    expect(parseSmokeArgs(['remotea.exe', '--smoke', '--smoke-out=C:\\a b\\r.json', '--smoke-timeout=30000'], {}))
      .toEqual({ outFile: 'C:\\a b\\r.json', timeoutMs: 30000 });
  });

  it('takes the environment too, argv winning', () => {
    expect(parseSmokeArgs(['x'], { REMOTEA_SMOKE: '1', REMOTEA_SMOKE_OUT: '/tmp/r.json', REMOTEA_SMOKE_TIMEOUT_MS: '20000' }))
      .toEqual({ outFile: '/tmp/r.json', timeoutMs: 20000 });
    expect(parseSmokeArgs(['x', '--smoke-out=/a.json'], { REMOTEA_SMOKE: '1', REMOTEA_SMOKE_OUT: '/b.json' })?.outFile).toBe('/a.json');
  });

  it('clamps nonsense timeouts', () => {
    expect(parseSmokeArgs(['--smoke', '--smoke-timeout=abc'], {})?.timeoutMs).toBe(DEFAULT_SMOKE_TIMEOUT_MS);
    expect(parseSmokeArgs(['--smoke', '--smoke-timeout=-5'], {})?.timeoutMs).toBe(DEFAULT_SMOKE_TIMEOUT_MS);
    expect(parseSmokeArgs(['--smoke', '--smoke-timeout=10'], {})?.timeoutMs).toBe(5000);
    expect(parseSmokeArgs(['--smoke', '--smoke-timeout=99999999'], {})?.timeoutMs).toBe(600000);
  });
});

describe('screenShowsToken', () => {
  it('needs the output line, not the typed command', () => {
    expect(screenShowsToken('PS C:\\Users\\me> echo smoke-ok')).toBe(false);
    expect(screenShowsToken('$ echo smoke-ok\nsmoke-ok\n$ ')).toBe(true);
    expect(screenShowsToken('PS C:\\> echo smoke-ok\r\nsmoke-ok\r\nPS C:\\> ')).toBe(true);
    expect(screenShowsToken('C:\\>echo smoke-ok\nsmoke-ok   \n')).toBe(true);
    expect(screenShowsToken('smoke-oki')).toBe(false);
    expect(screenShowsToken('')).toBe(false);
    expect(screenShowsToken(null)).toBe(false);
  });
});

/** A fake app: a virtual clock, a renderer that boots, a shell that echoes. */
function fakeApp(over: Partial<{
  loadFails: string;
  bridgeAfterMs: number;
  sandboxed: boolean;
  ptyAfterMs: number | null;
  promptAfterMs: number;
  echoes: 'always' | 'second-try' | 'never';
}> = {}) {
  const o = { loadFails: '', bridgeAfterMs: 500, sandboxed: true, ptyAfterMs: 1000 as number | null, promptAfterMs: 1500, echoes: 'always' as const, ...over };
  let t = 0;
  const writes: string[] = [];
  let screen = '';
  const deps: SmokeDeps = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    waitForWindowLoad: async () => { if (o.loadFails) throw new Error(o.loadFails); t += 100; },
    probeRenderer: async (): Promise<RendererProbe> => ({
      bridge: t >= o.bridgeAfterMs,
      readScreen: t >= o.bridgeAfterMs,
      sandboxed: o.sandboxed,
      activeSurfaceId: t >= o.bridgeAfterMs ? 'surf-1' : null,
    }),
    hasPty: (id) => id === 'surf-1' && o.ptyAfterMs !== null && t >= o.ptyAfterMs,
    writePty: (_id, data) => {
      writes.push(data);
      if (o.echoes === 'always' || (o.echoes === 'second-try' && writes.length >= 2)) screen += `> ${data.trim()}\nsmoke-ok\n> `;
      else screen += `> ${data.trim()}\n`;
    },
    readScreen: async () => (t >= o.promptAfterMs ? `> ${screen}` : ''),
  };
  return { deps, writes };
}

describe('runSmoke', () => {
  it('passes through every step when the chain works', async () => {
    const { deps, writes } = fakeApp();
    const r = await runSmoke(deps, { timeoutMs: 90_000 });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => [s.name, s.ok])).toEqual([
      ['window-load', true], ['renderer-bridge', true], ['local-terminal', true], ['shell-ready', true], ['echo', true],
    ]);
    expect(r.surfaceId).toBe('surf-1');
    expect(writes).toEqual(['echo smoke-ok\r']);
    expect(r.screenTail).toContain('smoke-ok');
  });

  it('fails on a preload/load error, naming it', async () => {
    const { deps } = fakeApp({ loadFails: 'preload-error index.js: module not found: ../shared/host-info' });
    const r = await runSmoke(deps, { timeoutMs: 90_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('window-load: preload-error index.js: module not found: ../shared/host-info');
    expect(r.steps).toHaveLength(1);
  });

  it('fails when the window is not sandboxed', async () => {
    const { deps } = fakeApp({ sandboxed: false });
    const r = await runSmoke(deps, { timeoutMs: 90_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^renderer-bridge: the preload is not sandboxed/);
  });

  it('fails within its budget when no terminal ever gets a PTY, saying what it saw', async () => {
    const { deps } = fakeApp({ ptyAfterMs: null });
    const r = await runSmoke(deps, { timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^local-terminal: timed out .*active surface surf-1, pty none/);
    expect(r.durationMs).toBeLessThanOrEqual(20_000 + 250);
  });

  it('types the command a second time once, if the first was lost', async () => {
    const { deps, writes } = fakeApp({ echoes: 'second-try' });
    const r = await runSmoke(deps, { timeoutMs: 90_000 });
    expect(r.ok).toBe(true);
    expect(writes).toHaveLength(2);
    expect(r.steps.at(-1)?.detail).toBe('needed a second try');
  });

  it('fails with the screen tail when the output never comes', async () => {
    const { deps, writes } = fakeApp({ echoes: 'never' });
    const r = await runSmoke(deps, { timeoutMs: 40_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^echo: timed out waiting for "smoke-ok"/);
    expect(writes).toHaveLength(2);
    expect(r.screenTail).toContain('echo smoke-ok');
  });

  it('types anyway when no prompt shows', async () => {
    const { deps } = fakeApp({ promptAfterMs: 25_000 });
    const r = await runSmoke(deps, { timeoutMs: 90_000 });
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.name === 'shell-ready')?.detail).toBe('no prompt seen; typing anyway');
  });
});

describe('smoke wiring', () => {
  const repo = path.resolve(__dirname, '..', '..');
  it('isolates itself before anything reads the instance', () => {
    const index = fs.readFileSync(path.join(repo, 'src/main/index.ts'), 'utf8');
    const firstImport = index.split(/\r?\n/).find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './smoke-env';");
    const env = fs.readFileSync(path.join(repo, 'src/main/smoke-env.ts'), 'utf8');
    for (const v of ['WMUX_INSTANCE', 'REMOTEA_SKIP_AGENT_INTEGRATION', 'WMUX_DISABLE_UPDATER']) expect(env).toContain(v);
  });

  it('is run by the Windows smoke workflow on the unpacked build and the installer', () => {
    const wf = fs.readFileSync(path.join(repo, '.github/workflows/smoke.yml'), 'utf8');
    expect(wf).toContain('runs-on: windows-latest');
    expect(wf).toContain('release/win-unpacked/remotea.exe');
    expect(wf).toMatch(/remotea-\$ver-setup\.exe/);
    expect(wf).toContain("tags: ['v*']");
  });
});

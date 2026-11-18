/**
 * One `remotea` command (KTD11), host half: inside a remotea terminal the
 * desktop CLI's verbs and `token` go to `node $REMOTEA_CLI`; outside one the
 * host's own verbs run and desktop verbs say where they work; a call already
 * handed over is never handed on, so the two CLIs cannot loop.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hostRoute, main } from '../src/cli';
import { forwardUnknownVerb } from '../../src/cli/forward';
import { FORWARDED_ENV } from '../../src/cli/verbs';

const inside = { REMOTEA_SURFACE_ID: 'surf-1', REMOTEA_CLI: '/home/x/.local/share/remotea/cli/remotea.js' };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('hostRoute', () => {
  it('inside a terminal: bridge verbs and token go to the desktop CLI, admin verbs stay', () => {
    expect(hostRoute('identify', inside)).toBe('delegate');
    expect(hostRoute('report-agent', inside)).toBe('delegate');
    expect(hostRoute('token', inside)).toBe('delegate');
    expect(hostRoute('doctor', inside)).toBe('host');
    expect(hostRoute('open', inside)).toBe('host');
  });

  it('outside a terminal: admin verbs run, desktop verbs say where they work', () => {
    expect(hostRoute('token', {})).toBe('host');
    expect(hostRoute('status', {})).toBe('host');
    expect(hostRoute('identify', {})).toBe('outside-terminal');
    expect(hostRoute('identify', { REMOTEA_SURFACE_ID: 'surf-1' })).toBe('outside-terminal');
    expect(hostRoute(undefined, {})).toBe('host');
  });

  it('never hands on a call that was already handed over', () => {
    const forwarded = { ...inside, [FORWARDED_ENV]: '1' };
    expect(hostRoute('identify', forwarded)).toBe('unknown');
    expect(hostRoute('token', forwarded)).toBe('host');
    expect(hostRoute('frobnicate', forwarded)).toBe('unknown');
  });

  it('a verb neither CLI knows, typed in a desktop pane that finds this CLI on PATH, runs once and stops', () => {
    // The desktop forwards to the host; the host would hand a desktop verb
    // back to $REMOTEA_CLI, which would forward again. The flag stops it.
    const routes: string[] = [];
    const desktop = (args: string[], env: NodeJS.ProcessEnv): number | null => forwardUnknownVerb(args, {
      env,
      platform: 'linux',
      ownDirs: [],
      isFile: () => true,
      readHead: () => '',
      run: (_file, a, childEnv) => {
        const route = hostRoute(a[0], childEnv);
        routes.push(route);
        if (route === 'delegate') return desktop(a, childEnv) ?? 1;
        return route === 'unknown' ? 2 : 0;
      },
    });
    expect(desktop(['frobnicate'], { ...inside, PATH: '/home/x/.local/bin' })).toBe(2);
    expect(routes).toEqual(['unknown']);
  });
});

describe('main', () => {
  it('runs the desktop CLI it was given, marked as handed over', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-dispatch-'));
    dirs.push(dir);
    const out = path.join(dir, 'out.json');
    const cli = path.join(dir, 'remotea.js');
    fs.writeFileSync(cli, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), forwarded: process.env.${FORWARDED_ENV} })); process.exit(3);\n`);
    const code = await main(['identify', '--json'], { ...process.env, REMOTEA_SURFACE_ID: 'surf-1', REMOTEA_CLI: cli, REMOTEA_NODE: process.execPath });
    expect(code).toBe(3);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({ argv: ['identify', '--json'], forwarded: '1' });
  });

  it('refuses a desktop verb outside a terminal with exit 2', async () => {
    const env = { ...process.env };
    delete env.REMOTEA_SURFACE_ID;
    delete env.REMOTEA_CLI;
    expect(await main(['identify'], env)).toBe(2);
  });
});

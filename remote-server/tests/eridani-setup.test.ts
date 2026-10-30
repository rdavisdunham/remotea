/**
 * `remotea eridani setup` (task bbdb6440): idempotent, never the link key as
 * the MCP key, the MCP key file 0600, user-level MCP entries only for
 * installed harnesses and never over an existing `eridani` entry without
 * --replace, the readiness table, and no key in any output. Everything runs
 * against a temporary config dir and home with fake harness binaries.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseUpFrame } from '../../src/shared/eridani-link-protocol';
import { loadEridaniConfig, readEridaniToken } from '../src/config';
import { eridaniCommand, probeLink } from '../src/eridani-cli';
import {
  encodeSetupCode,
  findCodexEntry,
  fmtReadiness,
  normalizeLinkUrl,
  parseSetupArgs,
  parseSetupCode,
  redact,
  runSetup,
  stripJsonc,
  type SetupDeps,
} from '../src/eridani-setup';
import { loadTargets } from '../src/eridani-targets';
import type { HookPaths } from '../src/hooks-install';

const LINK_KEY = 'eri_bot_LINKlinkLINK0123456789';
const MCP_KEY = 'eri_bot_MCPmcpMCP9876543210';
const OTHER_KEY = 'eri_bot_OTHERotherOTHER555555';
const LINK_URL = 'wss://eridani.example/api/v1/external/agents/link';
const MCP_URL = 'https://eridani.example/api/v1/external/mcp/';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(prefix = 'remotea-setup-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function sink() {
  const chunks: string[] = [];
  const out = new Writable({
    write(c, _e, cb) {
      chunks.push(String(c));
      cb();
    },
  });
  return { out, text: () => chunks.join('') };
}

/** A fake `claude` that implements `mcp add|remove --scope user` on $HOME/.claude.json and logs each call (never the key). */
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const file = path.join(process.env.HOME, '.claude.json');
fs.appendFileSync(path.join(process.env.HOME, 'claude-calls.log'), a.slice(0, 2).join(' ') + '\\n');
if (a[0] === '--version') { console.log('2.0.0 (Claude Code)'); process.exit(0); }
let j = {};
try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (a[0] === 'mcp' && a[1] === 'add') {
  const name = a[6], url = a[7], header = a[9];
  const i = header.indexOf(':');
  j.mcpServers = { ...(j.mcpServers || {}), [name]: { type: 'http', url, headers: { [header.slice(0, i)]: header.slice(i + 1).trim() } } };
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
} else if (a[0] === 'mcp' && a[1] === 'remove') {
  if (!j.mcpServers || !j.mcpServers[a[4]]) { console.error('No MCP server found'); process.exit(1); }
  delete j.mcpServers[a[4]];
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
} else process.exit(2);
`;

interface World {
  root: string;
  home: string;
  dir: string;
  bin: string;
  repo: string;
  out: ReturnType<typeof sink>;
  deps: (over?: Partial<SetupDeps>) => SetupDeps;
  probes: number;
}

function world(harnesses: Array<'claude' | 'codex' | 'opencode'> = ['claude', 'codex', 'opencode']): World {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const dir = path.join(home, '.config', 'remotea');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin);
  for (const h of harnesses) {
    fs.writeFileSync(path.join(bin, h), h === 'claude' ? FAKE_CLAUDE : '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  }
  const repo = path.join(root, 'work', 'proj');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  const w: World = {
    root, home, dir, bin, repo, out: sink(), probes: 0,
    deps: (over = {}) => ({
      dir,
      home,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      out: w.out.out,
      prompt: { interactive: false, text: async (_q, d) => d ?? '', secret: async () => '', confirm: async (_q, d) => d },
      serverRunning: async () => false,
      probeLink: async () => {
        w.probes++;
        return { hostId: 'host-42', caps: ['spawn', 'verify'] };
      },
      probe: async (h) => (h === 'claude' ? { ok: true, version: '2.0.0' } : { ok: false, version: null, error: '`codex` is not on the login shell\'s PATH' }),
      hookPaths: { home, cliDir: path.join(home, '.local', 'share', 'remotea', 'cli'), sourceDir: path.resolve(__dirname, '..', '..', 'resources', 'cli') } satisfies HookPaths,
      version: '9.9.9',
      ...over,
    }),
  };
  return w;
}

const flags = (w: World, extra: string[] = []) => parseSetupArgs(['--url', LINK_URL, '--link-key', LINK_KEY, '--mcp-key', MCP_KEY, '--add-repo', w.repo, '--yes', ...extra]);

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.git') walk(p);
      } else {
        const st = fs.statSync(p);
        out[path.relative(root, p)] = `${st.mtimeMs}:${(st.mode & 0o777).toString(8)}:${fs.readFileSync(p, 'utf8')}`;
      }
    }
  };
  walk(root);
  return out;
}

const mode = (f: string) => fs.statSync(f).mode & 0o777;

describe('remotea eridani setup', () => {
  it('sets everything up, then a second run changes nothing', async () => {
    const w = world(['claude', 'codex']);
    fs.mkdirSync(path.join(w.home, '.codex'));
    const codexCfg = path.join(w.home, '.codex', 'config.toml');
    fs.writeFileSync(codexCfg, 'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n', { mode: 0o644 });

    const first = await runSetup(flags(w, ['--user-mcp']), w.deps());
    expect(first.changed.length).toBeGreaterThan(0);
    expect(w.probes).toBe(1);

    // 1. Link, the way connect writes it.
    expect(readEridaniToken(w.dir)).toBe(LINK_KEY);
    expect(mode(path.join(w.dir, 'eridani-token'))).toBe(0o600);
    expect(loadEridaniConfig(w.dir)).toMatchObject({ enabled: true, url: LINK_URL, collector: 'parity' });
    expect(first.link).toMatchObject({ hostId: 'host-42', eridaniCaps: ['spawn', 'verify'], probed: true });
    // 2. Target with launch config and a verify entry.
    expect(loadTargets(w.dir)).toEqual([expect.objectContaining({ id: 'proj', repo: w.repo, base: 'main', launch: { claude: {} }, verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 600 }] })]);
    // 3. The MCP key file, 0600, and the user-level entries of the installed harnesses only.
    const keyFile = path.join(w.dir, 'eridani-mcp-token');
    expect(fs.readFileSync(keyFile, 'utf8').trim()).toBe(MCP_KEY);
    expect(mode(keyFile)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(w.home, '.claude.json'), 'utf8')).mcpServers.eridani).toEqual({ type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_KEY}` } });
    const toml = fs.readFileSync(codexCfg, 'utf8');
    expect(toml).toBe(`model = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n\n[mcp_servers.eridani]\nurl = "${MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${MCP_KEY}" }\n`);
    expect(mode(codexCfg)).toBe(0o600);
    expect(fs.existsSync(`${codexCfg}.remotea-backup`)).toBe(true);
    expect(fs.existsSync(path.join(w.home, '.config', 'opencode'))).toBe(false);
    expect(first.skipped.join('\n')).toMatch(/opencode: not installed/);
    // The readiness table: what hello sends.
    expect(first.readiness).toEqual([expect.objectContaining({ id: 'proj', enabled: ['claude'], harnesses: ['claude'], launch: { claude: { ready: true, version: '2.0.0' } }, verify_status: [{ id: 'test', ready: true }], mcp: { configured: true } })]);
    const text = w.out.text();
    expect(text).toMatch(/TARGET\s+CHECK\s+STATUS\s+DETAIL/);
    expect(text).toMatch(/proj\s+launch claude\s+ready\s+2\.0\.0/);
    expect(text).toMatch(/proj\s+verify test\s+ready/);
    expect(text).toMatch(/proj\s+mcp\s+ready/);
    expect(text).toMatch(/Changed \(\d+\):/);
    expect(text).toMatch(/Skipped \(\d+\):/);
    // No key ever printed; the diff shows the entry redacted.
    expect(text).not.toContain(LINK_KEY);
    expect(text).not.toContain(MCP_KEY);
    expect(text).toContain('Bearer eri_bot_****');

    const before = snapshot(w.root);
    const calls = fs.readFileSync(path.join(w.home, 'claude-calls.log'), 'utf8');
    w.out = sink();
    const second = await runSetup(flags(w, ['--user-mcp']), w.deps({ out: w.out.out }));
    expect(second.changed).toEqual([]);
    expect(second.unchanged.join('\n')).toMatch(/link key[\s\S]*link settings[\s\S]*target proj[\s\S]*MCP key file[\s\S]*claude: eridani MCP entry[\s\S]*codex: eridani MCP entry/);
    expect(snapshot(w.root)).toEqual(before);
    expect(fs.readFileSync(path.join(w.home, 'claude-calls.log'), 'utf8')).toBe(calls);
    expect(w.out.text()).toMatch(/Changed \(0\): nothing/);
  });

  it('refuses the link key as the MCP key, before writing anything', async () => {
    const w = world();
    await expect(runSetup(parseSetupArgs(['--url', LINK_URL, '--link-key', LINK_KEY, '--mcp-key', LINK_KEY, '--yes']), w.deps())).rejects.toThrow(/MCP key is the link key/);
    expect(fs.existsSync(w.dir)).toBe(false);
    expect(w.probes).toBe(0);

    // An MCP key file that already holds the (new) link key is refused too.
    fs.mkdirSync(w.dir, { recursive: true });
    fs.writeFileSync(path.join(w.dir, 'eridani-mcp-token'), `${LINK_KEY}\n`, { mode: 0o600 });
    await expect(runSetup(parseSetupArgs(['--url', LINK_URL, '--link-key', LINK_KEY, '--yes']), w.deps())).rejects.toThrow(/holds the link key/);
    expect(fs.existsSync(path.join(w.dir, 'eridani-token'))).toBe(false);

    await expect(runSetup(parseSetupArgs(['--url', LINK_URL, '--link-key', LINK_KEY, '--mcp-key', 'sk-not-eridani', '--yes']), w.deps())).rejects.toThrow(/not an Eridani bot key/);
  });

  it('writes user-level entries only for installed harnesses, and only when asked', async () => {
    const w = world([]);
    const r = await runSetup(flags(w, ['--user-mcp']), w.deps());
    expect(r.skipped.filter((s) => /^(claude|codex|opencode): not installed \(/.test(s))).toHaveLength(3);
    expect(fs.existsSync(path.join(w.home, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(w.home, '.codex'))).toBe(false);
    expect(fs.existsSync(path.join(w.home, '.config', 'opencode'))).toBe(false);

    const v = world(['claude', 'codex', 'opencode']);
    const s = await runSetup(flags(v), v.deps());
    expect(s.skipped.filter((x) => /not written \(pass --user-mcp/.test(x))).toHaveLength(3);
    expect(fs.existsSync(path.join(v.home, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(v.home, '.codex', 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(v.home, '.config', 'opencode', 'opencode.json'))).toBe(false);
    // The diff was shown even so.
    expect(v.out.text()).toMatch(/\+\+\+ .*\.codex\/config\.toml {2}\[mcp_servers\.eridani\]/);

    // Asked: OpenCode's global config gets a remote entry, the rest of it kept.
    const oc = path.join(v.home, '.config', 'opencode');
    fs.mkdirSync(oc, { recursive: true });
    fs.writeFileSync(path.join(oc, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { x: {} } }, null, 2));
    await runSetup(flags(v, ['--user-mcp']), v.deps());
    expect(JSON.parse(fs.readFileSync(path.join(oc, 'opencode.json'), 'utf8'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      provider: { x: {} },
      mcp: { eridani: { type: 'remote', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_KEY}` }, enabled: true } },
    });
    expect(mode(path.join(oc, 'opencode.json'))).toBe(0o600);
  });

  it('never overwrites an existing eridani entry without --replace', async () => {
    const w = world(['claude', 'codex', 'opencode']);
    const claudeJson = path.join(w.home, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { eridani: { type: 'http', url: 'https://old.example/api/v1/external/mcp/', headers: { Authorization: `Bearer ${OTHER_KEY}` } }, keep: { type: 'stdio', command: 'x' } } }, null, 2));
    fs.mkdirSync(path.join(w.home, '.codex'));
    const codexCfg = path.join(w.home, '.codex', 'config.toml');
    const toml = `model = "o3"\n\n[mcp_servers.eridani]\nurl = "https://old.example/api/v1/external/mcp/"\nbearer_token_env_var = "MINE"\n\n[mcp_servers.eridani.tools]\nfoo = 1\n\n[profiles.fast]\nmodel = "o4-mini"\n`;
    fs.writeFileSync(codexCfg, toml);
    const oc = path.join(w.home, '.config', 'opencode');
    fs.mkdirSync(oc, { recursive: true });
    const ocJson = JSON.stringify({ mcp: { eridani: { type: 'remote', url: MCP_URL, headers: { Authorization: `Bearer ${OTHER_KEY}` } }, other: { type: 'local' } } }, null, 2);
    fs.writeFileSync(path.join(oc, 'opencode.json'), ocJson);
    const before = { claude: fs.readFileSync(claudeJson, 'utf8'), codex: toml, opencode: ocJson };

    const r = await runSetup(flags(w, ['--user-mcp']), w.deps());
    expect(r.skipped.filter((s) => /not overwritten without --replace/.test(s)).map((s) => s.split(':')[0]).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(fs.readFileSync(claudeJson, 'utf8')).toBe(before.claude);
    expect(fs.readFileSync(codexCfg, 'utf8')).toBe(before.codex);
    expect(fs.readFileSync(path.join(oc, 'opencode.json'), 'utf8')).toBe(before.opencode);
    expect(fs.existsSync(path.join(w.home, 'claude-calls.log'))).toBe(false);
    expect(w.out.text()).not.toContain(OTHER_KEY);

    w.out = sink();
    const rr = await runSetup(flags(w, ['--user-mcp', '--replace']), w.deps({ out: w.out.out }));
    expect(rr.changed.filter((c) => /^(claude|codex|opencode):/.test(c))).toHaveLength(3);
    const cj = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(cj.mcpServers).toEqual({ keep: { type: 'stdio', command: 'x' }, eridani: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_KEY}` } } });
    expect(cj.numStartups).toBe(3);
    expect(fs.readFileSync(path.join(w.home, 'claude-calls.log'), 'utf8')).toBe('mcp remove\nmcp add\n');
    // Replaced in place, its subtable with it; everything else as it was.
    expect(fs.readFileSync(codexCfg, 'utf8')).toBe(`model = "o3"\n\n[mcp_servers.eridani]\nurl = "${MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${MCP_KEY}" }\n\n[profiles.fast]\nmodel = "o4-mini"\n`);
    expect(JSON.parse(fs.readFileSync(path.join(oc, 'opencode.json'), 'utf8')).mcp.other).toEqual({ type: 'local' });
    const text = w.out.text();
    expect(text).toMatch(/-\s+"url": "https:\/\/old\.example/);
    expect(text).toMatch(/- bearer_token_env_var = "MINE"/);
    expect(text).not.toContain(OTHER_KEY);
    expect(text).not.toContain(MCP_KEY);

    // And now it is idempotent again.
    const again = await runSetup(flags(w, ['--user-mcp', '--replace']), w.deps({ out: sink().out }));
    expect(again.changed).toEqual([]);
  });

  it('reports the hooks and installs them only with --hooks', async () => {
    const w = world([]);
    fs.mkdirSync(path.join(w.home, '.claude'));
    const settings = path.join(w.home, '.claude', 'settings.json');
    fs.writeFileSync(settings, '{"theme":"dark"}\n');
    const r = await runSetup(flags(w), w.deps());
    expect(r.hooks.current).toBe(false);
    expect(r.skipped.join('\n')).toMatch(/hooks not installed: run `remotea hooks install`/);
    expect(w.out.text()).toMatch(/run: remotea hooks install/);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"theme":"dark"}\n');

    const h = await runSetup(flags(w, ['--hooks']), w.deps({ out: sink().out }));
    expect(h.changed.join('\n')).toMatch(/hooks installed/);
    expect(fs.readFileSync(settings, 'utf8')).toMatch(/wmux-hook/);
    const again = await runSetup(flags(w, ['--hooks']), w.deps({ out: sink().out }));
    expect(again.changed).toEqual([]);
    expect(again.hooks.current).toBe(true);
  });

  it('takes the keys from a setup code or stdin, never from output', async () => {
    const w = world([]);
    const code = encodeSetupCode({ url: 'https://eridani.example', link_key: LINK_KEY, mcp_key: MCP_KEY, machine: 'DavisPC' });
    expect(parseSetupCode(`remotea eridani setup --code ${code}`)).toEqual({ url: 'https://eridani.example', link_key: LINK_KEY, mcp_key: MCP_KEY, machine: 'DavisPC' });
    await runSetup(parseSetupArgs(['--code', '-', '--yes']), w.deps({ stdinLines: async () => [code] }));
    expect(loadEridaniConfig(w.dir)).toMatchObject({ url: LINK_URL, machine: 'DavisPC', enabled: true });
    expect(fs.readFileSync(path.join(w.dir, 'eridani-mcp-token'), 'utf8').trim()).toBe(MCP_KEY);

    const v = world([]);
    await runSetup(parseSetupArgs(['--url', LINK_URL, '--link-key', '-', '--mcp-key', '-', '--yes', '--json']), v.deps({ stdinLines: async () => [LINK_KEY, MCP_KEY] }));
    expect(readEridaniToken(v.dir)).toBe(LINK_KEY);
    const report = JSON.parse(v.out.text());
    expect(report.changed.length).toBeGreaterThan(0);
    expect(v.out.text()).not.toContain(LINK_KEY);
    expect(v.out.text()).not.toContain(MCP_KEY);

    expect(() => parseSetupCode('eridani-setup:1:!!!')).toThrow(/damaged|not an Eridani setup code/);
  });

  it('interactive: asks for the setup code, offers each candidate repository, confirms each write', async () => {
    const w = world(['codex']);
    const code = encodeSetupCode({ url: 'https://eridani.example', link_key: LINK_KEY, mcp_key: MCP_KEY });
    const asked: string[] = [];
    const answers: Record<string, string> = { id: 'myproj', 'verify command (Enter for none)': 'npm run check' };
    const prompt = {
      interactive: true,
      text: async (q: string, d?: string) => {
        asked.push(q);
        return answers[q.trim()] ?? d ?? '';
      },
      secret: async (q: string) => {
        asked.push(q);
        return /Setup code/.test(q) ? code : '';
      },
      confirm: async (q: string) => {
        asked.push(q);
        return true;
      },
    };
    const r = await runSetup(parseSetupArgs(['--scan', path.join(w.root, 'work')]), w.deps({ prompt }));
    expect(asked[0]).toMatch(/Setup code from Eridani/);
    expect(asked.some((q) => /Add .*proj as an execution target/.test(q))).toBe(true);
    expect(asked.some((q) => /Write it to .*config\.toml/.test(q))).toBe(true);
    expect(loadTargets(w.dir)).toEqual([expect.objectContaining({ id: 'myproj', repo: w.repo, verify: [{ id: 'test', argv: ['npm', 'run', 'check'], timeout: 600 }] })]);
    expect(fs.readFileSync(path.join(w.home, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.eridani]');
    expect(r.changed.length).toBeGreaterThan(3);
    if (process.env.SHOW_SETUP_OUTPUT) fs.writeFileSync(process.env.SHOW_SETUP_OUTPUT, w.out.text());
  });

  it('dry run: shows what would change and writes nothing', async () => {
    const w = world(['claude']);
    const before = snapshot(w.root);
    const r = await runSetup(flags(w, ['--user-mcp', '--dry-run']), w.deps());
    expect(r.changed.every((c) => c.startsWith('(dry run) would change:'))).toBe(true);
    expect(r.changed.length).toBeGreaterThan(3);
    expect(snapshot(w.root)).toEqual(before);
    expect(r.readiness[0]).toMatchObject({ id: 'proj', mcp: { configured: true } });
  });

  it('keeps the current keys when none are given, and lists candidate repositories', async () => {
    const w = world([]);
    await runSetup(flags(w), w.deps());
    fs.mkdirSync(path.join(w.root, 'work', 'other'));
    execFileSync('git', ['init', '-q', path.join(w.root, 'work', 'other')]);
    const r = await runSetup(parseSetupArgs(['--yes', '--no-probe']), w.deps({ out: sink().out }));
    expect(r.changed).toEqual([]);
    expect(r.skipped.join('\n')).toMatch(new RegExp(`candidate repository ${path.join(w.root, 'work', 'other')}`));
    expect(r.unchanged.join('\n')).toMatch(/link key/);
  });

  it('proves the key with a real hello → welcome and prints the host and caps', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => new Promise((r) => wss.close(() => r(undefined))));
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws: WebSocket) => ws.on('message', (data) => {
      const f = parseUpFrame(JSON.parse(String(data)));
      if (f?.t === 'hello') ws.send(JSON.stringify({ v: 1, id: 'e-1', conn_epoch: 7, at: Date.now(), t: 'welcome', host_id: 'host-real', server_time: Date.now(), caps: ['spawn', 'prompt'], probe: true }));
    }));
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/api/v1/external/agents/link`;
    const w = world([]);
    const r = await runSetup(parseSetupArgs(['--url', url, '--link-key', LINK_KEY, '--yes']), w.deps({ probeLink: (u, k, h) => probeLink(u, k, h) }));
    expect(r.link).toMatchObject({ hostId: 'host-real', eridaniCaps: ['spawn', 'prompt'] });
    expect(w.out.text()).toMatch(/Eridani accepted the key: host host-real/);
    expect(w.out.text()).toMatch(/Eridani caps: spawn, prompt/);
  });

  it('status prints the MCP wiring per harness and the readiness per target', async () => {
    const w = world(['claude', 'codex']);
    await runSetup(flags(w, ['--user-mcp']), w.deps());
    vi.stubEnv('HOME', w.home);
    vi.stubEnv('PATH', `${w.bin}:/usr/bin:/bin`);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('CODEX_HOME', '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const s = sink();
    expect(await eridaniCommand(w.dir, ['status'], async () => false, s.out)).toBe(0);
    const text = s.text();
    expect(text).toMatch(/MCP for coding agents:/);
    expect(text).toMatch(/spawn\s+ready/);
    expect(text).toMatch(/claude\s+ready\s+eridani entry in .*\.claude\.json/);
    expect(text).toMatch(/codex\s+ready/);
    expect(text).toMatch(/opencode\s+not installed/);
    expect(text).toMatch(/proj\s+launch claude\s+not probed/);
    expect(text).toMatch(/proj\s+verify test\s+ready/);
    expect(text).toMatch(/proj\s+mcp\s+ready/);
    expect(text).not.toContain(MCP_KEY);
    const j = JSON.parse((await (async () => { const o = sink(); await eridaniCommand(w.dir, ['status', '--json'], async () => false, o.out); return o.text(); })()));
    expect(j.mcpWiring.map((x: { harness: string; state: string }) => `${x.harness}:${x.state}`)).toEqual(['spawn:ready', 'claude:ready', 'codex:ready', 'opencode:not installed']);
    expect(j.readiness[0]).toMatchObject({ id: 'proj', mcp: { configured: true } });
  });
});

describe('setup helpers', () => {
  it('normalizes an Eridani origin to the link URL', () => {
    expect(normalizeLinkUrl('https://eridani.example')).toBe(LINK_URL);
    expect(normalizeLinkUrl('https://eridani.example/')).toBe(LINK_URL);
    expect(normalizeLinkUrl(LINK_URL)).toBe(LINK_URL);
    expect(normalizeLinkUrl('http://localhost:8000')).toBe('ws://localhost:8000/api/v1/external/agents/link');
  });

  it('finds the eridani entry in config.toml in every form', () => {
    expect(findCodexEntry('model = "x"\n')).toBeNull();
    expect(findCodexEntry('[mcp_servers.eridani]\nurl = "u"\n\n[x]\n')).toEqual({ kind: 'table', start: 0, end: 2 });
    expect(findCodexEntry('[mcp_servers."eridani"]\nurl = "u"\n[mcp_servers.eridani.env]\nA = "1"\n')).toEqual({ kind: 'table', start: 0, end: 4 });
    expect(findCodexEntry('mcp_servers.eridani.url = "u"\n')).toEqual({ kind: 'other' });
    expect(findCodexEntry('[mcp_servers]\neridani = { url = "u" }\n')).toEqual({ kind: 'other' });
    expect(findCodexEntry('[mcp_servers.eridani.tools]\nx = 1\n')).toEqual({ kind: 'other' });
    expect(findCodexEntry('[mcp_servers.eridanix]\nurl = "u"\n')).toBeNull();
  });

  it('redacts keys and strips JSONC', () => {
    expect(redact(`Authorization: Bearer ${MCP_KEY}`)).toBe('Authorization: Bearer eri_bot_****');
    expect(redact('"Authorization": "Bearer abc.def"')).toBe('"Authorization": "Bearer ****"');
    expect(JSON.parse(stripJsonc('{ // c\n "a": "x//y", /* b */ "b": [1,],\n}'))).toEqual({ a: 'x//y', b: [1] });
  });

  it('formats the readiness table from hello targets', () => {
    const lines = fmtReadiness([{ id: 't', repo: '/r', harnesses: [], enabled: ['codex'], launch: { codex: { ready: false, version: null, error: 'not on PATH' } }, verify: [], verify_status: [], mcp: { configured: false, reason: 'no MCP key file at /k' } }]);
    expect(lines[0]).toMatch(/^TARGET\s+CHECK\s+STATUS\s+DETAIL$/);
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^t\s+launch codex\s+NOT READY\s+not on PATH$/),
      expect.stringMatching(/^t\s+verify\s+none\s+no verify entry/),
      expect.stringMatching(/^t\s+mcp\s+NOT READY\s+no MCP key file at \/k$/),
    ]);
  });

  it('refuses contradicting or unknown flags', () => {
    expect(() => parseSetupArgs(['--user-mcp', '--no-user-mcp'])).toThrow(/contradict/);
    expect(() => parseSetupArgs(['--frobnicate'])).toThrow(/unknown setup option/);
    expect(() => parseSetupArgs(['--link-key'])).toThrow(/needs a value/);
    expect(parseSetupArgs(['--link-key', '-']).linkKey).toBe('-');
  });
});

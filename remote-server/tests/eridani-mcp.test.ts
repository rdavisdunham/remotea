/**
 * Task 3bc2803c: a spawned agent gets Eridani's MCP server (submit_plan,
 * submit_plan_review, task_step, task_interview, session_link), with the key read from its own
 * file, never the link key, and never in argv, logs, the runs file, the
 * registry, the journal, the outbox or the status file. A missing key file
 * spawns without it and says so (`mcp.configured=false` with a reason).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseUpFrame, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { saveEridaniConfig, writeEridaniFile, readEridaniFile, writeEridaniToken } from '../src/config';
import { ContextService } from '../src/context';
import { Dispatch, launchCommand, resumeLine, RUNS_FILE, surfFor } from '../src/dispatch';
import { EridaniLink, JOURNAL_FILE, OUTBOX_FILE, STATUS_FILE, digestOf } from '../src/eridani-link';
import { ERIDANI_MCP_DIR, ERIDANI_MCP_KEY_FILE, MCP_TOKEN_ENV, codexMcpArgs, mcpUrlFromLink, resolveMcp } from '../src/eridani-mcp';
import { EridaniRuntime } from '../src/eridani-runtime';
import { targetError, type ExecutionTarget } from '../src/eridani-targets';
import { Hub } from '../src/hub';
import { QuestionBroker } from '../src/questions-claude';
import { Registry } from '../src/registry';
import type { CommandBody } from '../../src/shared/eridani-link-protocol';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { WorktreeManager } from '../src/worktrees';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eridani-mcp-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const LINK_KEY = 'eri_bot_LINKlinkLINKlink0001';
const MCP_KEY = 'eri_bot_MCPmcpMCPmcpMCPmcp0002';
const LINK_URL = 'wss://eri.example/api/v1/external/agents/link';
const MCP_URL = 'https://eri.example/api/v1/external/mcp/';

const TARGET: ExecutionTarget = {
  id: 'proj',
  repo: '/repo',
  worktreeRoot: '/wt',
  base: 'main',
  launch: { claude: {}, codex: { bin: '/opt/codex' } },
  verify: [],
};

/** A config dir as the server has it: eridani.json, the link key, and (unless told not to) the MCP key. */
function configDir(o: { mcpKey?: string | null; url?: string } = {}): string {
  const dir = tmpDir();
  saveEridaniConfig(dir, { enabled: true, url: o.url ?? LINK_URL, collector: 'parity' });
  writeEridaniToken(dir, LINK_KEY);
  if (o.mcpKey !== null) fs.writeFileSync(path.join(dir, ERIDANI_MCP_KEY_FILE), `${o.mcpKey ?? MCP_KEY}\n`, { mode: 0o600 });
  return dir;
}

/** Every file under `dir`, except the MCP key file and the per-run MCP configs (the only places the key belongs). */
function filesOutsideMcp(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === ERIDANI_MCP_KEY_FILE || name === ERIDANI_MCP_DIR) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out.push(p);
  }
  return out;
}

function setup(dir: string, o: { registryFile?: string; bootId?: string; mcp?: boolean } = {}) {
  const registry = Registry.load({ file: o.registryFile ?? path.join(dir, 'registry.json'), bootId: o.bootId ?? 'boot-1' });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId: o.bootId ?? 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const logs: string[] = [];
  const dispatch = new Dispatch({
    hub,
    registry,
    dir,
    worktrees: { ensure: async (t: ExecutionTarget, branch: string, base: string) => ({ path: `${t.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc123', created: true }) } as unknown as WorktreeManager,
    targets: () => [TARGET],
    // As the runtime wires it.
    ...(o.mcp === false ? {} : { mcp: (t: ExecutionTarget) => resolveMcp(dir, t) }),
    questions: new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} }),
    emit: () => {},
    linkReady: () => true,
    log: (m) => logs.push(m),
  });
  hub.setEridani(dispatch.hubHooks());
  const run = async (cmd: Record<string, unknown>): Promise<CommandResult> => {
    const pre = dispatch.precheck(cmd as CommandBody);
    if (pre) return { state: 'rejected', detail: pre };
    const ctx: CommandContext = { begin: () => {} };
    return dispatch.handlers()[cmd.t as string](cmd as CommandBody, ctx);
  };
  return { registry, hub, sp, dispatch, run, logs };
}

const spawnCmd = (over: Record<string, unknown> = {}) => ({
  t: 'spawn',
  op_id: 'op-spawn-1',
  digest: 'd',
  run_id: 'run-1',
  generation: 1,
  attempt: 1,
  harness: 'claude',
  model: 'sonnet',
  target: { id: 'proj', branch: 'eri/task-1' },
  task_id: 'task-1',
  prompt: 'Plan the change.',
  run_token: 'tok-123',
  expires_at: Date.now() + 60_000,
  ...over,
});

const surf = surfFor('run-1', 1, 1);

// ── Settings ────────────────────────────────────────────────────────────────

describe('eridani-mcp: where the server is and which key', () => {
  it('derives the MCP URL (with its trailing slash) from the link URL; cleartext only to this machine', () => {
    expect(mcpUrlFromLink(LINK_URL)).toBe(MCP_URL);
    expect(mcpUrlFromLink('wss://eri.example:8443/api/v1/external/agents/link')).toBe('https://eri.example:8443/api/v1/external/mcp/');
    expect(mcpUrlFromLink('ws://127.0.0.1:9000/link')).toBe('http://127.0.0.1:9000/api/v1/external/mcp/');
    expect(mcpUrlFromLink('ws://eri.example/link')).toBeNull();
    expect(mcpUrlFromLink('nonsense')).toBeNull();
  });

  it('reads the key from the default key file in the config dir, never the link key file', () => {
    const dir = configDir();
    expect(resolveMcp(dir, TARGET)).toEqual({ configured: true, url: MCP_URL, key: MCP_KEY });
  });

  it('no key file: not configured, and says where it looked', () => {
    const dir = configDir({ mcpKey: null });
    const r = resolveMcp(dir, TARGET);
    expect(r).toEqual({ configured: false, reason: `no MCP key file at ${path.join(dir, ERIDANI_MCP_KEY_FILE)}` });
  });

  it('a key file holding the link key, or not a bot key, is refused', () => {
    expect(resolveMcp(configDir({ mcpKey: LINK_KEY }), TARGET)).toMatchObject({ configured: false, reason: expect.stringMatching(/holds the link key/) });
    const bad = resolveMcp(configDir({ mcpKey: 'hunter2' }), TARGET);
    expect(bad).toMatchObject({ configured: false, reason: expect.stringMatching(/does not hold an Eridani bot key/) });
    expect(JSON.stringify(bad)).not.toContain('hunter2');
  });

  it('mcpKeyFile (global, then per target) and mcpUrl in eridani.json', () => {
    const dir = configDir({ mcpKey: null });
    const other = path.join(tmpDir(), 'k');
    fs.writeFileSync(other, MCP_KEY);
    writeEridaniFile(dir, { ...readEridaniFile(dir), mcpKeyFile: other });
    expect(resolveMcp(dir, TARGET)).toMatchObject({ configured: true, key: MCP_KEY });
    // A target's own file wins.
    expect(resolveMcp(dir, { ...TARGET, mcpKeyFile: 'missing-file' })).toEqual({ configured: false, reason: `no MCP key file at ${path.join(dir, 'missing-file')}` });
    writeEridaniFile(dir, { ...readEridaniFile(dir), mcpUrl: 'https://mcp.example/api/v1/external/mcp' });
    expect(resolveMcp(dir, TARGET)).toMatchObject({ configured: true, url: 'https://mcp.example/api/v1/external/mcp/' });
    writeEridaniFile(dir, { ...readEridaniFile(dir), mcpUrl: 'http://mcp.example/api/v1/external/mcp/' });
    expect(resolveMcp(dir, TARGET)).toMatchObject({ configured: false, reason: expect.stringMatching(/https/) });
  });

  it('a target validates mcpKeyFile as a one-line path', () => {
    expect(targetError({ ...TARGET, mcpKeyFile: '~/.config/remotea/eridani-mcp-token' })).toBeNull();
    expect(targetError({ ...TARGET, mcpKeyFile: 'a\nb' })).toMatch(/mcpKeyFile/);
    expect(targetError({ ...TARGET, mcpKeyFile: 7 })).toMatch(/mcpKeyFile/);
  });

  it('launch and resume lines put the MCP arguments before any other option (never before the prompt)', () => {
    expect(launchCommand('claude', 'sonnet', {}, true, ['--mcp-config', '/c/x.json'])).toBe(`'claude' '--mcp-config' '/c/x.json' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(launchCommand('codex', 'gpt-5', {}, true, codexMcpArgs(MCP_URL))).toBe(
      `'codex' '-c' 'mcp_servers.eridani.url="${MCP_URL}"' '-c' 'mcp_servers.eridani.bearer_token_env_var="${MCP_TOKEN_ENV}"' --disable daemon_auto_start -m 'gpt-5' "$ERIDANI_PROMPT"`,
    );
    const b = { harness: 'claude', model: 'sonnet' } as Parameters<typeof resumeLine>[0];
    expect(resumeLine(b, undefined, 's-1', ['--mcp-config', '/c/x.json'])).toBe(`'claude' --resume 's-1' '--mcp-config' '/c/x.json' --model 'sonnet' --permission-mode auto`);
    expect(resumeLine({ ...b, harness: 'codex' }, undefined, 's-1', ['-c', 'k=v'])).toBe(`'codex' resume '-c' 'k=v' --disable daemon_auto_start -m 'sonnet' 's-1'`);
  });
});

// ── Spawn ───────────────────────────────────────────────────────────────────

describe('dispatch: spawn with Eridani MCP', () => {
  it('claude gets --mcp-config with a private file naming the Eridani URL and the MCP key (not the link key)', async () => {
    const dir = configDir();
    const { run, sp, logs, registry } = setup(dir);
    const res = await run(spawnCmd());
    expect(res).toMatchObject({ state: 'executed', result: { surf, mcp: { configured: true } } });
    const cfgFile = path.join(dir, ERIDANI_MCP_DIR, `${surf}.json`);
    const req = sp.last().req;
    expect(req.cmd).toBe(`'claude' '--mcp-config' '${cfgFile}' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    // Outside the worktree (never committed), and only its owner can read it.
    expect(cfgFile.startsWith(req.cwd!)).toBe(false);
    expect(fs.statSync(cfgFile).mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    expect(cfg).toEqual({ mcpServers: { eridani: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_KEY}` } } } });
    expect(fs.readFileSync(cfgFile, 'utf8')).not.toContain(LINK_KEY);
    // The key is in no argv, env, log, result, record or other file.
    expect(req.cmd).not.toContain(MCP_KEY);
    expect(JSON.stringify(req.env)).not.toContain(MCP_KEY);
    expect(JSON.stringify(res)).not.toContain(MCP_KEY);
    expect(logs.join('\n')).not.toContain(MCP_KEY);
    expect(logs.join('\n')).toMatch(/Eridani MCP configured/);
    expect(registry.session(surf)!.eridani!.mcp).toEqual({ configured: true });
    registry.saveNow();
    for (const f of filesOutsideMcp(dir)) expect(fs.readFileSync(f, 'utf8'), f).not.toContain(MCP_KEY);
    expect(filesOutsideMcp(dir).map((f) => path.basename(f))).toEqual(expect.arrayContaining([RUNS_FILE, 'registry.json']));
  });

  it('no key file: spawns without MCP and reports mcp.configured=false with the reason', async () => {
    const dir = configDir({ mcpKey: null });
    const { run, sp, logs } = setup(dir);
    const res = await run(spawnCmd());
    const reason = `no MCP key file at ${path.join(dir, ERIDANI_MCP_KEY_FILE)}`;
    expect(res).toMatchObject({ state: 'executed', result: { surf, mcp: { configured: false, reason } } });
    expect(sp.last().req.cmd).toBe(`'claude' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(fs.existsSync(path.join(dir, ERIDANI_MCP_DIR, `${surf}.json`))).toBe(false);
    expect(logs.join('\n')).toContain(`Eridani MCP not configured: ${reason}`);
    // Never falls back to the link key.
    expect(sp.last().req.cmd).not.toContain(LINK_KEY);
  });

  it('codex gets -c overrides and the key only in its environment for that launch (not in the runs file)', async () => {
    const dir = configDir();
    const { run, sp } = setup(dir);
    const res = await run(spawnCmd({ harness: 'codex', model: 'gpt-5' }));
    expect(res).toMatchObject({ state: 'executed', result: { mcp: { configured: true } } });
    const req = sp.last().req;
    expect(req.cmd).toBe(`'/opt/codex' '-c' 'mcp_servers.eridani.url="${MCP_URL}"' '-c' 'mcp_servers.eridani.bearer_token_env_var="${MCP_TOKEN_ENV}"' --disable daemon_auto_start -m 'gpt-5' "$ERIDANI_PROMPT"`);
    expect(req.cmd).not.toContain(MCP_KEY);
    expect(req.env).toMatchObject({ [MCP_TOKEN_ENV]: MCP_KEY, ERIDANI_RUN_TOKEN: 'tok-123' });
    expect(fs.readFileSync(path.join(dir, RUNS_FILE), 'utf8')).not.toContain(MCP_KEY);
    expect(fs.existsSync(path.join(dir, ERIDANI_MCP_DIR, `${surf}.json`))).toBe(false);
  });

  it('without the mcp dependency nothing changes (no field, no flag)', async () => {
    const dir = configDir();
    const { run, sp } = setup(dir, { mcp: false });
    const res = await run(spawnCmd());
    expect((res.result as Record<string, unknown>).mcp).toBeUndefined();
    expect(sp.last().req.cmd).not.toContain('--mcp-config');
  });

  it('a resumed run gets a fresh config (the key is re-read); without a key it resumes without MCP', async () => {
    const dir = configDir();
    const file = path.join(dir, 'registry.json');
    const first = setup(dir, { registryFile: file });
    await first.run(spawnCmd());
    first.registry.updateSession(surf, { agent: { provider: 'claude', sessionId: 'sess-abc', seenAt: 1 } });
    first.registry.saveNow();
    const cfgFile = path.join(dir, ERIDANI_MCP_DIR, `${surf}.json`);

    fs.rmSync(cfgFile);
    const second = setup(dir, { registryFile: file, bootId: 'boot-2' });
    second.dispatch.resumeOnBoot();
    expect(second.sp.last().req.cmd).toBe(`'claude' --resume 'sess-abc' '--mcp-config' '${cfgFile}' --model 'sonnet' --permission-mode auto`);
    expect(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers.eridani.headers.Authorization).toBe(`Bearer ${MCP_KEY}`);

    second.registry.saveNow();
    fs.rmSync(path.join(dir, ERIDANI_MCP_KEY_FILE));
    const third = setup(dir, { registryFile: file, bootId: 'boot-3' });
    third.dispatch.resumeOnBoot();
    expect(third.sp.last().req.cmd).toBe(`'claude' --resume 'sess-abc' --model 'sonnet' --permission-mode auto`);
    expect(fs.existsSync(cfgFile)).toBe(false);
    expect(third.logs.join('\n')).toMatch(/without Eridani MCP: no MCP key file/);
  });
});

// ── Upstream: command.outcome, journal, outbox, status file; hello ─────────

class FakeEridani {
  readonly wss = new WebSocketServer({ port: 0 });
  readonly frames: Array<UpFrame & Record<string, unknown>> = [];
  sockets: WebSocket[] = [];
  epoch = 0;
  constructor() {
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const f = parseUpFrame(JSON.parse(String(data)));
        if (!f) throw new Error(`bad frame ${String(data)}`);
        this.frames.push(f as UpFrame & Record<string, unknown>);
        if (f.t === 'hello') this.send(ws, { t: 'welcome', host_id: 'host-1', conn_epoch: ++this.epoch, server_time: Date.now() });
        else if ('op_id' in f && f.t !== 'ack') this.send(ws, { t: 'ack', acked_id: f.id, ok: true });
      });
    });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}/link`;
  }
  send(ws: WebSocket, body: Record<string, unknown>): void {
    ws.send(JSON.stringify({ v: 1, id: `e-${Math.random()}`, conn_epoch: this.epoch, at: Date.now(), ...body }));
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

describe('Eridani link: readiness upstream, the key nowhere', () => {
  it('command.outcome carries result.mcp; the journal, outbox and status file never hold the key', async () => {
    const eri = new FakeEridani();
    cleanups.push(() => eri.close());
    await new Promise((r) => eri.wss.once('listening', r));
    const dir = configDir();
    const { dispatch, sp } = setup(dir);
    const logs: string[] = [];
    const link = new EridaniLink({
      url: eri.url,
      token: () => LINK_KEY,
      dir,
      serverId: 'srv-1',
      bootId: 'boot-1',
      hostname: 'box',
      machine: 'box',
      version: '9.9.9',
      snapshot: () => [],
      rand: () => 0.5,
      log: (m) => logs.push(m),
      handlers: dispatch.handlers(),
      precheck: (c) => dispatch.precheck(c),
      acceptFacts: (c) => dispatch.acceptFacts(c),
    });
    cleanups.push(() => link.stop());
    link.start();
    await until(() => link.ready);
    const body = spawnCmd();
    delete (body as Record<string, unknown>).digest;
    eri.send(eri.sockets.at(-1)!, { ...body, digest: digestOf(body) });
    await until(() => eri.frames.some((f) => f.t === 'command.outcome'));
    const outcome = eri.frames.find((f) => f.t === 'command.outcome')!;
    expect(outcome).toMatchObject({ command_id: 'op-spawn-1', state: 'executed', result: { surf, mcp: { configured: true } } });
    expect(sp.last().req.cmd).toContain('--mcp-config');
    link.writeStatusNow();
    for (const f of [JOURNAL_FILE, OUTBOX_FILE, STATUS_FILE]) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    for (const f of filesOutsideMcp(dir)) expect(fs.readFileSync(f, 'utf8'), f).not.toContain(MCP_KEY);
    expect(eri.frames.map((f) => JSON.stringify(f)).join('\n')).not.toContain(MCP_KEY);
    expect(logs.join('\n')).not.toContain(MCP_KEY);
  });

  it('hello targets say whether a spawn there gets MCP, and why not', () => {
    const dir = configDir({ mcpKey: null });
    writeEridaniFile(dir, { ...readEridaniFile(dir), targets: [{ ...TARGET, id: 'a' }, { ...TARGET, id: 'b', mcpKeyFile: 'b-key' }] });
    fs.writeFileSync(path.join(dir, 'b-key'), MCP_KEY);
    const registry = Registry.load({ file: null, bootId: 'boot-1' });
    const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
    const rt = new EridaniRuntime({ dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '9.9.9', log: () => {} });
    const targets = rt.helloTargets();
    expect(targets.find((t) => t.id === 'a')!.mcp).toEqual({ configured: false, reason: `no MCP key file at ${path.join(dir, ERIDANI_MCP_KEY_FILE)}` });
    expect(targets.find((t) => t.id === 'b')!.mcp).toEqual({ configured: true });
    expect(JSON.stringify(targets)).not.toContain(MCP_KEY);
  });
});

// ── SessionStart context ──────────────────────────────────────────────────

describe('context: the agent is told whether it has the Eridani tools', () => {
  const svc = (mcp: { configured: boolean; reason?: string } | undefined) =>
    new ContextService({
      session: () => ({ id: 's', incarnation: 1, cwd: '/wt', eridani: { runId: 'run-1', generation: 1, ...(mcp ? { mcp } : {}) } }) as never,
      enabled: () => true,
      request: async () => ({ text: 'Plan first.', scope: 'run' }),
    });

  it('configured: names the tools and the server', async () => {
    const out = await svc({ configured: true }).sessionStart('s', { sessionId: 'abc', source: 'startup' });
    expect(out).toContain('Eridani tools: submit_plan, submit_plan_review, task_step, task_interview, session_link are available via the eridani MCP server.');
  });

  it('not configured: says the tools are unavailable and why', async () => {
    const out = await svc({ configured: false, reason: 'no MCP key file at /x' }).sessionStart('s', { sessionId: 'abc', source: 'startup' });
    expect(out).toContain('are not available in this session: no MCP key file at /x.');
  });

  it('an older binding (no mcp field): no line', async () => {
    const out = await svc(undefined).sessionStart('s', { sessionId: 'abc', source: 'startup' });
    expect(out).not.toMatch(/MCP/);
  });
});

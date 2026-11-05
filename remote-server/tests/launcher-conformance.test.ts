/**
 * Launcher conformance (launcher-conformance.ts): which installed launcher may
 * run managed sessions, decided by a probe of the exact binary instead of a
 * version allowlist. Runners and binaries are mocked here; the real probe is
 * `remotea launcher probe` against the installed Claude Code and Codex.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CONFORMANCE_FILE,
  LauncherConformance,
  precheck,
  readRecords,
  type ConformanceRunner,
  type ConformanceStep,
} from '../src/launcher-conformance';
import { claudeConformance, codexConformance, missingFlags, permissionModeChoices } from '../src/launcher-conformance-probe';
import { launcherCommand } from '../src/launcher-cli';
import type { LauncherProbe } from '../src/launch-caps';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix = 'remotea-conformance-test-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

const PASS: ConformanceStep[] = [{ id: 'help', status: 'pass', ms: 3 }, { id: 'hook_callback', status: 'pass', ms: 9 }];
const FAIL: ConformanceStep[] = [{ id: 'help', status: 'pass', ms: 3 }, { id: 'hook_callback', status: 'fail', ms: 20_000, message: 'no answer within 20 s' }, { id: 'interrupt', status: 'skipped', ms: 0, message: 'not run: hook_callback failed' }];
const binary = (version: string, mtime = 1000, p = '/opt/claude/bin'): LauncherProbe => ({ ok: true, version, path: p, mtime_ms: mtime });

function setup(steps: ConformanceStep[] | (() => Promise<ConformanceStep[]>) = PASS, o: { env?: NodeJS.ProcessEnv; now?: () => number; dir?: string } = {}) {
  const dir = o.dir ?? tmp();
  const runs: string[] = [];
  const settled: string[] = [];
  const logs: string[] = [];
  const run: ConformanceRunner = async (h, bin) => { runs.push(`${h}:${bin}`); return typeof steps === 'function' ? steps() : steps; };
  const c = new LauncherConformance({ dir, run, log: (m) => logs.push(m), env: o.env ?? {}, platform: 'linux', now: o.now, onSettled: (h, _b, a) => settled.push(`${h}:${a.conformance}`) });
  return { c, dir, runs, settled, logs };
}

describe('the floor and the overrides decide without a probe', () => {
  it('below the floor: refused and never probed', async () => {
    const { c, runs } = setup();
    expect(await c.ensure('claude', 'claude', binary('2.1.311'))).toMatchObject({ managed: false, conformance: 'below_floor', launcher_version: '2.1.311', conformance_message: expect.stringMatching(/2\.1\.312/) });
    expect(await c.ensure('codex', 'codex', binary('0.165.9'))).toMatchObject({ managed: false, conformance: 'below_floor' });
    expect(runs).toEqual([]);
  });

  it('not Linux, or no readable version: unsupported', () => {
    expect(precheck('claude', '2.1.318', {}, 'darwin')).toMatchObject({ managed: false, conformance: 'unsupported' });
    expect(precheck('claude', null, {}, 'linux')).toMatchObject({ managed: false, conformance: 'unsupported' });
    expect(precheck('codex', 'nightly', {}, 'linux')).toMatchObject({ managed: false, conformance: 'unsupported' });
  });

  it('FORCE admits a version without a probe (logged once); BLOCK refuses one, and wins over FORCE', async () => {
    const { c, runs, logs } = setup(PASS, { env: { REMOTEA_MANAGED_CLAUDE_FORCE: '2.1.330, 2.1.331', REMOTEA_MANAGED_CLAUDE_BLOCK: '2.1.319 2.1.331', REMOTEA_MANAGED_CODEX_FORCE: '0.170.0' } });
    expect(await c.ensure('claude', 'claude', binary('2.1.330'))).toMatchObject({ managed: true, conformance: 'forced', conformance_message: expect.stringMatching(/REMOTEA_MANAGED_CLAUDE_FORCE/) });
    await c.ensure('claude', 'claude', binary('2.1.330'));
    expect(logs.filter((l) => /WITHOUT a probe/.test(l))).toHaveLength(1);
    expect(await c.ensure('claude', 'claude', binary('2.1.319'))).toMatchObject({ managed: false, conformance: 'blocked', conformance_message: expect.stringMatching(/REMOTEA_MANAGED_CLAUDE_BLOCK/) });
    expect(await c.ensure('claude', 'claude', binary('2.1.331'))).toMatchObject({ managed: false, conformance: 'blocked' });
    expect(await c.ensure('codex', 'codex', binary('0.170.0'))).toMatchObject({ managed: true, conformance: 'forced' });
    // A forced version below the floor stays refused.
    expect(precheck('claude', '2.1.300', { REMOTEA_MANAGED_CLAUDE_FORCE: '2.1.300' }, 'linux')).toMatchObject({ conformance: 'below_floor' });
    expect(runs).toEqual([]);
  });
});

describe('a version above the floor is unverified until probed', () => {
  it('a new version is probed (probing meanwhile), then admitted and recorded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { c, dir, runs, settled } = setup(async () => { await gate; return PASS; });
    const probe = binary('2.1.400');
    expect(c.admission('claude', 'claude', probe)).toMatchObject({ managed: false, conformance: 'unverified' });
    const done = c.ensure('claude', 'claude', probe);
    expect(c.admission('claude', 'claude', probe)).toMatchObject({ managed: false, conformance: 'probing', launcher_version: '2.1.400' });
    expect(c.probing('claude', 'claude')).toBe(true);
    // A second request joins the probe in flight.
    const again = c.ensure('claude', 'claude', probe);
    release();
    expect(await done).toMatchObject({ managed: true, conformance: 'verified', launcher_version: '2.1.400', conformance_at: expect.any(String) });
    await again;
    expect(runs).toEqual(['claude:claude']);
    expect(settled).toEqual(['claude:verified']);
    const record = Object.values(readRecords(path.join(dir, CONFORMANCE_FILE)))[0];
    expect(record).toMatchObject({ harness: 'claude', bin: 'claude', version: '2.1.400', path: '/opt/claude/bin', mtime_ms: 1000, outcome: 'pass', steps: PASS, by: 'server' });
  });

  it('a failure is reported with the step that failed and its message', async () => {
    const { c } = setup(FAIL);
    expect(await c.ensure('claude', 'claude', binary('2.1.319'))).toEqual({ managed: false, conformance: 'failed', launcher_version: '2.1.319', conformance_step: 'hook_callback', conformance_message: 'no answer within 20 s', conformance_at: expect.any(String) });
  });

  it('a runner that throws is a failed `probe` step, never an exception', async () => {
    const { c } = setup(async () => { throw new Error('spawn EACCES'); });
    expect(await c.ensure('claude', 'claude', binary('2.1.400'))).toMatchObject({ managed: false, conformance: 'failed', conformance_step: 'probe', conformance_message: 'spawn EACCES' });
  });

  it('an unchanged binary is a cache hit, also for a new server reading the file', async () => {
    const first = setup();
    await first.c.ensure('claude', 'claude', binary('2.1.400'));
    await first.c.ensure('claude', 'claude', binary('2.1.400'));
    expect(first.runs).toHaveLength(1);
    const restarted = setup(PASS, { dir: first.dir });
    expect(restarted.c.admission('claude', 'claude', binary('2.1.400'))).toMatchObject({ managed: true, conformance: 'verified' });
    expect(await restarted.c.ensure('claude', 'claude', binary('2.1.400'))).toMatchObject({ conformance: 'verified' });
    expect(restarted.runs).toEqual([]);
  });

  it('a changed mtime, path or version is a different binary: unverified until probed again', async () => {
    const { c, runs } = setup();
    await c.ensure('claude', 'claude', binary('2.1.400', 1000));
    expect(c.admission('claude', 'claude', binary('2.1.400', 2000))).toMatchObject({ managed: false, conformance: 'unverified' });
    await c.ensure('claude', 'claude', binary('2.1.400', 2000));
    await c.ensure('claude', 'claude', binary('2.1.400', 2000, '/opt/other/claude'));
    await c.ensure('claude', 'claude', binary('2.1.401', 2000, '/opt/other/claude'));
    expect(runs).toHaveLength(4);
  });

  it('an unchanged failed binary is tried again only after the retry interval', async () => {
    let now = Date.parse('2026-11-05T00:00:00Z');
    const { c, runs } = setup(FAIL, { now: () => now });
    await c.ensure('claude', 'claude', binary('2.1.400'));
    await c.ensure('claude', 'claude', binary('2.1.400'));
    expect(runs).toHaveLength(1);
    now += 61 * 60_000;
    await c.ensure('claude', 'claude', binary('2.1.400'));
    expect(runs).toHaveLength(2);
    // An explicit re-probe does not wait.
    await c.ensure('claude', 'claude', binary('2.1.400'), { force: true });
    expect(runs).toHaveLength(3);
  });

  it('Codex goes through the same path, kept apart from Claude', async () => {
    const { c, runs } = setup(FAIL);
    expect(await c.ensure('codex', 'codex', binary('0.167.0', 5, '/opt/codex'))).toMatchObject({ managed: false, conformance: 'failed', conformance_step: 'hook_callback', launcher_version: '0.167.0' });
    expect(c.admission('claude', 'codex', binary('0.167.0', 5, '/opt/codex'))).toMatchObject({ conformance: 'below_floor' });
    expect(runs).toEqual(['codex:codex']);
  });

  it('a launcher that does not answer --version is not admitted and not probed', async () => {
    const { c, runs } = setup();
    expect(await c.ensure('claude', 'claude', { ok: false, version: null, error: '`claude` is not on the login shell\'s PATH' })).toMatchObject({ managed: false, conformance: 'unverified', conformance_message: expect.stringMatching(/PATH/) });
    expect(runs).toEqual([]);
  });

  it('reload() sees what `remotea launcher probe` wrote', async () => {
    const { c, dir } = setup(FAIL);
    await c.ensure('claude', 'claude', binary('2.1.400'));
    expect(c.reload()).toBe(false);
    const cli = await launcherCommand(dir, ['probe', 'claude', '--bin', 'claude', '--json'], { out: () => {}, env: {}, probe: async () => binary('2.1.400'), run: async () => PASS });
    expect(cli).toBe(0);
    expect(c.reload()).toBe(true);
    expect(c.admission('claude', 'claude', binary('2.1.400'))).toMatchObject({ managed: true, conformance: 'verified' });
    expect(readRecords(path.join(dir, CONFORMANCE_FILE))[`claude\0claude`]).toMatchObject({ by: 'cli' });
  });
});

describe('help parsing', () => {
  const HELP = `Usage: claude [options]
  -p, --print                           Print response and exit
  --verbose                             Verbose
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts
  --session-id <uuid>                   Use a specific session ID
`;
  it('finds each flag as a word, not as a prefix of another', () => {
    expect(missingFlags(HELP, ['--print', '--verbose', '--permission-prompts', '--session-id'])).toEqual([]);
    expect(missingFlags(HELP, ['--permission', '--resume', '--session'])).toEqual(['--permission', '--resume', '--session']);
  });
  it('reads --permission-mode choices across wrapped lines', () => {
    expect(permissionModeChoices(HELP)).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
    expect(permissionModeChoices('  --permission-mode <mode>  the mode\n  --verbose')).toBeNull();
  });
});

/**
 * A stand-in for Claude Code's stream-json protocol, enough for the probe: it calls the probe's fake
 * Messages API (ANTHROPIC_BASE_URL) for each turn, asks the host through hook_callback and can_use_tool,
 * defers AskUserQuestion and continues it on --resume. NO_HOST_PROMPTS behaves like Claude Code without
 * `--permission-prompt-tool stdio`: permission prompts are denied locally.
 */
function fakeClaude(dir: string, o: { noHostPrompts?: boolean; help?: string } = {}): string {
  const file = path.join(dir, 'fake-claude');
  const help = o.help ?? ['-p, --print', '--verbose', '--input-format', '--output-format', '--include-partial-messages', '--replay-user-messages', '--permission-prompts <target>', '--settings <json>', '--permission-mode <mode> (choices: "auto", "manual", "plan")', '--model <m>', '--effort <e>', '--resume [id]', '--session-id <uuid>'].map((l) => `  ${l}`).join('\n');
  fs.writeFileSync(file, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--help') { console.log(${JSON.stringify(help)}); process.exit(0); }
const http = require('http'), fs = require('fs'), cp = require('child_process'), path = require('path');
const NO_HOST_PROMPTS = ${o.noHostPrompts ? 'true' : 'false'};
const hostPrompts = !NO_HOST_PROMPTS && args.includes('--permission-prompt-tool');
const state = path.join(process.env.CLAUDE_CONFIG_DIR, 'fake-state.json');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let mode = args[args.indexOf('--permission-mode') + 1];
let messages = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')).messages : [];
const pending = new Map(); let n = 0; let current = null;
const ask = (request) => new Promise((r) => { const id = 'fake-' + (++n); pending.set(id, r); send({ type: 'control_request', request_id: id, request }); });
const api = () => new Promise((resolve, reject) => {
  const req = http.request(new URL('/v1/messages', process.env.ANTHROPIC_BASE_URL), { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); });
  current = req; req.on('error', reject); req.end(JSON.stringify({ model: 'fake', stream: false, messages }));
});
async function runTool(tool, preset) {
  const hook = preset ?? await ask({ subtype: 'hook_callback', callback_id: 'remotea-defer-ask', input: { hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: tool.input, tool_use_id: tool.id } });
  const decision = hook && hook.hookSpecificOutput && hook.hookSpecificOutput.permissionDecision;
  if (tool.name === 'AskUserQuestion') {
    if (!hostPrompts) return { is_error: true, content: 'AskUserQuestion is disabled for this session' };
    if (decision === 'defer') { fs.writeFileSync(state, JSON.stringify({ messages, tool })); send({ type: 'result', stop_reason: 'tool_deferred', deferred_tool_use: { id: tool.id, name: tool.name, input: tool.input } }); return null; }
    return { is_error: false, content: 'answered: ' + JSON.stringify(hook.hookSpecificOutput.updatedInput.answers) };
  }
  if (!hostPrompts) return { is_error: true, content: 'needs approval' };
  const p = await ask({ subtype: 'can_use_tool', tool_name: tool.name, input: tool.input, tool_use_id: tool.id });
  if (p.behavior !== 'allow') return { is_error: true, content: p.message };
  cp.execSync(p.updatedInput.command); return { is_error: false, content: 'ok' };
}
async function turn(preset) {
  for (;;) {
    let r; try { r = await api(); } catch { return; }
    messages.push({ role: 'assistant', content: r.content });
    const tool = r.content.find((c) => c.type === 'tool_use');
    if (!tool) { send({ type: 'result', stop_reason: 'end_turn' }); return; }
    const out = await runTool(tool, preset); preset = undefined;
    if (!out) return;
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, ...out }] });
  }
}
require('readline').createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_response') { const r = pending.get(m.response.request_id); pending.delete(m.response.request_id); if (r) r(m.response.response); return; }
  if (m.type === 'control_request') {
    const ok = (response) => send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    if (m.request.subtype === 'initialize') {
      ok({ models: [{ value: 'default', displayName: 'Default', supportedEffortLevels: ['low'], supportsAutoMode: true }], current_permission_mode: mode });
      if (args.includes('--resume') && fs.existsSync(state)) {
        const { tool } = JSON.parse(fs.readFileSync(state, 'utf8')); fs.rmSync(state);
        const hook = await ask({ subtype: 'hook_callback', callback_id: 'remotea-defer-ask', input: { hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: tool.input, tool_use_id: tool.id } });
        const out = await runTool(tool, hook);
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, ...out }] });
        void turn();
      }
    } else if (m.request.subtype === 'set_permission_mode') { mode = m.request.mode; ok({ mode: mode === 'manual' ? 'default' : mode }); }
    else if (m.request.subtype === 'interrupt') { if (current) current.destroy(); ok({ still_queued: [] }); send({ type: 'result', stop_reason: null }); }
    return;
  }
  if (m.type === 'user') { send({ ...m, isReplay: true }); messages.push({ role: 'user', content: m.message.content }); void turn(); }
});
`, { mode: 0o755 });
  return file;
}

describe('the Claude probe against a stand-in binary (no real Claude, no network)', () => {
  it('passes every step when the adapter\'s flags reach the host', async () => {
    const steps = await claudeConformance(fakeClaude(tmp()), { stepMs: 15_000, tmpDir: tmp() });
    expect(steps.map((s) => `${s.id}:${s.status}`)).toEqual(['help:pass', 'initialize:pass', 'permission_mode:pass', 'user_echo:pass', 'hook_callback:pass', 'approval_allow:pass', 'approval_deny:pass', 'question_defer:pass', 'interrupt:pass']);
  }, 60_000);

  it('fails at approval_allow when permission prompts never reach the host, and skips the rest', async () => {
    const steps = await claudeConformance(fakeClaude(tmp(), { noHostPrompts: true }), { stepMs: 15_000, tmpDir: tmp() });
    expect(steps.find((s) => s.status === 'fail')).toMatchObject({ id: 'approval_allow', message: expect.stringMatching(/without asking the host/) });
    expect(steps.filter((s) => s.status === 'skipped').map((s) => s.id)).toEqual(['approval_deny', 'question_defer', 'interrupt']);
  }, 60_000);

  it('fails at help when a flag the adapter uses is gone', async () => {
    const steps = await claudeConformance(fakeClaude(tmp(), { help: '  -p, --print\n  --verbose' }), { stepMs: 15_000, tmpDir: tmp() });
    expect(steps[0]).toMatchObject({ id: 'help', status: 'fail', message: expect.stringMatching(/does not list --input-format/) });
  }, 30_000);

  it('turn steps off: reported skipped ("not probed"), and the probe still passes', async () => {
    const steps = await claudeConformance(fakeClaude(tmp()), { stepMs: 15_000, tmpDir: tmp(), turns: false });
    expect(steps.filter((s) => s.status === 'fail')).toEqual([]);
    expect(steps.find((s) => s.id === 'approval_allow')).toMatchObject({ status: 'skipped', message: expect.stringMatching(/not probed/) });
  }, 30_000);
});

describe('the Codex probe', () => {
  it('a binary without the app-server transport fails at help', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'fake-codex');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const steps = await codexConformance(bin, { stepMs: 10_000, tmpDir: tmp() });
    expect(steps[0]).toMatchObject({ id: 'help', status: 'fail', message: expect.stringMatching(/exited 2/) });
    expect(steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
  }, 30_000);
});

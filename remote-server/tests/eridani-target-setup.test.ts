/**
 * `remotea eridani targets setup` (eridani-target-setup.ts): the harness's
 * answer is validated hard (a good answer passes; a shell string, a bad id or
 * extra keys drop it), the heuristics take over without a usable answer and
 * say why, CI on pull requests is detected, `--json` writes nothing without
 * `--yes`, and a confirmed proposal is written through `saveTarget` exactly as
 * `targets add` writes it. The harness and the sandboxed check are injected:
 * no test launches a real harness or bwrap.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { noPrompter, type Prompter } from '../src/eridani-setup';
import {
  argvError,
  detectCi,
  extractJson,
  inspectArgs,
  parseTargetSetupArgs,
  runTargetSetup,
  validateProposal,
  workflowOnPullRequest,
  type CheckFn,
  type InspectFn,
  type TargetSetupDeps,
} from '../src/eridani-target-setup';
import { loadTargets, saveTarget, type ExecutionTarget } from '../src/eridani-targets';
import type { ProbeFn } from '../src/launch-caps';
import type { VerifyOutcome } from '../src/verify-runner';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(prefix = 'remotea-target-setup-'): string {
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

/** A git repository on `main` with one commit and the given files. */
function repoWith(files: Record<string, string> = {}): string {
  const repo = path.join(tmpDir(), 'app');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}

const GOOD = {
  base: 'main',
  prepare: [{ id: 'deps', argv: ['npm', 'ci'] }],
  verify: [{ id: 'test', argv: ['npm', 'test'], why: 'the unit tests' }],
  notes: 'needs node 22',
};

const probeOnly = (...installed: Array<'claude' | 'codex'>): ProbeFn => async (h) => (installed.includes(h as 'claude' | 'codex') ? { ok: true, version: '9.9.9' } : { ok: false, version: null, error: 'not found' });

/** A harness that answers `text` and records how it was asked. */
function fakeInspect(text: string | ((h: string) => string)) {
  const calls: Array<{ harness: string; model: string | null; prompt: string }> = [];
  const fn: InspectFn = async (harness, _bin, _repo, prompt, model) => {
    calls.push({ harness, model, prompt });
    return { ok: true, text: typeof text === 'string' ? text : text(harness) };
  };
  return { fn, calls };
}

function outcome(over: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return { workspace_fingerprint: 'x:y', exit_code: 0, tail: 'ok\n', truncated: false, duration_ms: 1234, timed_out: false, canceled: false, stale_workspace: false, isolated: true, isolation: 'bwrap', ...over };
}

function fakeCheck(o: Partial<VerifyOutcome> = {}) {
  const calls: Array<{ spec: Parameters<CheckFn>[0]; repo: string; timeoutMs: number }> = [];
  const fn: CheckFn = async (spec, repo, timeoutMs) => {
    calls.push({ spec, repo, timeoutMs });
    return outcome(o);
  };
  return { fn, calls };
}

const yesPrompter = (answer: boolean): Prompter & { asked: string[] } => {
  const asked: string[] = [];
  return { interactive: true, text: async (_q, d) => d ?? '', secret: async () => '', confirm: async (q) => { asked.push(q); return answer; }, asked };
};

function deps(over: Partial<TargetSetupDeps> & { dir: string }): TargetSetupDeps & { text: () => string } {
  const s = sink();
  const home = tmpDir('remotea-target-setup-home-');
  return { out: s.out, prompt: noPrompter, home, env: { PATH: '/usr/bin:/bin' }, probe: probeOnly('claude'), progress: () => {}, ...over, text: s.text };
}

// ── The harness's answer ─────────────────────────────────────────────────────

describe('validateProposal', () => {
  it('accepts a good answer', () => {
    const v = validateProposal({ ...GOOD, verify: [{ id: 'web.test', argv: ['npm', 'run', 'test'], cwd: './web/', why: 'web \x1b[31mtests\x1b[0m' }] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.proposal).toEqual({
      base: 'main',
      prepare: [{ id: 'deps', argv: ['npm', 'ci'] }],
      verify: [{ id: 'web.test', argv: ['npm', 'run', 'test'], cwd: 'web', why: 'web tests' }],
      notes: 'needs node 22',
    });
  });

  it('accepts empty lists and a missing base', () => {
    expect(validateProposal({ prepare: [], verify: [], notes: '' })).toEqual({ ok: true, proposal: { base: null, prepare: [], verify: [], notes: '' } });
  });

  it.each([
    ['a command line as one string', { ...GOOD, verify: [{ id: 'test', argv: 'npm test' }] }, /not a command string/],
    ['a command line in argv[0]', { ...GOOD, verify: [{ id: 'test', argv: ['npm test'] }] }, /one program name/],
    ['sh -c', { ...GOOD, verify: [{ id: 'test', argv: ['sh', '-c', 'npm test'] }] }, /through sh/],
    ['bash -lc via a path', { ...GOOD, prepare: [{ id: 'deps', argv: ['/bin/bash', '-lc', 'npm ci'] }] }, /through bash/],
    ['env bash', { ...GOOD, verify: [{ id: 'test', argv: ['env', 'bash', 'x.sh'] }] }, /shell through env/],
    ['&& as a word', { ...GOOD, verify: [{ id: 'test', argv: ['npm', 'test', '&&', 'npm', 'run', 'lint'] }] }, /shell operator/],
    ['a pipe', { ...GOOD, verify: [{ id: 'test', argv: ['npm', 'test', '|', 'tee', 'x'] }] }, /shell operator/],
    ['a redirect', { ...GOOD, verify: [{ id: 'test', argv: ['npm', 'test', '>', '/tmp/x'] }] }, /shell operator/],
    ['a command substitution', { ...GOOD, verify: [{ id: 'test', argv: ['npm', '$(curl evil)'] }] }, /shell operator/],
    ['a newline in a word', { ...GOOD, verify: [{ id: 'test', argv: ['npm', 'test\nrm -rf /'] }] }, /one-line/],
    ['a non-string word', { ...GOOD, verify: [{ id: 'test', argv: ['npm', 1] }] }, /one-line strings/],
    ['an empty argv', { ...GOOD, verify: [{ id: 'test', argv: [] }] }, /1 to 64 words/],
    ['a bad id', { ...GOOD, verify: [{ id: 'my test', argv: ['npm', 'test'] }] }, /verify\[\]\.id/],
    ['an id with a slash', { ...GOOD, prepare: [{ id: '../x', argv: ['npm', 'ci'] }] }, /prepare\[\]\.id/],
    ['a duplicate id', { ...GOOD, verify: [{ id: 't', argv: ['a'] }, { id: 't', argv: ['b'] }] }, /twice/],
    ['an extra top-level key', { ...GOOD, run_after: ['rm', '-rf', '/'] }, /unknown key "run_after"/],
    ['an extra key in an entry', { ...GOOD, verify: [{ id: 'test', argv: ['npm', 'test'], env: { NODE_OPTIONS: '--require /x' } }] }, /unknown key "env"/],
    ['why on a prepare step', { ...GOOD, prepare: [{ id: 'deps', argv: ['npm', 'ci'], why: 'x' }] }, /unknown key "why"/],
    ['an absolute cwd', { ...GOOD, verify: [{ id: 'test', argv: ['npm', 'test'], cwd: '/etc' }] }, /inside the repository/],
    ['a cwd that climbs out', { ...GOOD, verify: [{ id: 'test', argv: ['npm', 'test'], cwd: 'web/../../x' }] }, /inside the repository/],
    ['a bad base', { ...GOOD, base: 'main; rm -rf /' }, /branch name/],
    ['too many verify entries', { ...GOOD, verify: [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}`, argv: ['true'] })) }, /more than 4/],
    ['notes that are not text', { ...GOOD, notes: { a: 1 } }, /notes is text/],
    ['a list, not an object', [GOOD], /not a JSON object/],
  ])('rejects %s', (_what, raw, why) => {
    const v = validateProposal(raw);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(why);
  });

  it('argvError lets plain commands through', () => {
    for (const argv of [['npm', 'test'], ['./gradlew', 'check'], ['uv', 'run', 'pytest', '-q'], ['make', 'test'], ['go', 'test', './...'], ['npx', 'tsc', '--noEmit']]) expect(argvError(argv)).toBeNull();
  });

  it('extractJson takes only the JSON object, bare or in one fence; prose around it is junk', () => {
    const json = JSON.stringify(GOOD);
    expect(extractJson(json)).toEqual(GOOD);
    expect(extractJson(`\n${json}\n`)).toEqual(GOOD);
    expect(extractJson(`\`\`\`json\n${json}\n\`\`\``)).toEqual(GOOD);
    expect(extractJson(`Here is the proposal:\n${json}`)).toBeNull();
    expect(extractJson(`${json}\nLet me know if you need anything else.`)).toBeNull();
    expect(extractJson('not json')).toBeNull();
    expect(extractJson('"a string"')).toBeNull();
  });

  it('the harness is asked read-only, with a named model', () => {
    const claude = inspectArgs('claude', '/tmp/x', 'opus');
    expect(claude).toEqual(expect.arrayContaining(['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence']));
    expect(claude.slice(claude.indexOf('--model'), claude.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(claude.slice(claude.indexOf('--tools'), claude.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Grep,Glob']);
    const codex = inspectArgs('codex', '/tmp/x', null);
    expect(codex.slice(codex.indexOf('--sandbox'), codex.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    expect(codex).not.toContain('-m');
    expect(inspectArgs('codex', '/tmp/x', 'gpt-x')).toEqual(expect.arrayContaining(['-m', 'gpt-x']));
  });
});

describe('parseTargetSetupArgs', () => {
  it('reads the flags', () => {
    const o = parseTargetSetupArgs(['/r', '--id', 'app', '--harness', 'codex', '--model', 'gpt-6.1', '--yes', '--json']);
    expect(o).toMatchObject({ repo: '/r', id: 'app', harness: 'codex', model: 'gpt-6.1', yes: true, json: true, noHarness: false });
  });
  it('refuses nonsense', () => {
    expect(() => parseTargetSetupArgs([])).toThrow(/usage/);
    expect(() => parseTargetSetupArgs(['/r', '--harness', 'vim'])).toThrow(/claude or codex/);
    expect(() => parseTargetSetupArgs(['/r', '--harness', 'claude', '--no-harness'])).toThrow(/do not go together/);
    expect(() => parseTargetSetupArgs(['/r', '--id', 'a b'])).toThrow(/--id/);
    expect(() => parseTargetSetupArgs(['/r', '--model', 'opus; rm'])).toThrow(/--model/);
    expect(() => parseTargetSetupArgs(['/r', '--frobnicate'])).toThrow(/unknown flag/);
  });
});

// ── CI ───────────────────────────────────────────────────────────────────────

describe('CI detection', () => {
  it.each([
    ['on: pull_request', true],
    ['on: [push, pull_request]', true],
    ['on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]', true],
    ['on:\n  - push\n  - pull_request_target', true],
    ['"on":\n  pull_request: {}', true],
    ['on: push', false],
    ['on:\n  push:\n  # pull_request:\n  workflow_dispatch:', false],
    ['on:\n  push:\njobs:\n  pull_request:\n    runs-on: ubuntu-latest', false],
    ['name: x\njobs: {}', false],
  ])('%j → %s', (text, want) => {
    expect(workflowOnPullRequest(text)).toBe(want);
  });

  it('lists the workflows that run on pull requests', () => {
    const repo = repoWith({
      '.github/workflows/ci.yml': 'name: ci\non: [push, pull_request]\njobs: {}\n',
      '.github/workflows/release.yaml': 'on:\n  push:\n    tags: ["v*"]\n',
      '.github/workflows/lint.yaml': 'on:\n  pull_request:\n',
      '.github/workflows/README.md': 'on: pull_request',
    });
    expect(detectCi(repo)).toEqual({ pull_request: true, workflows: ['ci.yml', 'lint.yaml'] });
    expect(detectCi(repoWith())).toEqual({ pull_request: false, workflows: [] });
  });
});

// ── The command ──────────────────────────────────────────────────────────────

describe('runTargetSetup', () => {
  const NODE_REPO = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'package-lock.json': '{}' };

  it('uses the harness answer, tries the check in the sandbox with no network, and reports it', async () => {
    const dir = tmpDir();
    const repo = repoWith(NODE_REPO);
    const h = fakeInspect(JSON.stringify(GOOD));
    const c = fakeCheck({ duration_ms: 8123 });
    const d = deps({ dir, inspect: h.fn, runCheck: c.fn });
    const { code, result } = await runTargetSetup(parseTargetSetupArgs([repo, '--json', '--yes']), d);
    expect(code).toBe(0);
    expect(h.calls).toEqual([expect.objectContaining({ harness: 'claude', model: 'opus' })]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].spec).toMatchObject({ id: 'test', argv: ['npm', 'test'], isolation: 'bwrap', network: false });
    expect(c.calls[0].repo).toBe(repo);
    expect(result).toMatchObject({ saved: true, source: 'harness', harness: { asked: 'claude', model: 'opus', version: '9.9.9' }, gate: 'local' });
    expect(result.checks).toEqual([expect.objectContaining({ id: 'test', status: 'passed', duration_ms: 8123, isolated: true, kept: true })]);
    expect(result.target).toMatchObject({ id: 'app', repo, base: 'main', verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 7200 }], prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 900 }] });
    expect(result.notes).toContain('needs node 22');
    // --json: stdout is exactly the result.
    expect(JSON.parse(d.text())).toEqual(result);
  });

  it('a failing check is reported, not dropped, and the target can be saved without it', async () => {
    const dir = tmpDir();
    const repo = repoWith(NODE_REPO);
    const d = deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: fakeCheck({ exit_code: 1, tail: 'Cannot find module vitest\n', duration_ms: 900 }).fn, prompt: yesPrompter(true) });
    const { result } = await runTargetSetup(parseTargetSetupArgs([repo]), d);
    expect(result.checks).toEqual([expect.objectContaining({ id: 'test', status: 'failed', exit_code: 1, kept: false, tail: expect.stringContaining('Cannot find module vitest') })]);
    expect(result.target.verify).toEqual([]);
    expect(result.gate).toBe('none');
    expect(d.text()).toMatch(/FAILED \(exit 1\) after 0\.9 s/);
    expect(d.text()).toMatch(/NOTHING: no local check and no CI/);
    expect(result.saved).toBe(true);
    expect(loadTargets(dir)[0].verify).toEqual([]);
  });

  it('says CI is the gate when there is no local check but pull requests have CI', async () => {
    const dir = tmpDir();
    const repo = repoWith({ '.github/workflows/ci.yml': 'on: pull_request\n' });
    const d = deps({ dir, inspect: fakeInspect(JSON.stringify({ base: 'main', prepare: [], verify: [], notes: '' })).fn, runCheck: fakeCheck().fn });
    const { code, result } = await runTargetSetup(parseTargetSetupArgs([repo]), d);
    expect(result.gate).toBe('ci');
    expect(result.ci).toEqual({ pull_request: true, workflows: ['ci.yml'] });
    expect(d.text()).toMatch(/CI IS THE GATE/);
    // No terminal, no --yes: nothing written.
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(dir, 'eridani.json'))).toBe(false);
  });

  describe('falls back to the heuristics and says why', () => {
    it('with --no-harness', async () => {
      const dir = tmpDir();
      const h = fakeInspect(JSON.stringify(GOOD));
      const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), '--no-harness', '--json']), deps({ dir, inspect: h.fn, runCheck: fakeCheck().fn }));
      expect(h.calls).toEqual([]);
      expect(result).toMatchObject({ source: 'heuristics', harness: { asked: null, model: null, fallback_reason: '--no-harness' } });
      expect(result.target.verify).toEqual([{ id: 'test', argv: ['npm', 'test'], timeout: 7200 }]);
      expect(result.target.prepare).toEqual([{ id: 'deps', argv: ['npm', 'ci'], timeout: 900 }]);
      expect(result.target.base).toBe('main');
    });

    it('with no harness installed', async () => {
      const h = fakeInspect(JSON.stringify(GOOD));
      const d = deps({ dir: tmpDir(), probe: probeOnly(), inspect: h.fn, runCheck: fakeCheck().fn });
      const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO)]), d);
      expect(h.calls).toEqual([]);
      expect(result.harness.fallback_reason).toMatch(/neither claude nor codex is installed/);
      expect(d.text()).toMatch(/Proposed from the repository's files, without a harness \(neither claude nor codex is installed\)/);
    });

    it('when the named harness is not installed', async () => {
      const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), '--harness', 'codex', '--json']), deps({ dir: tmpDir(), inspect: fakeInspect('{}').fn, runCheck: fakeCheck().fn }));
      expect(result.source).toBe('heuristics');
      expect(result.harness.fallback_reason).toMatch(/codex is not installed/);
    });

    it('when every answer is invalid, after trying each installed harness', async () => {
      const h = fakeInspect((harness) => (harness === 'claude' ? JSON.stringify({ ...GOOD, verify: [{ id: 'test', argv: 'npm test' }] }) : `Sure! ${JSON.stringify(GOOD)}`));
      const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), '--json']), deps({ dir: tmpDir(), probe: probeOnly('claude', 'codex'), inspect: h.fn, runCheck: fakeCheck().fn }));
      expect(h.calls.map((c) => [c.harness, c.model])).toEqual([['claude', 'opus'], ['codex', null]]);
      expect(result.source).toBe('heuristics');
      expect(result.harness.fallback_reason).toMatch(/claude's answer was not usable: verify test: argv is a list of words/);
      expect(result.harness.fallback_reason).toMatch(/codex's answer was not usable: it is not one JSON object/);
      expect(result.target.verify.map((v) => v.argv)).toEqual([['npm', 'test']]);
    });

    it('when the harness fails, the next one answers and the failure is noted', async () => {
      const inspect: InspectFn = async (harness) => (harness === 'claude' ? { ok: false, error: 'claude reported an error: not logged in' } : { ok: true, text: JSON.stringify(GOOD) });
      const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), '--json']), deps({ dir: tmpDir(), probe: probeOnly('claude', 'codex'), inspect, runCheck: fakeCheck().fn }));
      expect(result).toMatchObject({ source: 'harness', harness: { asked: 'codex' } });
      expect(result.notes[0]).toMatch(/claude gave no answer: claude reported an error: not logged in/);
    });
  });

  it('replaces a base branch that does not exist with the detected one', async () => {
    const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(), '--json']), deps({ dir: tmpDir(), inspect: fakeInspect(JSON.stringify({ ...GOOD, base: 'develop' })).fn, runCheck: fakeCheck().fn }));
    expect(result.target.base).toBe('main');
    expect(result.notes).toContain('the proposed base branch develop does not exist here; using main');
  });

  it('--json writes nothing without --yes, and saves with it', async () => {
    const dir = tmpDir();
    const repo = repoWith(NODE_REPO);
    const mk = () => deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: fakeCheck().fn, prompt: yesPrompter(true) });
    const first = await runTargetSetup(parseTargetSetupArgs([repo, '--json']), mk());
    expect(first.result.saved).toBe(false);
    expect(fs.existsSync(path.join(dir, 'eridani.json'))).toBe(false);
    expect(loadTargets(dir)).toEqual([]);

    const second = await runTargetSetup(parseTargetSetupArgs([repo, '--json', '--yes']), mk());
    expect(second.result.saved).toBe(true);
    expect(loadTargets(dir)).toEqual([second.result.target]);
  });

  it('asks once and, on yes, writes exactly what saveTarget writes', async () => {
    const dir = tmpDir();
    const repo = repoWith(NODE_REPO);
    const prompt = yesPrompter(true);
    const d = deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: fakeCheck().fn, prompt });
    const { code, result } = await runTargetSetup(parseTargetSetupArgs([repo]), d);
    expect(code).toBe(0);
    expect(prompt.asked).toEqual([expect.stringMatching(/^\nRun this check \(npm test\) now in the sandbox/), '\nSave target app?']);
    expect(d.text()).toMatch(/target app saved/);
    // The same file `targets add` would leave: saveTarget into an empty dir.
    const viaAdd = tmpDir();
    saveTarget(viaAdd, result.target);
    expect(fs.readFileSync(path.join(dir, 'eridani.json'), 'utf8')).toBe(fs.readFileSync(path.join(viaAdd, 'eridani.json'), 'utf8'));
    expect(loadTargets(dir)).toEqual([result.target]);
  });

  it('on no, writes nothing', async () => {
    const dir = tmpDir();
    const prompt = yesPrompter(false);
    const d = deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: fakeCheck().fn, prompt });
    const { code, result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO)]), d);
    expect(code).toBe(0);
    expect(prompt.asked).toHaveLength(2);
    expect(result.saved).toBe(false);
    expect(d.text()).toMatch(/nothing written/);
    expect(fs.existsSync(path.join(dir, 'eridani.json'))).toBe(false);
  });

  it('--yes saves without asking', async () => {
    const dir = tmpDir();
    const prompt = yesPrompter(false);
    const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), '--yes']), deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: fakeCheck().fn, prompt }));
    expect(prompt.asked).toEqual([]);
    expect(result.saved).toBe(true);
    expect(loadTargets(dir).map((t) => t.id)).toEqual(['app']);
  });

  it('replaces the target for the same repository, keeping what setup does not decide', async () => {
    const dir = tmpDir();
    const repo = repoWith(NODE_REPO);
    const old: ExecutionTarget = { id: 'mine', repo, worktreeRoot: path.join(path.dirname(repo), 'wt'), base: 'main', launch: { codex: { bin: '/opt/codex' } }, verify: [], limits: { maxRuns: 2 } };
    saveTarget(dir, old);
    const { result } = await runTargetSetup(parseTargetSetupArgs([repo, '--json', '--yes']), deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: fakeCheck().fn }));
    expect(result.replaces).toBe('mine');
    expect(loadTargets(dir)).toEqual([expect.objectContaining({ id: 'mine', worktreeRoot: old.worktreeRoot, launch: old.launch, limits: old.limits, verify: [expect.objectContaining({ id: 'test' })] })]);
  });

  it('refuses an id that another repository holds', async () => {
    const dir = tmpDir();
    saveTarget(dir, { id: 'app', repo: repoWith(), worktreeRoot: tmpDir(), base: 'main', launch: { claude: {} }, verify: [] });
    // Without --id the folder name is numbered (app-2); asking for `app` itself is refused.
    await expect(runTargetSetup(parseTargetSetupArgs([repoWith(), '--id', 'app', '--json']), deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: fakeCheck().fn }))).rejects.toThrow(/target id app is taken/);
  });

  it('--no-check keeps the check without running it; a check that could not run is left out', async () => {
    const c = fakeCheck();
    const r1 = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), '--no-check', '--json']), deps({ dir: tmpDir(), inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: c.fn }));
    expect(c.calls).toEqual([]);
    expect(r1.result.checks).toEqual([expect.objectContaining({ status: 'not_run', reason: '--no-check', kept: true })]);

    const refused = fakeCheck({ exit_code: null, isolated: false, error: 'isolation "bwrap" is required but bwrap (bubblewrap) is not installed on the service PATH' });
    const r2 = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), '--json', '--yes']), deps({ dir: tmpDir(), inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: refused.fn }));
    expect(r2.result.checks).toEqual([expect.objectContaining({ status: 'not_run', kept: false, reason: expect.stringMatching(/bwrap/) })]);
    expect(r2.result.target.verify).toEqual([]);
  });

  describe('never runs a proposed check before a person has confirmed it', () => {
    // Both sources: the harness's answer, and the heuristics (same rule).
    const SOURCES = [['the harness', [] as string[]], ['the heuristics', ['--no-harness']]] as const;

    it.each(SOURCES)('--json without --yes (%s): not run, needs confirmation, nothing written', async (_s, extra) => {
      const dir = tmpDir();
      const c = fakeCheck();
      const d = deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: c.fn, prompt: yesPrompter(true) });
      const { code, result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), '--json', ...extra]), d);
      expect(c.calls).toEqual([]);
      expect(code).toBe(0);
      expect(result.checks).toEqual([expect.objectContaining({ id: 'test', status: 'not_run', needs_confirmation: true, reason: expect.stringMatching(/^needs confirmation/), kept: true })]);
      // The proposal still shows the check it would keep if it passes.
      expect(result.target.verify.map((v) => v.id)).toEqual(['test']);
      expect(JSON.parse(d.text()).checks[0]).toMatchObject({ status: 'not_run', needs_confirmation: true, reason: expect.any(String) });
      expect(fs.existsSync(path.join(dir, 'eridani.json'))).toBe(false);
    });

    it.each(SOURCES)('no terminal and no --yes (%s): not run, reported, nothing written', async (_s, extra) => {
      const dir = tmpDir();
      const c = fakeCheck();
      const d = deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: c.fn, prompt: noPrompter });
      const { code, result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), ...extra]), d);
      expect(c.calls).toEqual([]);
      expect(code).toBe(1);
      expect(result.checks[0]).toMatchObject({ status: 'not_run', needs_confirmation: true });
      expect(d.text()).toMatch(/check: NOT RUN: needs confirmation/);
      expect(d.text()).toMatch(/nothing written/);
      expect(fs.existsSync(path.join(dir, 'eridani.json'))).toBe(false);
    });

    it.each(SOURCES)('on a terminal (%s): the commands are shown first, and a no runs nothing', async (_s, extra) => {
      const dir = tmpDir();
      const c = fakeCheck();
      let shownBeforeQuestion = '';
      const asked: string[] = [];
      const d = deps({ dir, inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: c.fn });
      d.prompt = { interactive: true, text: async (_q, def) => def ?? '', secret: async () => '', confirm: async (q) => {
        if (!asked.length) shownBeforeQuestion = d.text();
        asked.push(q);
        return false;
      } };
      const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), ...extra]), d);
      expect(c.calls).toEqual([]);
      expect(shownBeforeQuestion).toMatch(/prepare deps\s+npm ci/);
      expect(shownBeforeQuestion).toMatch(/verify test\s+npm test/);
      expect(shownBeforeQuestion).toMatch(/not run yet; it runs only if you say yes below/);
      expect(asked[0]).toMatch(/Run this check \(npm test\) now in the sandbox/);
      expect(result.checks[0]).toMatchObject({ status: 'not_run', reason: 'you chose not to run it', kept: false });
      expect(result.checks[0].needs_confirmation).toBeUndefined();
      expect(result.target.verify).toEqual([]);
    });

    it('on a terminal, a yes runs it after the commands were shown', async () => {
      const textAtRun: string[] = [];
      const d = deps({ dir: tmpDir(), inspect: fakeInspect(JSON.stringify(GOOD)).fn, prompt: yesPrompter(true) });
      d.runCheck = async () => {
        textAtRun.push(d.text());
        return outcome();
      };
      const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO)]), d);
      expect(textAtRun).toHaveLength(1);
      expect(textAtRun[0]).toMatch(/verify test\s+npm test/);
      expect(result.checks[0]).toMatchObject({ status: 'passed', kept: true });
      expect(d.text()).toMatch(/Check results:\n {2}verify test/);
    });

    it.each([['--yes'], ['--json', '--yes']])('%s runs it without asking', async (...flags) => {
      const c = fakeCheck();
      const prompt = yesPrompter(false);
      const { result } = await runTargetSetup(parseTargetSetupArgs([repoWith(NODE_REPO), ...flags]), deps({ dir: tmpDir(), inspect: fakeInspect(JSON.stringify(GOOD)).fn, runCheck: c.fn, prompt }));
      expect(prompt.asked).toEqual([]);
      expect(c.calls).toHaveLength(1);
      expect(result.checks[0]).toMatchObject({ status: 'passed', kept: true });
      expect(result.saved).toBe(true);
    });

    it('asks nothing about a check when none is proposed', async () => {
      const prompt = yesPrompter(true);
      await runTargetSetup(parseTargetSetupArgs([repoWith()]), deps({ dir: tmpDir(), inspect: fakeInspect(JSON.stringify({ base: 'main', prepare: [], verify: [], notes: '' })).fn, runCheck: fakeCheck().fn, prompt }));
      expect(prompt.asked).toEqual(['\nSave target app?']);
    });
  });

  it('refuses a folder that is not a git repository', async () => {
    await expect(runTargetSetup(parseTargetSetupArgs([tmpDir(), '--json']), deps({ dir: tmpDir() }))).rejects.toThrow(/not a git repository/);
  });
});

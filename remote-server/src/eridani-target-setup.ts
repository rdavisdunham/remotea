/**
 * `remotea eridani targets setup <repo-path>`: one guided way to add an
 * execution target (eridani-targets.ts). It proposes the target, tries the
 * proposed check, shows everything, asks once, and saves through the same
 * `saveTarget` that `targets add` uses.
 *
 *   targets setup <repo-path> [--id <id>] [--worktree-root <path>]
 *                 [--harness claude|codex] [--model <name>] [--no-harness] [--claude] [--codex]
 *                 [--no-check] [--check-timeout <s>] [--keep-failing]
 *                 [--verify-timeout <s>] [--prepare-timeout <s>]
 *                 [--yes] [--json]
 *
 * The steps, in order:
 *
 *   1. Propose. A harness reads the repository and answers which branch new
 *      work starts from, how dependencies are installed (`prepare`) and which
 *      quick check says the work is sound (`verify`: tests, lint or a type
 *      check). Repositories differ too much for a fixed rule, so an installed
 *      harness is asked: Claude Code (`claude -p --restricted`: only the
 *      Read, Grep and Glob tools, confined to the repository, the repository's
 *      own .claude settings and hooks ignored, no MCP servers, nothing saved)
 *      or Codex (`codex exec` in its read-only sandbox). The model is named,
 *      not left to the harness's default: `opus` for Claude Code; for Codex
 *      its configured model unless `--model` names one (`--model` overrides
 *      both). It runs the way every session's harness runs:
 *      through the login shell with the session environment (pty-spawn.ts),
 *      found by the same probe hello uses (launch-caps.ts). `--harness` picks
 *      one; without it Claude Code is asked when installed, then Codex when
 *      Claude Code is missing or gives no usable answer.
 *
 *      The harness's answer is UNTRUSTED text. It must be one JSON object:
 *
 *        { "base": "main",
 *          "prepare": [{ "id": "deps", "argv": ["npm", "ci"], "cwd": "web" }],
 *          "verify":  [{ "id": "test", "argv": ["npm", "test"], "cwd": "web", "why": "…" }],
 *          "notes": "…" }
 *
 *      and `validateProposal` checks it hard: only those keys, ids as target
 *      ids (TARGET_ID_RE), every argv a list of one-line words, never a shell
 *      string (`"npm test && npm run lint"` as one word, `sh -c …`, or `&&`,
 *      `|`, `>` as words), `cwd` relative to the repository. Anything else
 *      and the whole answer is dropped. `why` and `notes` are only ever
 *      printed, with control characters removed.
 *
 *      With `--no-harness`, with no harness installed, or when the answer is
 *      not valid, the proposal comes from the same heuristics `setup
 *      --add-repo` uses (`detectVerify`, `detectBase` in eridani-setup.ts),
 *      plus the lockfile's install command as `prepare`; the output says so,
 *      and why.
 *
 *   2. Try the check. Each proposed verify entry runs once through
 *      verify-runner.ts, in the bubblewrap sandbox (verify-sandbox.ts) with
 *      no network, in the repository checkout as it stands, with the
 *      service's PATH. The sandbox is required here: the command was
 *      proposed a moment ago and nobody has read it yet, so on a host without
 *      bwrap it is not run at all, and the result says so. `prepare` is NOT
 *      run: it needs the network and runs unsandboxed, so it first runs when
 *      a managed worktree is made; a check that fails only because the
 *      checkout has no dependencies installed says so in its output.
 *      The result (passed, failed, timed out, not run), the time it took and
 *      the end of its output are reported. A check that did not pass is
 *      shown and left out of the target (`--keep-failing` keeps it); the
 *      target can still be saved without a verify entry.
 *
 *   3. CI. Whether `.github/workflows/*.yml` has a workflow triggered by
 *      `pull_request`. With no local check, "CI is the gate" (or "nothing
 *      gates this target") is printed as an explicit choice.
 *
 *   4. Confirm and save. The proposal is printed; one y/N question; then
 *      `saveTarget`. `--yes` skips the question. Without a terminal on stdin
 *      nothing is asked and nothing is written unless `--yes` is given. An
 *      existing target with the same id, or (without `--id`) for the same
 *      repository, is replaced, keeping its `launch`, `worktreeRoot`,
 *      `mcpKeyFile`, `limits` and `migrations`.
 *
 * `--json` prints one object and writes nothing unless `--yes` is also
 * given, so another program (Eridani, later) can ask for a proposal, show it
 * and call again with `--yes`:
 *
 *   {
 *     "saved": false,
 *     "source": "harness" | "heuristics",
 *     "harness": { "asked": "claude" | "codex" | null, "version": "2.1.326" | null,
 *                  "model": "opus" | null,            // null: the harness's configured model
 *                  "fallback_reason": "…" },          // fallback_reason only with source "heuristics"
 *     "target": { …the ExecutionTarget that is (or would be) saved… },
 *     "replaces": "<existing target id>" | null,
 *     "checks": [{ "id": "test", "argv": ["npm", "test"], "cwd": "web", "why": "…",
 *                  "status": "passed" | "failed" | "timed_out" | "not_run",
 *                  "exit_code": 0, "duration_ms": 8123, "isolated": true,
 *                  "reason": "…",                     // why it was not run, or the runner's error
 *                  "tail": "…last output…",           // absent when it passed
 *                  "left_files": false,               // it left files git does not ignore
 *                  "kept": true }],                   // it is in target.verify
 *     "ci": { "pull_request": true, "workflows": ["ci.yml"] },
 *     "gate": "local" | "ci" | "none",
 *     "notes": ["…"],
 *     "problems": [{ "level": "fail" | "warn", "check": "…", "reason": "…" }]   // target-template.ts
 *   }
 *
 * Exit status: 0 when saved, declined, or `--json`; 1 when nothing could be
 * asked (no terminal, no `--yes`); errors throw as everywhere in the CLI.
 */
import { execFileSync, spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BRANCH_RE, type HelloTemplate } from '../../src/shared/eridani-link-protocol';
import { DEFAULT_VERIFY_TIMEOUT, detectBase, detectVerify, noPrompter, serviceEnv, targetId, type Prompter } from './eridani-setup';
import { PREPARE_MAX_STEPS, TARGET_ID_RE, loadTargets, saveTarget, targetError, type ExecutionTarget, type PrepareSpec, type VerifySpec } from './eridani-targets';
import { defaultProbe, probeKey, type LauncherProbe, type ProbeFn, type SpawnHarness } from './launch-caps';
import { buildEnv, loginShell, shellArgs } from './pty-spawn';
import { templateStatus } from './target-template';
import { runVerify, type VerifyOutcome } from './verify-runner';

// ── Flags ──────────────────────────────────────────────────────────────────

export interface TargetSetupOptions {
  repo: string;
  id?: string;
  worktreeRoot?: string;
  /** The only harness to ask; absent: each installed one in turn, Claude Code first. */
  harness?: SpawnHarness;
  /** The model the harness is asked with; absent: `opus` for Claude Code, the configured one for Codex. */
  model?: string;
  noHarness: boolean;
  /** The harnesses the target may launch (`--claude`, `--codex`); empty: the installed ones. */
  launch: SpawnHarness[];
  noCheck: boolean;
  /** Seconds a trial check may run here. */
  checkTimeout: number;
  keepFailing: boolean;
  /** Seconds, on the saved verify entries. */
  verifyTimeout: number;
  /** Seconds, on the saved prepare steps. */
  prepareTimeout: number;
  yes: boolean;
  json: boolean;
}

export const TARGET_SETUP_USAGE = `usage: remotea eridani targets setup <repo-path> [--id <id>] [--worktree-root <path>] [--harness claude|codex] [--model <name>] [--no-harness]
                                     [--claude] [--codex] [--no-check] [--check-timeout <s>] [--keep-failing]
                                     [--verify-timeout <s>] [--prepare-timeout <s>] [--yes] [--json]

Proposes an execution target for the repository (base branch, dependency
install, a quick check), tries the check in the verify sandbox with no
network, says whether pull requests have GitHub CI, asks once, and saves it.

  --harness claude|codex   which installed harness reads the repository (default: claude, then codex)
  --model <name>           the model it reads with (default: opus for claude, codex's configured model)
  --no-harness             do not ask a harness: propose from the files alone
  --claude, --codex        the harnesses the target may launch (default: the installed ones)
  --no-check               do not try the proposed check
  --check-timeout <s>      how long a trial check may run (default 600)
  --keep-failing           keep a check that failed or could not be run
  --yes                    save without asking
  --json                   print the proposal and the result as JSON; writes nothing without --yes`;

/** A model name or alias as the harnesses take it (`opus`, `claude-opus-5-5[1m]`, `gpt-6.1`). */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
/** Claude Code's model for the inspection: the strongest alias, not whatever the person's default is. */
export const CLAUDE_INSPECT_MODEL = 'opus';

const VALUE_FLAGS = new Set(['--id', '--worktree-root', '--harness', '--model', '--check-timeout', '--verify-timeout', '--prepare-timeout']);
const BOOL_FLAGS = new Set(['--no-harness', '--claude', '--codex', '--no-check', '--keep-failing', '--yes', '--json']);

export function parseTargetSetupArgs(args: string[]): TargetSetupOptions {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      values.set(a, v);
    } else if (BOOL_FLAGS.has(a)) bools.add(a);
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}\n${TARGET_SETUP_USAGE}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error(TARGET_SETUP_USAGE);
  const seconds = (flag: string, def: number, max: number): number => {
    const v = values.get(flag);
    if (v === undefined) return def;
    const n = Number(v);
    if (!(n > 0 && n <= max)) throw new Error(`${flag} takes seconds (up to ${max})`);
    return n;
  };
  const harness = values.get('--harness');
  if (harness !== undefined && harness !== 'claude' && harness !== 'codex') throw new Error('--harness takes claude or codex');
  if (harness && bools.has('--no-harness')) throw new Error('--harness and --no-harness do not go together');
  const model = values.get('--model');
  if (model !== undefined && !MODEL_RE.test(model)) throw new Error('--model: a model name or alias (letters, digits, . _ : - [ ])');
  const id = values.get('--id');
  if (id !== undefined && !TARGET_ID_RE.test(id)) throw new Error('--id: letters, digits, . _ - (≤64)');
  return {
    repo: path.resolve(rest[0]),
    ...(id ? { id } : {}),
    ...(values.has('--worktree-root') ? { worktreeRoot: path.resolve(values.get('--worktree-root')!) } : {}),
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    noHarness: bools.has('--no-harness'),
    launch: (['claude', 'codex'] as const).filter((h) => bools.has(`--${h}`)),
    noCheck: bools.has('--no-check'),
    checkTimeout: seconds('--check-timeout', 600, 6 * 3600),
    keepFailing: bools.has('--keep-failing'),
    verifyTimeout: seconds('--verify-timeout', DEFAULT_VERIFY_TIMEOUT, 6 * 3600),
    prepareTimeout: seconds('--prepare-timeout', 900, 2 * 3600),
    yes: bools.has('--yes'),
    json: bools.has('--json'),
  };
}

// ── The harness's answer ───────────────────────────────────────────────────

export interface ProposedStep {
  id: string;
  argv: string[];
  /** Relative to the repository. */
  cwd?: string;
  /** Verify entries only: one line on what the check covers. Printed, never run. */
  why?: string;
}

export interface Proposal {
  base: string | null;
  prepare: ProposedStep[];
  verify: ProposedStep[];
  notes: string;
}

/** At most this many verify entries in one proposal: each is run once here. */
export const PROPOSAL_MAX_VERIFY = 4;
const NOTES_MAX = 2000;
const WHY_MAX = 300;

/** Programs that take a command line as text. With `-c` they are a shell string in disguise. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'eval', 'exec', 'xargs']);
/** Words that only mean something to a shell. */
const SHELL_WORD_RE = /^(?:&&|\|\||\||;|&|>|>>|<|<<|2>|2>&1|&>|\$\(.*|`.*)$/;

/** Text from the harness, safe to print: one line or a few, no escape sequences, bounded. */
export function printable(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Why an argv is not a plain command (a shell string, a shell with -c, a shell operator), or null. */
export function argvError(argv: unknown): string | null {
  if (!Array.isArray(argv) || !argv.length || argv.length > 64) return 'argv is a list of 1 to 64 words';
  for (const a of argv) {
    if (typeof a !== 'string' || !a.length || a.length > 512 || /[\0\r\n]/.test(a)) return 'argv words are one-line strings';
  }
  const words = argv as string[];
  // The program: one word, no spaces, no shell syntax. "npm test" as argv[0] is a shell string.
  if (/[\s;&|<>`$(){}*?!'"\\]/.test(words[0]) || words[0].startsWith('-')) return `argv[0] is one program name, not a command line (${JSON.stringify(words[0].slice(0, 60))})`;
  const prog = path.basename(words[0]).toLowerCase();
  if (SHELLS.has(prog) && (prog === 'eval' || prog === 'exec' || prog === 'xargs' || words.slice(1).some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w) || w === '/c' || w === '-Command' || w === '-command'))) return `argv runs a command line through ${prog}`;
  if (prog === 'env' && words.slice(1).some((w) => SHELLS.has(path.basename(w).toLowerCase()))) return 'argv runs a shell through env';
  for (const w of words.slice(1)) {
    if (SHELL_WORD_RE.test(w)) return `argv has a shell operator (${JSON.stringify(w.slice(0, 20))}): one command per entry, no shell`;
  }
  return null;
}

function stepsError(what: 'prepare' | 'verify', raw: unknown, max: number): { steps: ProposedStep[] } | { error: string } {
  if (raw === undefined || raw === null) return { steps: [] };
  if (!Array.isArray(raw)) return { error: `${what} is a list` };
  if (raw.length > max) return { error: `${what} has more than ${max} entries` };
  const allowed = what === 'verify' ? ['id', 'argv', 'cwd', 'why'] : ['id', 'argv', 'cwd'];
  const ids = new Set<string>();
  const steps: ProposedStep[] = [];
  for (const s of raw as unknown[]) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: `${what}[] entries are objects` };
    const o = s as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!allowed.includes(k)) return { error: `${what}[]: unknown key ${JSON.stringify(k.slice(0, 40))}` };
    if (typeof o.id !== 'string' || !TARGET_ID_RE.test(o.id)) return { error: `${what}[].id: letters, digits, . _ - (≤64)` };
    if (ids.has(o.id)) return { error: `${what} id ${o.id} twice` };
    ids.add(o.id);
    // A command line as one string is the commonest wrong answer: say so plainly.
    if (typeof o.argv === 'string') return { error: `${what} ${o.id}: argv is a list of words, not a command string` };
    const ae = argvError(o.argv);
    if (ae) return { error: `${what} ${o.id}: ${ae}` };
    if (o.cwd !== undefined && o.cwd !== null && o.cwd !== '' && o.cwd !== '.') {
      if (typeof o.cwd !== 'string' || o.cwd.length > 200 || path.isAbsolute(o.cwd) || o.cwd.split(/[\\/]/).includes('..') || /[\0\r\n]/.test(o.cwd)) return { error: `${what} ${o.id}: cwd is a folder inside the repository` };
    }
    if (o.why !== undefined && o.why !== null && typeof o.why !== 'string') return { error: `${what} ${o.id}: why is text` };
    const cwd = typeof o.cwd === 'string' && o.cwd !== '' && o.cwd !== '.' ? o.cwd.replace(/^\.\//, '').replace(/\/+$/, '') : '';
    const why = typeof o.why === 'string' ? printable(o.why, WHY_MAX) : '';
    steps.push({ id: o.id, argv: [...(o.argv as string[])], ...(cwd ? { cwd } : {}), ...(why ? { why } : {}) });
  }
  return { steps };
}

/**
 * The harness's answer, checked. Only `base`, `prepare`, `verify` and `notes`;
 * one wrong entry drops the whole answer (a half-trusted proposal is worse
 * than the heuristics).
 */
export function validateProposal(raw: unknown): { ok: true; proposal: Proposal } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the answer is not a JSON object' };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['base', 'prepare', 'verify', 'notes'].includes(k)) return { ok: false, error: `unknown key ${JSON.stringify(k.slice(0, 40))}` };
  if (o.base !== undefined && o.base !== null && !(typeof o.base === 'string' && BRANCH_RE.test(o.base))) return { ok: false, error: 'base is a branch name' };
  const prepare = stepsError('prepare', o.prepare, PREPARE_MAX_STEPS);
  if ('error' in prepare) return { ok: false, error: prepare.error };
  const verify = stepsError('verify', o.verify, PROPOSAL_MAX_VERIFY);
  if ('error' in verify) return { ok: false, error: verify.error };
  if (o.notes !== undefined && o.notes !== null && typeof o.notes !== 'string') return { ok: false, error: 'notes is text' };
  return { ok: true, proposal: { base: typeof o.base === 'string' ? o.base : null, prepare: prepare.steps, verify: verify.steps, notes: typeof o.notes === 'string' ? printable(o.notes, NOTES_MAX) : '' } };
}

/**
 * The JSON object a harness answered with: the whole text, or the whole text
 * wrapped in one code fence (the one slip models still make). Prose before or
 * after it is not an answer to the contract: null, as when it does not parse.
 */
export function extractJson(text: string): unknown | null {
  const t = text.trim();
  const fence = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/.exec(t);
  try {
    const v = JSON.parse(fence ? fence[1] : t) as unknown;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** What the harness is asked. The repository's own text may try to answer for it: the validation is what holds. */
export const INSPECT_PROMPT = `You are inspecting the git repository in the current directory. Do not change anything: only read files.

An automation system will create fresh git worktrees of this repository for coding agents. For each new worktree it needs:
- "base": the branch new work starts from (the default branch, e.g. "main").
- "prepare": the steps that install dependencies in a fresh checkout (e.g. npm ci, uv sync --locked). They run in order, with network access. Use the lockfile-respecting form. Empty when nothing needs installing.
- "verify": ONE quick, reliable check that tells whether a change is sound: the unit tests if they finish in a few minutes, else a type check or a lint. It runs WITHOUT network access and without secrets, in a sandbox, after "prepare". Prefer the command the repository's own CI, README, Makefile or package scripts use. Do not pick end-to-end, browser or deploy steps, or anything that needs a database or other service. Add a second entry only when the repository has two separate parts that each need their own check. At most ${PROPOSAL_MAX_VERIFY}. Empty when the repository has no check that can run offline.

Rules for every command:
- "argv" is a list of words run directly with no shell: ["npm", "test"], never "npm test", never sh -c, never &&, pipes or redirects.
- "cwd" is optional: a folder relative to the repository root when the command must run in a subfolder.
- "id" is a short name: letters, digits, dot, underscore, dash.
- "why" (verify only) is one sentence on what the check covers.

Answer with exactly one JSON object and nothing else, no code fence, no prose:
{"base": "<branch>", "prepare": [{"id": "<id>", "argv": ["<word>", "..."], "cwd": "<optional>"}], "verify": [{"id": "<id>", "argv": ["<word>", "..."], "cwd": "<optional>", "why": "<one sentence>"}], "notes": "<anything the person adding this repository should know, or empty>"}`;

// ── Asking the harness ─────────────────────────────────────────────────────

export type InspectResult = { ok: true; text: string } | { ok: false; error: string };
/** Runs the harness headless and read-only in `repo` with `prompt` and `model` (null: its configured one); resolves with its final answer as text. */
export type InspectFn = (harness: SpawnHarness, bin: string, repo: string, prompt: string, model: string | null) => Promise<InspectResult>;

const INSPECT_MARKER = '__remotea_target_setup_5b2d__';
const INSPECT_MS = 5 * 60_000;
const INSPECT_MAX_OUT = 2 * 1024 * 1024;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The harness's command line, read-only and leaving nothing behind.
 *   claude  print mode, JSON envelope, the named model, restricted mode (no
 *           tool that runs code, file tools confined to the repository, and
 *           the repository's own settings files, hooks included, ignored: the
 *           repository is not trusted yet), only the Read/Grep/Glob tools, no
 *           MCP servers, no saved session.
 *   codex   `exec` in the read-only sandbox, no saved session, the last
 *           message written to `outFile`; `-m` only when a model is named.
 * The prompt comes on stdin for both.
 */
export function inspectArgs(harness: SpawnHarness, outFile: string, model: string | null): string[] {
  return harness === 'claude'
    ? ['-p', '--output-format', 'json', '--model', model ?? CLAUDE_INSPECT_MODEL, '--restricted', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence']
    : ['exec', ...(model ? ['-m', model] : []), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', outFile, '-'];
}

/** The model a harness is asked with: `--model`, else opus for Claude Code, else null (Codex's configured model). */
export function inspectModel(harness: SpawnHarness, model: string | undefined): string | null {
  return model ?? (harness === 'claude' ? CLAUDE_INSPECT_MODEL : null);
}

/** Claude Code's `--output-format json` envelope → the answer text. */
export function claudeAnswer(stdout: string): InspectResult {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const env = JSON.parse(line) as { type?: unknown; is_error?: unknown; result?: unknown };
      if (env.type !== 'result') continue;
      if (env.is_error) return { ok: false, error: `claude reported an error: ${printable(String(env.result ?? ''), 200)}` };
      if (typeof env.result === 'string') return { ok: true, text: env.result };
    } catch {
      /* not the envelope */
    }
  }
  return { ok: false, error: 'claude printed no result' };
}

/**
 * The real thing: `<bin> …` through the login shell with a session's
 * environment, exactly as probeLauncher (launch-caps.ts) runs `--version`,
 * so the harness found by the probe is the one that runs. Not a session:
 * REMOTEA_SESSION is removed, so no hook reports it as one.
 */
export const defaultInspect: InspectFn = (harness, bin, repo, prompt, model) => new Promise((resolve) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-target-setup-'));
  const outFile = path.join(tmp, 'answer.txt');
  const cmd = `printf '\\n%s\\n' ${INSPECT_MARKER}; exec ${q(bin)} ${inspectArgs(harness, outFile, model).map(q).join(' ')}`;
  const env = buildEnv('target-setup', undefined);
  delete env.REMOTEA_SESSION;
  let out = '';
  let settled = false;
  const done = (r: InspectResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fs.rmSync(tmp, { recursive: true, force: true });
    resolve(r);
  };
  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = nodeSpawn(loginShell(), shellArgs(cmd), { cwd: repo, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true, windowsHide: true });
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    resolve({ ok: false, error: `cannot start the login shell: ${(err as Error).message}` });
    return;
  }
  const timer = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    done({ ok: false, error: `${harness} did not answer within ${INSPECT_MS / 60_000} min` });
  }, INSPECT_MS);
  timer.unref?.();
  child.stdout?.on('data', (d: Buffer) => {
    if (out.length < INSPECT_MAX_OUT) out += d.toString('utf8');
  });
  child.stdin?.on('error', () => { /* it exited before reading the prompt */ });
  child.stdin?.end(prompt);
  child.on('error', (err) => done({ ok: false, error: `cannot start the login shell: ${err.message}` }));
  child.on('close', (code) => {
    const at = out.lastIndexOf(INSPECT_MARKER);
    if (at < 0) return done({ ok: false, error: `the login shell failed before running ${harness} (exit ${code})` });
    const printed = out.slice(at + INSPECT_MARKER.length);
    if (harness === 'claude') {
      const r = claudeAnswer(printed);
      return done(r.ok || code === 0 ? r : { ok: false, error: `${harness} exited ${code}: ${r.error}` });
    }
    if (code !== 0) return done({ ok: false, error: `${harness} exited ${code}` });
    try {
      done({ ok: true, text: fs.readFileSync(outFile, 'utf8') });
    } catch {
      done({ ok: false, error: `${harness} wrote no answer` });
    }
  });
});

// ── Heuristics and CI ──────────────────────────────────────────────────────

/** The install command the lockfile at the repository root implies, or null. */
export function detectPrepare(repo: string): ProposedStep | null {
  const has = (f: string) => fs.existsSync(path.join(repo, f));
  if (has('pnpm-lock.yaml')) return { id: 'deps', argv: ['pnpm', 'install', '--frozen-lockfile'] };
  if (has('yarn.lock')) return { id: 'deps', argv: ['yarn', 'install', '--frozen-lockfile'] };
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return { id: 'deps', argv: ['npm', 'ci'] };
  if (has('uv.lock')) return { id: 'deps', argv: ['uv', 'sync', '--locked'] };
  return null;
}

/** The proposal without a harness: `detectVerify` and `detectBase` (as `setup --add-repo`), plus the lockfile's install. */
export function heuristicProposal(repo: string): Proposal {
  const v = detectVerify(repo);
  const p = detectPrepare(repo);
  return {
    base: detectBase(repo),
    prepare: p ? [p] : [],
    verify: v ? [{ id: v.id, argv: [...v.argv], why: 'found by file name (package.json, Makefile, pyproject.toml, Cargo.toml or go.mod)' }] : [],
    notes: '',
  };
}

export interface CiFacts {
  /** A workflow runs on pull requests. */
  pull_request: boolean;
  /** The workflow files that do, by name. */
  workflows: string[];
}

/**
 * Does a workflow's text have a `pull_request` (or `pull_request_target`)
 * trigger? Reads only the top-level `on:` value, in its three shapes
 * (`on: pull_request`, `on: [push, pull_request]`, a block), with comments
 * removed; no YAML parser, so an anchor or a quoted multi-line oddity reads
 * as "no".
 */
export function workflowOnPullRequest(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:on|"on"|'on')\s*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[1];
    for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || lines[j] === ''); j++) value += `\n${lines[j]}`;
    return /(?:^|[\s\[,'"-])pull_request(?:_target)?(?=$|[\s\],:'"])/m.test(value);
  }
  return false;
}

/** GitHub Actions workflows in the repository that run on pull requests. */
export function detectCi(repo: string): CiFacts {
  const dir = path.join(repo, '.github', 'workflows');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    return { pull_request: false, workflows: [] };
  }
  const workflows: string[] = [];
  for (const n of names.slice(0, 200)) {
    try {
      const st = fs.statSync(path.join(dir, n));
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      if (workflowOnPullRequest(fs.readFileSync(path.join(dir, n), 'utf8'))) workflows.push(n);
    } catch {
      /* unreadable: not counted */
    }
  }
  return { pull_request: workflows.length > 0, workflows };
}

// ── The command ────────────────────────────────────────────────────────────

export type CheckStatus = 'passed' | 'failed' | 'timed_out' | 'not_run';

export interface CheckResult {
  id: string;
  argv: string[];
  cwd?: string;
  why?: string;
  status: CheckStatus;
  exit_code: number | null;
  duration_ms: number;
  /** It ran inside the sandbox. */
  isolated: boolean;
  /** Why it was not run, or the runner's error. */
  reason?: string;
  /** The end of its output; absent when it passed. */
  tail?: string;
  /** It left files git does not ignore: every later verification of such a tree is "stale". */
  left_files: boolean;
  /** It is in the target's verify list. */
  kept: boolean;
}

export interface TargetSetupResult {
  saved: boolean;
  source: 'harness' | 'heuristics';
  harness: { asked: SpawnHarness | null; version: string | null; model: string | null; fallback_reason?: string };
  target: ExecutionTarget;
  replaces: string | null;
  checks: CheckResult[];
  ci: CiFacts;
  /** What stands between a change and the base branch: a local check, GitHub CI on the pull request, or nothing. */
  gate: 'local' | 'ci' | 'none';
  notes: string[];
  problems: HelloTemplate['problems'];
}

/** Runs one proposed check in `repo`; the default is verify-runner's `runVerify`, sandbox required, no network. */
export type CheckFn = (spec: VerifySpec, repo: string, timeoutMs: number) => Promise<VerifyOutcome>;

export interface TargetSetupDeps {
  dir: string;
  out: NodeJS.WritableStream;
  /** `noPrompter` when there is no terminal: nothing is asked, nothing is written without --yes. */
  prompt: Prompter;
  home?: string;
  env?: NodeJS.ProcessEnv;
  probe?: ProbeFn;
  inspect?: InspectFn;
  runCheck?: CheckFn;
  /** Where progress lines go (default: stderr), so stdout stays the report. */
  progress?: (line: string) => void;
}

const TAIL_SHOWN = 1500;

function branchExists(repo: string, branch: string): boolean {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      /* the next ref */
    }
  }
  return false;
}

function toCheck(step: ProposedStep, o: VerifyOutcome | null, notRun?: string): Omit<CheckResult, 'kept'> {
  const base = { id: step.id, argv: [...step.argv], ...(step.cwd ? { cwd: step.cwd } : {}), ...(step.why ? { why: step.why } : {}) };
  if (!o) return { ...base, status: 'not_run', exit_code: null, duration_ms: 0, isolated: false, reason: notRun ?? 'not run', left_files: false };
  // The runner refused or could not start it: nothing ran.
  if (o.exit_code === null && !o.timed_out) return { ...base, status: 'not_run', exit_code: null, duration_ms: o.duration_ms, isolated: false, reason: printable(o.error ?? o.isolation_reason ?? 'the command could not be started', 300), left_files: false };
  const status: CheckStatus = o.timed_out ? 'timed_out' : o.exit_code === 0 ? 'passed' : 'failed';
  return {
    ...base, status, exit_code: o.exit_code, duration_ms: o.duration_ms, isolated: !!o.isolated,
    ...(status === 'passed' ? {} : { tail: printable(o.tail, Number.MAX_SAFE_INTEGER).slice(-TAIL_SHOWN) }),
    left_files: o.stale_workspace,
  };
}

const fmtSeconds = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const fmtCmd = (s: { argv: string[]; cwd?: string }): string => `${s.argv.join(' ')}${s.cwd ? `  (in ${s.cwd})` : ''}`;

/** The proposal and the check results as a person reads them. */
export function fmtTargetSetup(r: TargetSetupResult): string[] {
  const t = r.target;
  const lines: string[] = [];
  lines.push(r.source === 'harness'
    ? `Proposed by ${r.harness.asked}${r.harness.version ? ` ${r.harness.version}` : ''}${r.harness.model ? ` (${r.harness.model})` : ''} after reading the repository:`
    : `Proposed from the repository's files, without a harness (${r.harness.fallback_reason ?? 'not asked'}):`);
  lines.push(`  id             ${t.id}${r.replaces ? `   (replaces the existing target ${r.replaces})` : ''}`);
  lines.push(`  repository     ${t.repo}`);
  lines.push(`  worktree root  ${t.worktreeRoot}`);
  lines.push(`  base branch    ${t.base}`);
  lines.push(`  harnesses      ${(['claude', 'codex'] as const).filter((h) => t.launch[h]).join(', ') || 'none'}`);
  if (t.prepare?.length) for (const p of t.prepare) lines.push(`  prepare ${p.id.padEnd(7)} ${fmtCmd(p)}   (not run here; runs in each new worktree, ${p.timeout} s limit)`);
  else lines.push('  prepare        none');
  if (!r.checks.length) lines.push('  verify         none proposed');
  for (const c of r.checks) {
    const res = c.status === 'passed' ? `passed in ${fmtSeconds(c.duration_ms)}`
      : c.status === 'failed' ? `FAILED (exit ${c.exit_code}) after ${fmtSeconds(c.duration_ms)}`
        : c.status === 'timed_out' ? `TIMED OUT after ${fmtSeconds(c.duration_ms)}`
          : `not run: ${c.reason}`;
    lines.push(`  verify ${c.id.padEnd(7)} ${fmtCmd(c)}`);
    if (c.why) lines.push(`                 ${c.why}`);
    lines.push(`                 check: ${res}${c.status !== 'not_run' ? (c.isolated ? ', sandboxed, no network' : ', NOT sandboxed') : ''}; ${c.kept ? 'kept' : 'LEFT OUT of the target (--keep-failing keeps it)'}`);
    if (c.left_files) lines.push('                 it left files git does not ignore: a verification of such a tree is reported stale (add them to .gitignore)');
    if (c.tail) {
      lines.push('                 last output:');
      for (const l of c.tail.split('\n').slice(-20)) lines.push(`                   | ${l}`);
    }
  }
  lines.push(`  GitHub CI      ${r.ci.pull_request ? `runs on pull requests (${r.ci.workflows.join(', ')})` : 'no workflow runs on pull requests'}`);
  lines.push(r.gate === 'local' ? `  gate           the local check${t.verify.length > 1 ? 's' : ''} (${t.verify.map((v) => v.id).join(', ')})${r.ci.pull_request ? ', then CI on the pull request' : ''}`
    : r.gate === 'ci' ? '  gate           CI IS THE GATE: no local check, so only the pull request\'s CI tells whether a change is sound'
      : '  gate           NOTHING: no local check and no CI on pull requests; work on this target is not checked by anything');
  for (const n of r.notes) lines.push(`  note           ${n}`);
  for (const p of r.problems ?? []) lines.push(`  ${p.level === 'fail' ? 'NOT READY' : 'warn'}      ${p.check}: ${p.reason}`);
  return lines;
}

/** The default trial: verify-runner in the sandbox (required), no network, the service's PATH. */
function defaultCheck(home: string, env: NodeJS.ProcessEnv): CheckFn {
  return (spec, repo, timeoutMs) => runVerify({ spec, worktree: repo, timeoutMs, env: serviceEnv(home, env).env });
}

export async function runTargetSetup(o: TargetSetupOptions, d: TargetSetupDeps): Promise<{ code: number; result: TargetSetupResult }> {
  const home = d.home ?? os.homedir();
  const env = d.env ?? process.env;
  const say = (line: string) => d.out.write(`${line}\n`);
  const progress = o.json ? () => {} : d.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const probe = d.probe ?? defaultProbe;
  const repo = o.repo;
  if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`${repo} is not a git repository`);

  const existing = loadTargets(d.dir);
  const sameRepo = existing.find((t) => path.resolve(t.repo) === repo);
  const id = o.id ?? sameRepo?.id ?? targetId(repo, new Set(existing.map((t) => t.id)));
  const sameId = existing.find((t) => t.id === id);
  if (sameId && path.resolve(sameId.repo) !== repo) throw new Error(`target id ${id} is taken by ${sameId.repo}: pass another --id, or remove it first (remotea eridani targets remove ${id})`);
  const prior = sameId ?? (o.id ? undefined : sameRepo);

  // Which harnesses are installed: for the inspection, and for the target's `launch`.
  const probes = new Map<string, LauncherProbe>();
  await Promise.all((['claude', 'codex'] as const).map(async (h) => probes.set(probeKey(h, h), await probe(h, h))));
  const installed = (['claude', 'codex'] as const).filter((h) => probes.get(probeKey(h, h))?.ok);

  // 1. The proposal.
  const notes: string[] = [];
  let source: TargetSetupResult['source'] = 'heuristics';
  let asked: SpawnHarness | null = null;
  let fallback: string | undefined;
  let proposal: Proposal | null = null;
  if (o.noHarness) fallback = '--no-harness';
  else if (o.harness && !installed.includes(o.harness)) fallback = `${o.harness} is not installed: ${printable(probes.get(probeKey(o.harness, o.harness))?.error ?? 'not found', 200)}`;
  else if (!installed.length) fallback = 'neither claude nor codex is installed';
  else {
    // The named harness only; else each installed one in turn, until one gives a usable answer.
    const failures: string[] = [];
    for (const want of o.harness ? [o.harness] : installed) {
      asked = want;
      const m = inspectModel(want, o.model);
      progress(`asking ${want}${m ? ` (${m})` : ''} to read ${repo} (read-only; this can take a minute or two)…`);
      const ans = await (d.inspect ?? defaultInspect)(want, want, repo, INSPECT_PROMPT, m);
      if (!ans.ok) {
        failures.push(`${want} gave no answer: ${printable(ans.error, 200)}`);
        continue;
      }
      const raw = extractJson(ans.text);
      const v = raw === null ? ({ ok: false, error: 'it is not one JSON object and nothing else' } as const) : validateProposal(raw);
      if (v.ok) {
        proposal = v.proposal;
        source = 'harness';
        // Say that the first choice was passed over, and why.
        for (const f of failures) notes.push(f);
        break;
      }
      failures.push(`${want}'s answer was not usable: ${printable(v.error, 200)}`);
    }
    if (!proposal) fallback = failures.join('; ');
  }
  if (!proposal) proposal = heuristicProposal(repo);

  // The base must be a branch this repository has; a harness can name one that does not exist.
  let base = proposal.base ?? detectBase(repo);
  if (!branchExists(repo, base)) {
    const detected = detectBase(repo);
    if (detected !== base) notes.push(`the proposed base branch ${base} does not exist here; using ${detected}`);
    base = detected;
  }
  // A cwd that is not a folder of the repository: the step cannot run.
  const cwdOk = (s: ProposedStep): boolean => {
    if (!s.cwd) return true;
    try {
      return fs.statSync(path.join(repo, s.cwd)).isDirectory();
    } catch {
      return false;
    }
  };
  for (const s of [...proposal.prepare, ...proposal.verify]) if (!cwdOk(s)) notes.push(`${s.id}: its folder ${s.cwd} does not exist in the repository`);
  if (proposal.notes) notes.push(proposal.notes);

  // 2. Try each proposed check.
  const ci = detectCi(repo);
  const runCheck = d.runCheck ?? defaultCheck(home, env);
  const checks: CheckResult[] = [];
  for (const step of proposal.verify) {
    let res: Omit<CheckResult, 'kept'>;
    if (o.noCheck) res = toCheck(step, null, '--no-check');
    else if (!cwdOk(step)) res = toCheck(step, null, `its folder ${step.cwd} does not exist`);
    else {
      progress(`trying ${step.id}: ${fmtCmd(step)} (sandboxed, no network, up to ${o.checkTimeout} s)…`);
      // The sandbox is required for the trial: `bwrap` refuses to run where bwrap does not work.
      const spec: VerifySpec = { id: step.id, argv: step.argv, ...(step.cwd ? { cwd: step.cwd } : {}), timeout: o.checkTimeout, isolation: 'bwrap', network: false };
      res = toCheck(step, await runCheck(spec, repo, o.checkTimeout * 1000));
    }
    // Kept: it passed, or it was the person's choice not to run it. Anything else needs --keep-failing.
    const kept = res.status === 'passed' || (res.status === 'not_run' && o.noCheck) || o.keepFailing;
    checks.push({ ...res, kept });
  }

  // The commonest failure in a checkout: its dependencies were never installed, and prepare is not run here.
  if (proposal.prepare.length && checks.some((c) => c.status === 'failed')) {
    notes.push(`prepare (${proposal.prepare.map((p) => fmtCmd(p)).join('; ')}) was not run here: if a check failed because dependencies are missing, run it in ${repo} and try again, or keep the check with --keep-failing`);
  }

  // 3. The target.
  const verify: VerifySpec[] = checks.filter((c) => c.kept).map((c) => ({ id: c.id, argv: [...c.argv], ...(c.cwd ? { cwd: c.cwd } : {}), timeout: o.verifyTimeout }));
  const prepare: PrepareSpec[] = proposal.prepare.map((p) => ({ id: p.id, argv: [...p.argv], ...(p.cwd ? { cwd: p.cwd } : {}), timeout: o.prepareTimeout }));
  const launch: ExecutionTarget['launch'] = {};
  if (o.launch.length) for (const h of o.launch) launch[h] = prior?.launch[h] ?? {};
  else if (prior) Object.assign(launch, prior.launch);
  else for (const h of installed.length ? installed : (['claude'] as const)) launch[h] = {};
  const target: ExecutionTarget = {
    id,
    repo,
    worktreeRoot: o.worktreeRoot ?? prior?.worktreeRoot ?? path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`),
    base,
    launch,
    verify,
    ...(prepare.length ? { prepare } : {}),
    ...(prior?.mcpKeyFile ? { mcpKeyFile: prior.mcpKeyFile } : {}),
    ...(prior?.limits ? { limits: prior.limits } : {}),
    ...(prior?.migrations ? { migrations: prior.migrations } : {}),
  };
  const err = targetError(target);
  if (err) throw new Error(`the proposed target is not valid: ${err}`);
  const tpl = templateStatus(target, { env: serviceEnv(home, env).env });
  const result: TargetSetupResult = {
    saved: false,
    source,
    harness: { asked, version: asked ? probes.get(probeKey(asked, asked))?.version ?? null : null, model: asked ? inspectModel(asked, o.model) : null, ...(source === 'heuristics' && fallback ? { fallback_reason: fallback } : {}) },
    target,
    replaces: prior?.id ?? null,
    checks,
    ci,
    gate: verify.length ? 'local' : ci.pull_request ? 'ci' : 'none',
    notes,
    problems: tpl.problems ?? [],
  };

  // 4. Show, ask once, save.
  if (o.json) {
    if (o.yes) {
      saveTarget(d.dir, target);
      result.saved = true;
    }
    say(JSON.stringify(result, null, 2));
    return { code: 0, result };
  }
  for (const line of fmtTargetSetup(result)) say(line);
  const p = o.yes ? noPrompter : d.prompt;
  if (!o.yes) {
    if (!p.interactive) {
      say('\nnothing written: there is no terminal to confirm on. Run it again with --yes to save this target.');
      return { code: 1, result };
    }
    if (!(await p.confirm(`\nSave target ${id}${result.replaces ? ` (replacing ${result.replaces})` : ''}?`, false))) {
      say('nothing written');
      return { code: 0, result };
    }
  }
  saveTarget(d.dir, target);
  result.saved = true;
  say(`\ntarget ${id} saved; it applies to the next spawn (no restart)`);
  if (!tpl.ready) say(`warning: target ${id} is not ready, so Eridani will not be offered it until the NOT READY lines above are fixed`);
  return { code: 0, result };
}

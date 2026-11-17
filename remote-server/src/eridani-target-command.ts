/**
 * `target.setup` (link cap `target.setup`): `remotea eridani targets setup`
 * run for Eridani, so a target can be added from the app without a
 * terminal. Both halves go through runTargetSetup (eridani-target-setup.ts),
 * with options built by the CLI's own flag parser, so the defaults, the
 * validation and the rule that nothing proposed runs before a person has
 * seen it are the CLI's:
 *
 *   confirm: false  `targets setup <repo> --json [--id] [--harness] [--model]`:
 *                   a harness reads the repository (or the heuristics
 *                   answer), CI is read, no proposed check runs, nothing is
 *                   written. `executed`, result = the `--json` object.
 *   confirm: true   `--json --yes` on the proposal the person saw. The
 *                   supplied `target` becomes the proposal (`confirmed`), so
 *                   no harness is asked again: a second reading could differ
 *                   from what was shown. Each verify entry runs once in the
 *                   sandbox, only the passing ones are kept, the target is
 *                   saved through saveTarget. `executed`, `saved: true`.
 *
 * A confirm carries back only what a proposal decides: `id`, `base`, and the
 * verify and prepare entries as `{id, argv, cwd?, timeout}`, checked by the
 * same rules as a harness's answer (validateProposal: no shell strings, cwd
 * inside the repository, at most PROPOSAL_MAX_VERIFY checks) and by
 * targetError. An entry that sets `env`, `isolation`, `network`, `ports`,
 * `mounts` or `notifyAfter` is refused: a confirm is not a way to change how
 * a check is sandboxed. `launch`, `worktreeRoot`, `mcpKeyFile`, `limits` and
 * `migrations` belong to the host: they come from the existing target with
 * that id, else the defaults the proposal used, never from the confirm.
 *
 * The trial needs the verify sandbox. On a host where bwrap does not work a
 * proposal is still made (the cap is always advertised), but a confirm with a
 * check to try fails with the sandbox's reason and writes nothing; a confirm
 * with no check (CI is the gate) runs nothing and is saved.
 *
 * `expires_at` is checked by the link when the command arrives, and once more
 * before the save: a confirm whose checks ran past it writes nothing, so a
 * person who stopped waiting is not surprised by a target appearing later.
 *
 * Output tails, reasons and notes are redacted (collector/redact.ts) before
 * they leave the host. The harness reads the repository read-only, as the CLI
 * runs it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import type { TargetSetupCommand } from '../../src/shared/eridani-link-protocol';
import { redact } from './collector/redact';
import type { CommandResult } from './eridani-link';
import { noPrompter, serviceEnv } from './eridani-setup';
import {
  parseTargetSetupArgs,
  printable,
  runTargetSetup,
  validateProposal,
  type CheckFn,
  type InspectFn,
  type Proposal,
  type ProposedStep,
  type TargetSetupResult,
} from './eridani-target-setup';
import { saveTarget, targetError, type ExecutionTarget } from './eridani-targets';
import type { ProbeFn } from './launch-caps';
import { planIsolation } from './verify-sandbox';

/** The detail of a second setup while one runs: one at a time per host. */
export const TARGET_SETUP_BUSY = 'a target setup is already running on this host; try again when it finishes';

/** The keys an ExecutionTarget has; anything else in a confirmed target is refused. */
const TARGET_KEYS = new Set(['id', 'repo', 'worktreeRoot', 'base', 'launch', 'verify', 'prepare', 'mcpKeyFile', 'limits', 'migrations']);
/** What a proposal puts in a verify or prepare entry. */
const STEP_KEYS = new Set(['id', 'argv', 'cwd', 'timeout']);

function sameRepository(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * The supplied target as the proposal a person confirmed, with its id, or
 * why it cannot be one. Validated as saveTarget validates (targetError) and
 * as a harness's answer is validated (validateProposal).
 */
export function confirmedProposal(c: Pick<TargetSetupCommand, 'repo' | 'target_id' | 'target'>): { id: string; proposal: Proposal } | { error: string } {
  const t = c.target;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { error: 'confirm needs the proposed target' };
  for (const k of Object.keys(t)) if (!TARGET_KEYS.has(k)) return { error: `the target is not valid: unknown key ${JSON.stringify(k.slice(0, 40))}` };
  const err = targetError(t);
  if (err) return { error: `the target is not valid: ${err}` };
  const target = t as unknown as ExecutionTarget;
  if (!sameRepository(target.repo, c.repo)) return { error: `the target's repository ${target.repo} is not ${path.resolve(c.repo)}` };
  if (c.target_id && c.target_id !== target.id) return { error: `target_id ${c.target_id} does not match the target's id ${target.id}` };
  const verify = target.verify ?? [];
  const prepare = target.prepare ?? [];
  for (const [what, list] of [['verify', verify], ['prepare', prepare]] as const) {
    for (const s of list as unknown as Array<Record<string, unknown>>) {
      for (const k of Object.keys(s)) {
        if (!STEP_KEYS.has(k)) return { error: `${what} ${String(s.id)}: ${k.slice(0, 40)} cannot be set here; a confirmed target has only what was proposed (id, argv, cwd, timeout)` };
      }
    }
  }
  const strip = (s: { id: string; argv: string[]; cwd?: string }) => ({ id: s.id, argv: s.argv, ...(s.cwd !== undefined ? { cwd: s.cwd } : {}) });
  const v = validateProposal({ base: target.base ?? null, prepare: prepare.map(strip), verify: verify.map(strip) });
  if (!v.ok) return { error: `the target is not valid: ${v.error}` };
  // validateProposal keeps the order: each entry gets its own timeout back.
  const timed = (steps: ProposedStep[], from: Array<{ timeout: number }>): ProposedStep[] => steps.map((s, i) => ({ ...s, timeout: from[i].timeout }));
  return { id: target.id, proposal: { ...v.proposal, prepare: timed(v.proposal.prepare, prepare), verify: timed(v.proposal.verify, verify) } };
}

/**
 * Why the command cannot run, checked before anything runs (the link rejects
 * it at acceptance; the handler checks again), or null. Cheap: no harness, no
 * sandbox probe.
 */
export function targetSetupRefusal(c: TargetSetupCommand): string | null {
  const repo = path.resolve(c.repo);
  if (!fs.existsSync(repo)) return `${repo} does not exist on this host`;
  if (!fs.existsSync(path.join(repo, '.git'))) return `${repo} is not a git repository`;
  try {
    parseTargetSetupArgs(cliArgs(c, null));
  } catch (err) {
    return printable((err as Error).message.split('\n')[0], 300);
  }
  if (!c.confirm) return null;
  const r = confirmedProposal(c);
  return 'error' in r ? r.error : null;
}

/** The CLI flags the command means. */
function cliArgs(c: TargetSetupCommand, id: string | null): string[] {
  const tid = id ?? c.target_id;
  return [
    path.resolve(c.repo),
    '--json',
    ...(tid ? ['--id', tid] : []),
    ...(c.harness && !c.confirm ? ['--harness', c.harness] : []),
    ...(c.model && !c.confirm ? ['--model', c.model] : []),
    ...(c.confirm ? ['--yes'] : []),
  ];
}

export interface TargetSetupCommandDeps {
  /** The config dir (eridani.json). */
  dir: string;
  home?: string;
  /** The service environment (default process.env). */
  env?: NodeJS.ProcessEnv;
  probe?: ProbeFn;
  inspect?: InspectFn;
  runCheck?: CheckFn;
  /** Why the trial's sandbox cannot be used here, or null. Default: bwrap required, as the trial runs it (verify-sandbox.ts). */
  sandbox?: () => string | null;
  now?: () => number;
}

/** bwrap, required, with the PATH the trial runs with. */
function defaultSandbox(home: string, env: NodeJS.ProcessEnv): () => string | null {
  return () => {
    const plan = planIsolation({ id: 'trial', argv: ['true'], timeout: 1, isolation: 'bwrap' }, serviceEnv(home, env).env);
    return plan.refuse ? plan.reason ?? plan.refuse : null;
  };
}

function expiryMs(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The result with every text the host did not choose redacted: output tails, reasons, notes. */
export function scrubResult(r: TargetSetupResult): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(r)) as TargetSetupResult;
  out.checks = out.checks.map((c) => ({
    ...c,
    ...(c.tail !== undefined ? { tail: redact(c.tail) } : {}),
    ...(c.reason !== undefined ? { reason: redact(c.reason) } : {}),
    ...(c.why !== undefined ? { why: redact(c.why) } : {}),
  }));
  out.notes = out.notes.map((n) => redact(n));
  if (out.harness.fallback_reason !== undefined) out.harness.fallback_reason = redact(out.harness.fallback_reason);
  if (out.problems) out.problems = out.problems.map((p) => ({ ...p, reason: redact(p.reason) }));
  return out as unknown as Record<string, unknown>;
}

const discard = () => new Writable({ write: (_c, _e, cb) => cb() });

/**
 * Run one `target.setup`. The outcome to report, and the id of the target
 * it saved (null: nothing written), so the caller can send a new hello.
 * Never throws.
 */
export async function runTargetSetupCommand(c: TargetSetupCommand, d: TargetSetupCommandDeps): Promise<{ outcome: CommandResult; saved: string | null }> {
  const fail = (detail: string) => ({ outcome: { state: 'failed' as const, detail: printable(detail, 300) }, saved: null });
  const home = d.home ?? os.homedir();
  const env = d.env ?? process.env;
  const now = d.now ?? Date.now;
  try {
    const refusal = targetSetupRefusal(c);
    if (refusal) return fail(refusal);
    let confirmed: Proposal | undefined;
    let id: string | null = null;
    if (c.confirm) {
      const r = confirmedProposal(c);
      if ('error' in r) return fail(r.error);
      confirmed = r.proposal;
      id = r.id;
      if (confirmed.verify.length) {
        const why = (d.sandbox ?? defaultSandbox(home, env))();
        if (why) return fail(`the check cannot be tried: the verify sandbox is required and ${why}; nothing saved`);
      }
    }
    const o = { ...parseTargetSetupArgs(cliArgs(c, id)), ...(confirmed ? { confirmed } : {}) };
    const expires = expiryMs(c.expires_at);
    const save = (dir: string, target: ExecutionTarget): void => {
      if (expires !== null && now() > expires) throw new Error('the command expired while the checks ran; nothing saved');
      saveTarget(dir, target);
    };
    const { result } = await runTargetSetup(o, {
      dir: d.dir, out: discard(), prompt: noPrompter, home, env,
      ...(d.probe ? { probe: d.probe } : {}),
      ...(d.inspect ? { inspect: d.inspect } : {}),
      ...(d.runCheck ? { runCheck: d.runCheck } : {}),
      progress: () => {},
      save,
    });
    return { outcome: { state: 'executed', result: scrubResult(result) }, saved: result.saved ? result.target.id : null };
  } catch (err) {
    return fail(redact((err as Error)?.message ?? String(err)));
  }
}

/**
 * A `target.setup` found `executing` after a restart. A proposal writes
 * nothing: `failed`. A confirm saves last, so it may have saved: `uncertain`,
 * and the next hello lists this host's targets either way.
 */
export function recoverTargetSetup(body: Record<string, unknown> | undefined): { state: 'failed' | 'uncertain'; detail: string } {
  return body?.confirm === true
    ? { state: 'uncertain', detail: 'interrupted by a server restart: the target may have been saved; the next hello lists this host\'s targets' }
    : { state: 'failed', detail: 'interrupted by a server restart; nothing was written' };
}

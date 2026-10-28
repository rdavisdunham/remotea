/**
 * Execution targets (C09): where Eridani may start work on this machine.
 *
 * They live in `eridani.json` beside the link settings:
 *
 *   "targets": [{
 *     "id": "remotea",
 *     "repo": "/home/davin/remotea/remotea",
 *     "worktreeRoot": "/home/davin/remotea/worktrees",
 *     "base": "main",
 *     "launch": { "claude": {}, "codex": { "bin": "/home/davin/.local/bin/codex" } },
 *     "verify": [{ "id": "test", "argv": ["npm", "test"], "cwd": "remote-server", "timeout": 600 }]
 *   }]
 *
 * A spawn names a target by id; nothing Eridani sends becomes a path, a
 * program or an argument beyond what is configured here, apart from the model
 * name, the branch (both validated) and the prompt (passed as one argv word
 * through the environment, never parsed by a shell). `launch` lists the
 * harnesses this target may run; a harness absent from it is refused. The
 * trust boundary is stated plainly in docs/remotea/eridani-link.md: this is
 * policy against Eridani-originated text becoming commands, not a sandbox.
 *
 * Read from disk on every use, so `remotea eridani targets add` takes effect
 * at once and never restarts the link.
 */
import path from 'path';
import { readEridaniFile, writeEridaniFile } from './config';
import { BRANCH_RE } from '../../src/shared/eridani-link-protocol';

export interface LaunchSpec {
  /** The program: a bare name found on the login shell's PATH, or an absolute path. Default: the harness name. */
  bin?: string;
  /** Fixed extra arguments, after remotea's own. */
  args?: string[];
}

export interface VerifySpec {
  id: string;
  /** Run as-is, no shell. */
  argv: string[];
  /** Relative to the worktree; never outside it. */
  cwd?: string;
  /** Seconds. */
  timeout: number;
}

export interface ExecutionTarget {
  id: string;
  repo: string;
  worktreeRoot: string;
  /** The branch new worktrees start from when a spawn names none. */
  base: string;
  launch: { claude?: LaunchSpec; codex?: LaunchSpec };
  verify: VerifySpec[];
}

export const TARGET_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BIN_RE = /^(?:[A-Za-z0-9._+-]{1,64}|\/[^\0\n\r]{1,1023})$/;
const ARG_OK = (a: unknown): a is string => typeof a === 'string' && a.length > 0 && a.length <= 512 && !/[\0\r\n]/.test(a);

/** Validate one target; returns the problem, or null. */
export function targetError(t: unknown): string | null {
  if (!t || typeof t !== 'object') return 'not an object';
  const o = t as Record<string, unknown>;
  if (typeof o.id !== 'string' || !TARGET_ID_RE.test(o.id)) return 'id: letters, digits, . _ - (≤64)';
  for (const k of ['repo', 'worktreeRoot'] as const) {
    if (typeof o[k] !== 'string' || !path.isAbsolute(o[k] as string) || /[\0\r\n]/.test(o[k] as string)) return `${k}: an absolute path`;
  }
  if (path.resolve(o.worktreeRoot as string) === path.resolve(o.repo as string)) return 'worktreeRoot must not be the repository itself';
  if (o.base !== undefined && !(typeof o.base === 'string' && BRANCH_RE.test(o.base))) return 'base: a branch name';
  const launch = o.launch;
  if (!launch || typeof launch !== 'object') return 'launch: { claude?: {}, codex?: {} }';
  for (const [h, spec] of Object.entries(launch as Record<string, unknown>)) {
    if (h !== 'claude' && h !== 'codex') return `launch.${h}: only claude and codex`;
    if (!spec || typeof spec !== 'object') return `launch.${h}: an object`;
    const sp = spec as LaunchSpec;
    if (sp.bin !== undefined && !(typeof sp.bin === 'string' && BIN_RE.test(sp.bin))) return `launch.${h}.bin: a program name or absolute path`;
    if (sp.args !== undefined && !(Array.isArray(sp.args) && sp.args.length <= 16 && sp.args.every(ARG_OK))) return `launch.${h}.args: up to 16 one-line words`;
  }
  const verify = o.verify ?? [];
  if (!Array.isArray(verify)) return 'verify: a list';
  const ids = new Set<string>();
  for (const v of verify as unknown[]) {
    const vo = v as Record<string, unknown>;
    if (!vo || typeof vo.id !== 'string' || !TARGET_ID_RE.test(vo.id)) return 'verify[].id';
    if (ids.has(vo.id)) return `verify id ${vo.id} twice`;
    ids.add(vo.id);
    if (!Array.isArray(vo.argv) || !vo.argv.length || vo.argv.length > 64 || !vo.argv.every(ARG_OK)) return `verify ${vo.id}: argv`;
    if (vo.cwd !== undefined && !(typeof vo.cwd === 'string' && !path.isAbsolute(vo.cwd) && !vo.cwd.split(/[\\/]/).includes('..'))) return `verify ${vo.id}: cwd is relative to the worktree`;
    if (typeof vo.timeout !== 'number' || !(vo.timeout > 0 && vo.timeout <= 6 * 3600)) return `verify ${vo.id}: timeout in seconds (≤ 6 h)`;
  }
  return null;
}

function normalize(t: Record<string, unknown>): ExecutionTarget {
  return {
    id: t.id as string,
    repo: path.resolve(t.repo as string),
    worktreeRoot: path.resolve(t.worktreeRoot as string),
    base: typeof t.base === 'string' ? t.base : 'main',
    launch: t.launch as ExecutionTarget['launch'],
    verify: ((t.verify as VerifySpec[] | undefined) ?? []).map((v) => ({ id: v.id, argv: [...v.argv], ...(v.cwd ? { cwd: v.cwd } : {}), timeout: v.timeout })),
  };
}

/** The valid targets; an invalid entry is skipped and reported through `warn`. */
export function loadTargets(dir: string, warn?: (m: string) => void): ExecutionTarget[] {
  const raw = readEridaniFile(dir).targets;
  if (!Array.isArray(raw)) return [];
  const out: ExecutionTarget[] = [];
  for (const t of raw) {
    const err = targetError(t);
    if (err) {
      warn?.(`eridani.json: target ${JSON.stringify((t as { id?: unknown })?.id ?? '?')} ignored: ${err}`);
      continue;
    }
    if (out.some((o) => o.id === (t as { id: string }).id)) continue;
    out.push(normalize(t as Record<string, unknown>));
  }
  return out;
}

export function findTarget(dir: string, id: string, warn?: (m: string) => void): ExecutionTarget | null {
  return loadTargets(dir, warn).find((t) => t.id === id) ?? null;
}

/** Add or replace a target by id. Throws on an invalid target. */
export function saveTarget(dir: string, target: ExecutionTarget): void {
  const err = targetError(target);
  if (err) throw new Error(`invalid target: ${err}`);
  const file = readEridaniFile(dir);
  const list = Array.isArray(file.targets) ? (file.targets as Array<{ id?: unknown }>).filter((t) => t?.id !== target.id) : [];
  writeEridaniFile(dir, { ...file, targets: [...list, target] });
}

export function removeTarget(dir: string, id: string): boolean {
  const file = readEridaniFile(dir);
  if (!Array.isArray(file.targets)) return false;
  const list = (file.targets as Array<{ id?: unknown }>).filter((t) => t?.id !== id);
  if (list.length === file.targets.length) return false;
  writeEridaniFile(dir, { ...file, targets: list });
  return true;
}

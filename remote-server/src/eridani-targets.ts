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
 *     "verify": [{ "id": "test", "argv": ["npm", "test"], "cwd": "remote-server", "timeout": 600 }],
 *     "mcpKeyFile": "~/.config/remotea/eridani-mcp-token",
 *     "prepare": [{ "id": "deps", "argv": ["npm", "ci"], "cwd": "remote-server", "timeout": 600 }],
 *     "limits": { "maxRuns": 3, "minFreeMiB": 2048 }
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
 * A verify entry runs with a minimal environment (verify-runner.ts): PATH,
 * HOME, LANG, CI=1, TERM=dumb, plus only what its own `env` names, e.g.
 * `"env": { "NODE_OPTIONS": "--max-old-space-size=4096" }`. Nothing else
 * from the server's environment reaches it. Where bubblewrap works it also
 * runs in a sandbox (verify-sandbox.ts): `isolation`, `network`, `ports` and
 * `mounts` on the entry, e.g. `"network": "loopback", "ports": [5432]`.
 *
 * A target is a template (S-Q3): the repository, the harness launch, the
 * dependency preparation (`prepare`: fixed argv steps run in a new managed
 * worktree before the agent starts, target-template.ts), the verification
 * environment, migrations and resource `limits`, all defined once here. The
 * whole template is checked before hello advertises the target as ready
 * (target-template.ts templateStatus); `prepare` and `limits` are optional,
 * so a target without them behaves exactly as before.
 *
 * Read from disk on every use, so `remotea eridani targets add` takes effect
 * at once and never restarts the link.
 */
import path from 'path';
import { readEridaniFile, writeEridaniFile } from './config';
import { BRANCH_RE } from '../../src/shared/eridani-link-protocol';
import { keyFileSettingOk } from './eridani-mcp';

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
  /**
   * Seconds (optional, < timeout): Eridani's soft threshold for this entry. A verification still running this
   * long sends the owner one "still running" notice and keeps going up to `timeout`. hello sends it as
   * `notify_after_s`; absent, Eridani uses its own default (30 min).
   */
  notifyAfter?: number;
  /** Extra environment for the run (stage F): the base is minimal, so a test that needs a variable names it here. */
  env?: Record<string, string>;
  /**
   * S-N4, the trust choice: `bwrap` runs the command in a bubblewrap sandbox
   * (verify-sandbox.ts), `none` runs it as the server user. Absent: `bwrap`
   * when bwrap works on this host, else `none` (hello says so). An explicit
   * `bwrap` on a host without it refuses to run rather than run unsandboxed.
   */
  isolation?: 'bwrap' | 'none';
  /**
   * Inside the sandbox only. Absent or false: no network at all (a private
   * loopback the command can serve itself on). `"loopback"`: also the host's
   * 127.0.0.1 on the listed `ports` (a test database), nothing else. true: the
   * host's whole network, the internet included.
   */
  network?: boolean | 'loopback';
  /** With `network: "loopback"`: the host ports the sandbox may reach on 127.0.0.1. */
  ports?: number[];
  /** Inside the sandbox only: more paths mounted read-only (absolute or `~/…`), e.g. a uv-managed Python. */
  mounts?: string[];
}

/**
 * S-Q3: one dependency preparation step (`uv sync --locked`, `npm ci`), run
 * in a new managed worktree before the agent starts. Fixed argv, no shell,
 * the minimal verify environment (verifyEnv: PATH, HOME, LANG, CI=1,
 * TERM=dumb, plus `env`), as the server user with its network: preparation
 * installs dependencies, it does not run the agent's code.
 */
export interface PrepareSpec {
  id: string;
  argv: string[];
  /** Relative to the worktree; never outside it. */
  cwd?: string;
  /** Seconds (≤ 2 h). */
  timeout: number;
  env?: Record<string, string>;
}

/** S-Q3: resource limits a target sets for the work Eridani starts there. */
export interface LimitsSpec {
  /** At most this many live Eridani sessions on the target at once; one more spawn is rejected `target_busy`. */
  maxRuns?: number;
  /** Below this much free space (MiB) where the worktrees live, the target is not ready and spawns are rejected. */
  minFreeMiB?: number;
}

/** Where a target keeps numbered migrations (Alembic `NNNN_name.py`); Eridani reserves numbers only for targets with this. */
export interface MigrationsSpec {
  /** Relative to the repository root. */
  dir: string;
  /** File names whose first capture group is the number. Default `^(\d{4})_`. */
  pattern?: string;
}

export interface ExecutionTarget {
  id: string;
  repo: string;
  worktreeRoot: string;
  /** The branch new worktrees start from when a spawn names none. */
  base: string;
  launch: { claude?: LaunchSpec; codex?: LaunchSpec };
  verify: VerifySpec[];
  migrations?: MigrationsSpec;
  /**
   * The file holding the bot key a spawned agent uses for Eridani's MCP
   * server (eridani-mcp.ts): absolute, `~/…`, or relative to the config dir.
   * Default: eridani.json's `mcpKeyFile`, else `<config dir>/eridani-mcp-token`.
   */
  mcpKeyFile?: string;
  /** S-Q3: dependency preparation for a new managed worktree, in order; absent: none. */
  prepare?: PrepareSpec[];
  /** S-Q3: resource limits; absent: none. */
  limits?: LimitsSpec;
}

export const PREPARE_MAX_STEPS = 8;
export const PREPARE_MAX_TIMEOUT_S = 2 * 3600;

export const TARGET_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BIN_RE = /^(?:[A-Za-z0-9._+-]{1,64}|\/[^\0\n\r]{1,1023})$/;
const ARG_OK = (a: unknown): a is string => typeof a === 'string' && a.length > 0 && a.length <= 512 && !/[\0\r\n]/.test(a);

/** argv, cwd, timeout and env of a verify entry or a prepare step; returns the problem, or null. */
function commandError(what: string, vo: Record<string, unknown>, maxTimeout: number, maxLabel: string): string | null {
  if (!Array.isArray(vo.argv) || !vo.argv.length || vo.argv.length > 64 || !vo.argv.every(ARG_OK)) return `${what}: argv`;
  if (vo.cwd !== undefined && !(typeof vo.cwd === 'string' && !path.isAbsolute(vo.cwd) && !vo.cwd.split(/[\\/]/).includes('..'))) return `${what}: cwd is relative to the worktree`;
  if (typeof vo.timeout !== 'number' || !(vo.timeout > 0 && vo.timeout <= maxTimeout)) return `${what}: timeout in seconds (≤ ${maxLabel})`;
  if (vo.env !== undefined) {
    if (!vo.env || typeof vo.env !== 'object' || Array.isArray(vo.env) || Object.keys(vo.env).length > 32) return `${what}: env is an object`;
    for (const [k, val] of Object.entries(vo.env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || typeof val !== 'string' || val.length > 4096 || /[\0\r\n]/.test(val)) return `${what}: env ${k.slice(0, 40)}`;
    }
  }
  return null;
}

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
    const cmdErr = commandError(`verify ${vo.id}`, vo, 6 * 3600, '6 h');
    if (cmdErr) return cmdErr;
    if (vo.isolation !== undefined && vo.isolation !== 'bwrap' && vo.isolation !== 'none') return `verify ${vo.id}: isolation is "bwrap" or "none"`;
    if (vo.notifyAfter !== undefined && !(typeof vo.notifyAfter === 'number' && Number.isInteger(vo.notifyAfter) && vo.notifyAfter >= 60 && vo.notifyAfter < (vo.timeout as number))) return `verify ${vo.id}: notifyAfter in seconds (≥ 60, under its timeout)`;
    if (vo.network !== undefined && typeof vo.network !== 'boolean' && vo.network !== 'loopback') return `verify ${vo.id}: network is true, false or "loopback"`;
    if (vo.network === 'loopback') {
      if (!Array.isArray(vo.ports) || !vo.ports.length || vo.ports.length > 16 || !vo.ports.every((p) => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535)) return `verify ${vo.id}: network "loopback" needs ports (1 to 16 port numbers)`;
    } else if (vo.ports !== undefined) return `verify ${vo.id}: ports only with network "loopback"`;
    if (vo.mounts !== undefined) {
      if (!Array.isArray(vo.mounts) || vo.mounts.length > 32) return `verify ${vo.id}: mounts is a list of up to 32 paths`;
      for (const m of vo.mounts as unknown[]) {
        if (typeof m !== 'string' || m.length > 1024 || /[\0\r\n]/.test(m) || !(path.isAbsolute(m) || m.startsWith('~/')) || path.resolve(m.replace(/^~\//, '/x/')) === '/') return `verify ${vo.id}: mounts are absolute or ~/ paths, not /`;
      }
    }
  }
  if (o.mcpKeyFile !== undefined && !keyFileSettingOk(o.mcpKeyFile)) return 'mcpKeyFile: a path to the MCP key file';
  const mig = o.migrations;
  if (mig !== undefined) {
    if (!mig || typeof mig !== 'object' || Array.isArray(mig)) return 'migrations: { dir, pattern? }';
    const mo = mig as Record<string, unknown>;
    if (typeof mo.dir !== 'string' || !mo.dir || mo.dir.length > 200 || path.isAbsolute(mo.dir) || mo.dir.split(/[\\/]/).includes('..') || /[\0\r\n:]/.test(mo.dir)) return 'migrations.dir: a folder relative to the repository';
    if (mo.pattern !== undefined) {
      if (typeof mo.pattern !== 'string' || !mo.pattern || mo.pattern.length > 200) return 'migrations.pattern: a regular expression';
      try {
        new RegExp(mo.pattern);
      } catch {
        return 'migrations.pattern: not a valid regular expression';
      }
    }
  }
  const prepare = o.prepare;
  if (prepare !== undefined) {
    if (!Array.isArray(prepare) || prepare.length > PREPARE_MAX_STEPS) return `prepare: a list of up to ${PREPARE_MAX_STEPS} steps`;
    const pids = new Set<string>();
    for (const p of prepare as unknown[]) {
      const po = p as Record<string, unknown>;
      if (!po || typeof po.id !== 'string' || !TARGET_ID_RE.test(po.id)) return 'prepare[].id';
      if (pids.has(po.id)) return `prepare id ${po.id} twice`;
      pids.add(po.id);
      const cmdErr = commandError(`prepare ${po.id}`, po, PREPARE_MAX_TIMEOUT_S, '2 h');
      if (cmdErr) return cmdErr;
    }
  }
  const limits = o.limits;
  if (limits !== undefined) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return 'limits: { maxRuns?, minFreeMiB? }';
    const lo = limits as Record<string, unknown>;
    for (const k of Object.keys(lo)) if (k !== 'maxRuns' && k !== 'minFreeMiB') return `limits.${k.slice(0, 40)}: unknown (maxRuns, minFreeMiB)`;
    if (lo.maxRuns !== undefined && !(Number.isInteger(lo.maxRuns) && (lo.maxRuns as number) >= 1 && (lo.maxRuns as number) <= 64)) return 'limits.maxRuns: a whole number from 1 to 64';
    if (lo.minFreeMiB !== undefined && !(Number.isInteger(lo.minFreeMiB) && (lo.minFreeMiB as number) >= 1 && (lo.minFreeMiB as number) <= 1024 * 1024)) return 'limits.minFreeMiB: a whole number of MiB (1 to 1048576)';
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
    verify: ((t.verify as VerifySpec[] | undefined) ?? []).map((v) => ({
      id: v.id,
      argv: [...v.argv],
      ...(v.cwd ? { cwd: v.cwd } : {}),
      timeout: v.timeout,
      ...(v.notifyAfter !== undefined ? { notifyAfter: v.notifyAfter } : {}),
      ...(v.env ? { env: { ...v.env } } : {}),
      ...(v.isolation ? { isolation: v.isolation } : {}),
      ...(v.network !== undefined ? { network: v.network } : {}),
      ...(v.ports ? { ports: [...v.ports] } : {}),
      ...(v.mounts ? { mounts: [...v.mounts] } : {}),
    })),
    ...(typeof t.mcpKeyFile === 'string' ? { mcpKeyFile: t.mcpKeyFile } : {}),
    ...(Array.isArray(t.prepare) && t.prepare.length
      ? { prepare: (t.prepare as PrepareSpec[]).map((p) => ({ id: p.id, argv: [...p.argv], ...(p.cwd ? { cwd: p.cwd } : {}), timeout: p.timeout, ...(p.env ? { env: { ...p.env } } : {}) })) }
      : {}),
    ...(t.limits ? { limits: { ...(t.limits as LimitsSpec) } } : {}),
    ...(t.migrations ? { migrations: { dir: (t.migrations as MigrationsSpec).dir.replace(/\/+$/, ''), ...((t.migrations as MigrationsSpec).pattern ? { pattern: (t.migrations as MigrationsSpec).pattern } : {}) } } : {}),
  };
}

/** The valid targets; an invalid entry is skipped and reported through `warn`. */
export function loadTargets(dir: string, warn?: (m: string) => void): ExecutionTarget[] {
  const { targets, invalid } = readTargets(dir);
  for (const i of invalid) warn?.(`eridani.json: target ${JSON.stringify(i.id)} ignored: ${i.error}`);
  return targets;
}

/** An entry of eridani.json's `targets` that is never advertised, and why (doctor reports it). */
export interface InvalidTarget {
  /** The entry's id as written, or `?`. */
  id: string;
  error: string;
}

/** The valid targets, and the entries skipped as invalid. */
export function readTargets(dir: string): { targets: ExecutionTarget[]; invalid: InvalidTarget[] } {
  const raw = readEridaniFile(dir).targets;
  if (!Array.isArray(raw)) return { targets: [], invalid: [] };
  const out: ExecutionTarget[] = [];
  const invalid: InvalidTarget[] = [];
  for (const t of raw) {
    const err = targetError(t);
    if (err) {
      const id = (t as { id?: unknown })?.id;
      invalid.push({ id: typeof id === 'string' ? id.slice(0, 64) : '?', error: err });
      continue;
    }
    if (out.some((o) => o.id === (t as { id: string }).id)) continue;
    out.push(normalize(t as Record<string, unknown>));
  }
  return { targets: out, invalid };
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

/**
 * What hello advertises about harnesses and targets (S-S1, caps_version 2),
 * from the real launch environment rather than from what remotea's code
 * supports. Four separate facts:
 *
 *   protocol support   the link caps and each harness's observe/capture/
 *                      question/context/steer flags: what this build does.
 *   installed          `<bin> --version` answered when run exactly the way a
 *                      spawn runs it: the user's login shell, `-l -i -c`,
 *                      the session environment (pty-spawn.ts), from $HOME.
 *                      Probed once per distinct (harness, bin) when the link
 *                      starts; the server runs under systemd with a minimal
 *                      PATH, so a plain execFile proves nothing.
 *   target permission  a target's `launch` lists the harness (`enabled`).
 *                      `harnesses` is the subset whose launcher was probed
 *                      and works: what Eridani may spawn there. The host-wide
 *                      `spawn` flag is true only when some target has it.
 *   verification       each verify id, and whether its program resolves the
 *                      way verify-runner.ts runs it: no shell, the minimal
 *                      environment (verifyEnv), so the SERVICE's PATH (S-N3:
 *                      `uv` was not on it). The cwd is checked against the
 *                      repository, which every worktree is a checkout of.
 */
import { spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ERIDANI_LIMITS,
  type CapabilityMatrix,
  type HarnessCaps,
  type HarnessName,
  type HelloLaunch,
  type HelloTarget,
  type HelloVerifyStatus,
} from '../../src/shared/eridani-link-protocol';
import type { ExecutionTarget, LaunchSpec, VerifySpec } from './eridani-targets';
import { answerableKinds, type AdapterHooks } from './harness-adapters';
import { buildEnv, loginShell, shellArgs } from './pty-spawn';
import { verifyEnv } from './verify-runner';

export type SpawnHarness = 'claude' | 'codex';
export const SPAWN_HARNESSES: readonly SpawnHarness[] = ['claude', 'codex'];
/**
 * Harnesses hello describes without Eridani being able to start them: probed
 * by their bare name only (no target can launch them), so `installed` and
 * `version` are facts, and every control is off.
 */
export const OBSERVED_HARNESSES: readonly HarnessName[] = ['opencode'];
export type ProbeHarness = SpawnHarness | 'opencode';

export interface LauncherProbe {
  ok: boolean;
  version: string | null;
  error?: string;
  /** The executable the login shell runs (`command -v`, symlinks resolved); absent when it could not be named. */
  path?: string | null;
  /** Its mtime: with the version and path, what identifies the binary a conformance probe ran against. */
  mtime_ms?: number | null;
}

/** Probes one launcher: `bin` is a bare name or an absolute path, as in LaunchSpec. */
export type ProbeFn = (harness: ProbeHarness, bin: string) => Promise<LauncherProbe>;

/** The program a target's launch runs for a harness (launchCommand's rule). */
export function launcherBin(harness: SpawnHarness, spec: LaunchSpec | undefined): string {
  return spec?.bin ?? harness;
}

export const probeKey = (harness: ProbeHarness, bin: string): string => `${harness}\0${bin}`;

/** Every launcher to probe: each harness's bare name (observed-only ones too), plus every target's own `bin`. */
export function launchersToProbe(targets: ExecutionTarget[]): Array<{ harness: ProbeHarness; bin: string }> {
  const seen = new Map<string, { harness: ProbeHarness; bin: string }>();
  for (const harness of SPAWN_HARNESSES) seen.set(probeKey(harness, harness), { harness, bin: harness });
  for (const harness of OBSERVED_HARNESSES as ProbeHarness[]) seen.set(probeKey(harness, harness), { harness, bin: harness });
  for (const t of targets) {
    for (const harness of SPAWN_HARNESSES) {
      const spec = t.launch[harness];
      if (!spec) continue;
      const bin = launcherBin(harness, spec);
      seen.set(probeKey(harness, bin), { harness, bin });
    }
  }
  return [...seen.values()];
}

const MARKER = '__remotea_probe_7c1e__';
/** Between `command -v` and `--version`: a path can contain digits that look like a version. */
const MARKER_VERSION = '__remotea_probe_version_7c1e__';
const PROBE_MS = 20_000;
const VERSION_RE = /\d+\.\d+(?:\.\d+)?[\w.-]*/;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const clip = (s: string) => (s.length > ERIDANI_LIMITS.reasonChars ? `${s.slice(0, ERIDANI_LIMITS.reasonChars - 1)}…` : s);

export interface ProbeOptions {
  /** Default: loginShell() with shellArgs (`-l -i -c`), as every session. */
  shell?: string;
  args?: (cmd: string) => string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * `<bin> --version` through the login shell with a session's environment.
 * Whatever the profile prints comes before the marker and is ignored; the
 * shell's exit status is the program's (127: not found).
 */
export function probeLauncher(bin: string, o: ProbeOptions = {}): Promise<LauncherProbe> {
  return new Promise((resolve) => {
    const cmd = `printf '\\n%s\\n' ${MARKER}; command -v ${q(bin)}; printf '\\n%s\\n' ${MARKER_VERSION}; ${q(bin)} --version`;
    const env = o.env ?? buildEnv('probe', undefined);
    // Not a session: nothing the probe starts may report as one.
    delete env.REMOTEA_SESSION;
    let out = '';
    let settled = false;
    const done = (r: LauncherProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r.error ? { ...r, error: clip(r.error) } : r);
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(o.shell ?? loginShell(), (o.args ?? shellArgs)(cmd), {
        cwd: o.cwd ?? os.homedir(),
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, version: null, error: `cannot start the login shell: ${(err as Error).message}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      done({ ok: false, version: null, error: `\`${bin} --version\` did not answer within ${Math.round((o.timeoutMs ?? PROBE_MS) / 1000)} s` });
    }, o.timeoutMs ?? PROBE_MS);
    timer.unref?.();
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 64 * 1024) out += d.toString('utf8');
    });
    child.on('error', (err) => done({ ok: false, version: null, error: `cannot start the login shell: ${err.message}` }));
    child.on('close', (code) => {
      const at = out.lastIndexOf(MARKER);
      const vat = out.lastIndexOf(MARKER_VERSION);
      const after = vat >= 0 ? out.slice(vat + MARKER_VERSION.length) : '';
      const m = after.match(VERSION_RE);
      const version = m ? m[0].slice(0, 40) : null;
      if (code === 0) done({ ok: true, version, ...binaryIdentity(at >= 0 && vat > at ? out.slice(at + MARKER.length, vat) : '') });
      else if (at < 0) done({ ok: false, version: null, error: `the login shell failed before running \`${bin}\` (exit ${code})` });
      else if (code === 127) done({ ok: false, version: null, error: path.isAbsolute(bin) ? `\`${bin}\` does not exist` : `\`${bin}\` is not on the login shell's PATH` });
      else if (code === 126) done({ ok: false, version: null, error: `\`${bin}\` is not executable` });
      else done({ ok: false, version: null, error: `\`${bin} --version\` exited ${code}` });
    });
  });
}

/** `command -v` printed an absolute path (not an alias or a function): resolve it and read its mtime. */
function binaryIdentity(commandV: string): { path: string; mtime_ms: number } | Record<string, never> {
  const line = commandV.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/'));
  if (!line) return {};
  try {
    const real = fs.realpathSync(line);
    return { path: real, mtime_ms: Math.round(fs.statSync(real).mtimeMs) };
  } catch {
    return {};
  }
}

export const defaultProbe: ProbeFn = (_harness, bin) => probeLauncher(bin);

const NOT_PROBED: LauncherProbe = { ok: false, version: null, error: 'not probed yet' };

/** No question hook is known to be wired: nothing is answerable. */
export const NO_ADAPTER_HOOKS: AdapterHooks = Object.freeze({ claudeAsk: false, codexApproval: false });

/**
 * What remotea's code supports per harness (protocol support). `question` is
 * true only for the kinds whose adapter was verified on this version and whose
 * hook is wired (harness-adapters.ts).
 */
function supported(harness: SpawnHarness, version: string | null, hooks: AdapterHooks): Omit<HarnessCaps, 'version'> {
  const kinds = answerableKinds(harness, version, hooks);
  const base = { observe: true, capture: true, question: kinds.length > 0, question_kinds: kinds, context: true, resume: true, steer: 'interrupt' as const, loop: true };
  return harness === 'claude'
    ? { ...base, permission: 'capture', launch_flags: ['--permission-mode', 'auto'] }
    : { ...base, permission: kinds.includes('approval') ? 'answer' : 'capture', launch_flags: ['--disable', 'daemon_auto_start'] };
}

/**
 * OpenCode (1.17.20 checked): the wmux plugin reports its status (observe),
 * nothing else is wired. No final-response capture (the plugin sends no Stop
 * text), no context, no questions (its question/permission events reach the
 * plugin, but no session of it is ever bound to a run), no resume, no spawn.
 */
function observedOnly(): Omit<HarnessCaps, 'version'> {
  return { observe: true, capture: false, question: false, question_kinds: [], context: false, resume: false, loop: false, permission: 'capture', spawn: false };
}

/**
 * The host-wide matrix: `installed` when any launcher of the harness
 * answered, `version` from the bare name's probe first, `spawn` only when a
 * target that enables the harness has a working launcher.
 */
export function harnessMatrix(probes: ReadonlyMap<string, LauncherProbe>, targets: ExecutionTarget[], hooks: AdapterHooks = NO_ADAPTER_HOOKS): CapabilityMatrix {
  const out: CapabilityMatrix = {};
  for (const harness of SPAWN_HARNESSES) {
    const bare = probes.get(probeKey(harness, harness)) ?? NOT_PROBED;
    const enabled = targets.filter((t) => t.launch[harness]).map((t) => probes.get(probeKey(harness, launcherBin(harness, t.launch[harness]))) ?? NOT_PROBED);
    const all = [bare, ...[...probes.entries()].filter(([k]) => k.startsWith(`${harness}\0`)).map(([, p]) => p)];
    const working = all.find((p) => p.ok);
    const installed = !!working;
    const version = (bare.ok ? bare.version : null) ?? working?.version ?? null;
    out[harness] = {
      version,
      ...supported(harness, version, hooks),
      spawn: enabled.some((p) => p.ok),
      installed,
      ...(installed ? {} : { launch_error: bare.error ?? 'not installed' }),
    };
  }
  for (const harness of OBSERVED_HARNESSES) {
    const bare = probes.get(probeKey(harness as ProbeHarness, harness)) ?? NOT_PROBED;
    out[harness] = {
      version: bare.ok ? bare.version : null,
      ...observedOnly(),
      installed: bare.ok,
      ...(bare.ok ? {} : { launch_error: bare.error ?? 'not installed' }),
    };
  }
  return out;
}

export interface VerifyCheckOptions {
  /** The service's environment (verifyEnv's `from`). */
  env?: NodeJS.ProcessEnv;
}

function executable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Would verify-runner find this entry's program and folder? Checked against the repository. Carries the entry's
 * timeout (`timeout_s`), which Eridani's verify deadline follows, and its soft threshold (`notify_after_s`, when set).
 */
export function verifyStatus(repo: string, spec: VerifySpec, o: VerifyCheckOptions = {}): HelloVerifyStatus {
  return { ...verifyReadiness(repo, spec, o), timeout_s: spec.timeout, ...(spec.notifyAfter !== undefined ? { notify_after_s: spec.notifyAfter } : {}) };
}

function verifyReadiness(repo: string, spec: VerifySpec, o: VerifyCheckOptions): HelloVerifyStatus {
  const cwd = spec.cwd ? path.resolve(repo, spec.cwd) : repo;
  try {
    if (!fs.statSync(cwd).isDirectory()) return { id: spec.id, ready: false, reason: 'its cwd is not a folder in the repository' };
  } catch {
    return { id: spec.id, ready: false, reason: 'its cwd does not exist in the repository' };
  }
  const prog = spec.argv[0];
  if (path.isAbsolute(prog)) {
    return executable(prog) ? { id: spec.id, ready: true } : { id: spec.id, ready: false, reason: 'its program does not exist or is not executable' };
  }
  if (prog.includes('/')) {
    // Relative to the run's cwd; tracked in the repository, so the checkout's copy stands in for the worktree's.
    return executable(path.resolve(cwd, prog)) ? { id: spec.id, ready: true } : { id: spec.id, ready: false, reason: 'its program does not exist in the repository or is not executable' };
  }
  const PATH = verifyEnv(spec, o.env ?? process.env).PATH ?? '';
  for (const d of PATH.split(':')) {
    if (d && executable(path.join(path.isAbsolute(d) ? d : path.resolve(cwd, d), prog))) return { id: spec.id, ready: true };
  }
  return { id: spec.id, ready: false, reason: 'its program is not on the service PATH (use an absolute path or set PATH in the entry\'s env)' };
}

/** The targets as hello lists them: ids, repos, permission, probed launchers and verify readiness; never argv or env. */
export function helloTargets(targets: ExecutionTarget[], probes: ReadonlyMap<string, LauncherProbe>, o: VerifyCheckOptions = {}): HelloTarget[] {
  return targets.map((t) => {
    const enabled = SPAWN_HARNESSES.filter((h) => !!t.launch[h]);
    const launch: Partial<Record<SpawnHarness, HelloLaunch>> = {};
    for (const h of enabled) {
      const p = probes.get(probeKey(h, launcherBin(h, t.launch[h]))) ?? NOT_PROBED;
      launch[h] = { ready: p.ok, version: p.version, ...(p.ok || !p.error ? {} : { error: p.error }) };
    }
    return {
      id: t.id,
      repo: t.repo,
      worktree_root: t.worktreeRoot,
      harnesses: enabled.filter((h) => launch[h]!.ready),
      enabled,
      launch,
      verify: t.verify.map((v) => v.id),
      verify_status: t.verify.map((v) => verifyStatus(t.repo, v, o)),
      ...(t.migrations ? { migrations: { ...t.migrations } } : {}),
    };
  });
}

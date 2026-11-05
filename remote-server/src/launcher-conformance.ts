/**
 * Which installed launcher may run managed (structured-transport) sessions.
 *
 * Claude Code updates itself about twice a day, so a fixed version range
 * turned managed runs off on every update until someone edited a number.
 * Instead, every version at or above the harness's floor is unverified until
 * a conformance probe (launcher-conformance-probe.ts) has driven the real
 * binary through every flag, control message, hook and receipt the runtime
 * adapter (managed-harness.ts) relies on. A pass admits that exact binary; a
 * failure keeps it out and says which step failed.
 *
 *   floor        below it: refused, never probed (MANAGED_FLOOR, with why).
 *   block list   REMOTEA_MANAGED_<HARNESS>_BLOCK=<v>[,<v>…]: refused, never probed.
 *   force list   REMOTEA_MANAGED_<HARNESS>_FORCE=<v>[,<v>…]: admitted without a probe (logged).
 *   otherwise    the recorded probe of this binary (version, resolved path and
 *                mtime) decides; none yet, or the binary changed: probe it.
 *
 * Results live in `<config dir>/launcher-conformance.json`, shared with
 * `remotea launcher probe`, which re-probes on demand. Passes are kept until
 * the binary changes; a failure is retried after RETRY_FAILED_MS (a slow
 * machine can time a step out) or at once by the CLI.
 */
import fs from 'fs';
import path from 'path';
import { parseVersion } from './harness-adapters';
import type { LauncherProbe } from './launch-caps';
import type { LaunchConformance } from '../../src/shared/eridani-link-protocol';

export type ManagedHarness = 'claude' | 'codex';
export const MANAGED_HARNESSES: readonly ManagedHarness[] = ['claude', 'codex'];

/**
 * The oldest versions the adapters can work with at all; no probe can admit
 * anything older.
 *   claude 2.1.312: the stage A spike (spike-stage-a/capability-matrix.md): the
 *     first version whose PreToolUse hook accepts `permissionDecision: "defer"`
 *     and reports `tool_deferred`, which managed questions are built on.
 *   codex 0.166.0: the app-server protocol the adapter speaks (`turn/steer`
 *     with `expectedTurnId`, `clientUserMessageId`, `approvalsReviewer`,
 *     `model/list`) was generated and verified on 0.166.0; nothing older was.
 */
export const MANAGED_FLOOR: Readonly<Record<ManagedHarness, string>> = Object.freeze({ claude: '2.1.312', codex: '0.166.0' });

export const CONFORMANCE_FILE = 'launcher-conformance.json';
const FILE_VERSION = 1;
/** A failed probe of an unchanged binary is tried again after this long. */
export const RETRY_FAILED_MS = 60 * 60_000;

export type StepStatus = 'pass' | 'fail' | 'skipped';
export interface ConformanceStep {
  id: string;
  status: StepStatus;
  ms: number;
  /** Why it failed or was skipped, or a note on a pass; never provider output. */
  message?: string;
}

/** The binary a probe ran against. */
export interface LauncherIdentity {
  version: string | null;
  /** The resolved executable (symlinks followed), when the login shell could name it. */
  path: string | null;
  mtime_ms: number | null;
}

export interface ConformanceRecord extends LauncherIdentity {
  harness: ManagedHarness;
  /** The launcher as targets name it (a bare name or an absolute path). */
  bin: string;
  outcome: 'pass' | 'fail';
  steps: ConformanceStep[];
  failed_step?: string;
  message?: string;
  /** ISO time the probe finished. */
  at: string;
  duration_ms: number;
  /** `remotea launcher probe` or the server. */
  by: 'server' | 'cli';
}

interface ConformanceFile {
  version: number;
  records: Record<string, ConformanceRecord>;
}

/** What hello says about one launcher's managed support (HarnessCaps and HelloLaunch carry these fields). */
export interface Admission {
  managed: boolean;
  conformance: LaunchConformance;
  launcher_version: string | null;
  conformance_step?: string;
  conformance_message?: string;
  conformance_at?: string;
}

export const recordKey = (harness: ManagedHarness, bin: string): string => `${harness}\0${bin}`;

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** `REMOTEA_MANAGED_CLAUDE_FORCE` / `…_BLOCK`: comma or space separated versions (`2.1.320` or `2.1.320 (Claude Code)`). */
export function versionList(env: NodeJS.ProcessEnv, harness: ManagedHarness, kind: 'FORCE' | 'BLOCK'): number[][] {
  const raw = env[`REMOTEA_MANAGED_${harness.toUpperCase()}_${kind}`] ?? '';
  return raw.split(/[,\s]+/).map((v) => parseVersion(v.trim())).filter((v): v is number[] => !!v);
}

const listed = (list: number[][], v: number[]): boolean => list.some((x) => cmp(x, v) === 0);

/**
 * What the floor, the platform and the overrides decide without a probe;
 * null: it takes a conformance probe.
 */
export function precheck(harness: ManagedHarness, version: string | null, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Admission | null {
  const base = { managed: false, launcher_version: version };
  if (platform !== 'linux') return { ...base, conformance: 'unsupported', conformance_message: 'managed runs need the Linux host' };
  const v = parseVersion(version);
  if (!v) return { ...base, conformance: 'unsupported', conformance_message: version ? `cannot read the version "${version}"` : 'the launcher did not report a version' };
  if (cmp(v, parseVersion(MANAGED_FLOOR[harness])!) < 0) return { ...base, conformance: 'below_floor', conformance_message: `${harness} ${v.join('.')} is older than ${MANAGED_FLOOR[harness]}, the oldest version managed runs support` };
  if (listed(versionList(env, harness, 'BLOCK'), v)) return { ...base, conformance: 'blocked', conformance_message: `${harness} ${v.join('.')} is on REMOTEA_MANAGED_${harness.toUpperCase()}_BLOCK` };
  if (listed(versionList(env, harness, 'FORCE'), v)) return { managed: true, launcher_version: version, conformance: 'forced', conformance_message: `admitted without a probe by REMOTEA_MANAGED_${harness.toUpperCase()}_FORCE` };
  return null;
}

/** The same binary: version, resolved path and mtime all unchanged (a missing path or mtime compares by version alone). */
export function sameBinary(a: LauncherIdentity, b: LauncherIdentity): boolean {
  if (a.version !== b.version) return false;
  if (a.path && b.path && a.path !== b.path) return false;
  if (a.mtime_ms != null && b.mtime_ms != null && a.mtime_ms !== b.mtime_ms) return false;
  return (a.path === null) === (b.path === null) && (a.mtime_ms === null) === (b.mtime_ms === null);
}

/** What a finished record says, for hello. */
export function recordAdmission(r: ConformanceRecord): Admission {
  return r.outcome === 'pass'
    ? { managed: true, conformance: 'verified', launcher_version: r.version, conformance_at: r.at }
    : { managed: false, conformance: 'failed', launcher_version: r.version, conformance_at: r.at, ...(r.failed_step ? { conformance_step: r.failed_step } : {}), ...(r.message ? { conformance_message: r.message } : {}) };
}

export function summarize(harness: ManagedHarness, bin: string, id: LauncherIdentity, steps: ConformanceStep[], started: number, now: number, by: ConformanceRecord['by']): ConformanceRecord {
  const failed = steps.find((s) => s.status === 'fail');
  return {
    harness, bin, ...id,
    outcome: failed ? 'fail' : 'pass',
    steps,
    ...(failed ? { failed_step: failed.id, ...(failed.message ? { message: failed.message } : {}) } : {}),
    at: new Date(now).toISOString(),
    duration_ms: now - started,
    by,
  };
}

export function readRecords(file: string): Record<string, ConformanceRecord> {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as ConformanceFile;
    if (data?.version !== FILE_VERSION || typeof data.records !== 'object' || !data.records) return {};
    const out: Record<string, ConformanceRecord> = {};
    for (const [k, r] of Object.entries(data.records)) if (r && (r.harness === 'claude' || r.harness === 'codex') && typeof r.bin === 'string' && (r.outcome === 'pass' || r.outcome === 'fail') && Array.isArray(r.steps)) out[k] = r;
    return out;
  } catch {
    return {};
  }
}

/** Merge one record into the file (re-read first: the CLI and the server both write it). Atomic. */
export function writeRecord(file: string, record: ConformanceRecord): void {
  const records = readRecords(file);
  records[recordKey(record.harness, record.bin)] = record;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, records } satisfies ConformanceFile, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Runs the probe against one binary; resolves with every step (a failure is a step, never a throw). */
export type ConformanceRunner = (harness: ManagedHarness, bin: string) => Promise<ConformanceStep[]>;

export interface LauncherConformanceDeps {
  /** The config dir; the record file lives in it. */
  dir: string;
  run: ConformanceRunner;
  log: (msg: string) => void;
  /** A probe finished (a new record): hello should be sent again. */
  onSettled?: (harness: ManagedHarness, bin: string, admission: Admission) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  retryFailedMs?: number;
}

/** The server's view: records from the file, probes in flight, and the admission hello reports. */
export class LauncherConformance {
  readonly file: string;
  private records: Record<string, ConformanceRecord>;
  private fileStamp = '';
  private readonly running = new Map<string, Promise<Admission>>();
  /** Forced versions already logged, so a force is said once per version. */
  private readonly forcedLogged = new Set<string>();

  constructor(private readonly deps: LauncherConformanceDeps) {
    this.file = path.join(deps.dir, CONFORMANCE_FILE);
    this.records = {};
    this.reload();
  }

  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }
  private get platform(): NodeJS.Platform { return this.deps.platform ?? process.platform; }
  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Re-read the file when it changed on disk (`remotea launcher probe` wrote it). True when it did. */
  reload(): boolean {
    let stamp = '';
    try { const st = fs.statSync(this.file); stamp = `${st.mtimeMs}:${st.size}`; } catch { stamp = ''; }
    if (stamp === this.fileStamp) return false;
    this.fileStamp = stamp;
    this.records = readRecords(this.file);
    return true;
  }

  record(harness: ManagedHarness, bin: string): ConformanceRecord | undefined {
    return this.records[recordKey(harness, bin)];
  }

  /** Probing this launcher right now. */
  probing(harness: ManagedHarness, bin: string): boolean {
    return this.running.has(recordKey(harness, bin));
  }

  /** What hello reports for this launcher now. Never starts a probe. */
  admission(harness: ManagedHarness, bin: string, probe: LauncherProbe | undefined): Admission {
    if (!probe?.ok) return { managed: false, conformance: 'unverified', launcher_version: probe?.version ?? null, ...(probe?.error ? { conformance_message: probe.error } : {}) };
    const pre = precheck(harness, probe.version, this.env, this.platform);
    if (pre) return pre;
    if (this.probing(harness, bin)) return { managed: false, conformance: 'probing', launcher_version: probe.version };
    const r = this.record(harness, bin);
    if (r && sameBinary(r, identityOf(probe))) return recordAdmission(r);
    return { managed: false, conformance: 'unverified', launcher_version: probe.version, conformance_message: 'not probed yet' };
  }

  /** Whether a probe is due: no record of this exact binary, or a failure older than the retry interval. */
  due(harness: ManagedHarness, bin: string, probe: LauncherProbe): boolean {
    if (!probe.ok || precheck(harness, probe.version, this.env, this.platform)) return false;
    const r = this.record(harness, bin);
    if (!r || !sameBinary(r, identityOf(probe))) return true;
    return r.outcome === 'fail' && this.now() - Date.parse(r.at) >= (this.deps.retryFailedMs ?? RETRY_FAILED_MS);
  }

  /**
   * After a `--version` probe: probe conformance when due (one at a time per
   * launcher) and resolve with the admission once settled. `force` probes
   * even an unchanged binary (the CLI's re-probe).
   */
  ensure(harness: ManagedHarness, bin: string, probe: LauncherProbe, o: { force?: boolean } = {}): Promise<Admission> {
    const key = recordKey(harness, bin);
    const running = this.running.get(key);
    if (running) return running;
    this.reload();
    const pre = probe.ok ? precheck(harness, probe.version, this.env, this.platform) : null;
    if (pre?.conformance === 'forced' && !this.forcedLogged.has(`${key}\0${probe.version}`)) {
      this.forcedLogged.add(`${key}\0${probe.version}`);
      this.deps.log(`launcher conformance: ${harness} \`${bin}\` ${probe.version} admitted for managed runs WITHOUT a probe (REMOTEA_MANAGED_${harness.toUpperCase()}_FORCE)`);
    }
    if (!probe.ok || pre || (!o.force && !this.due(harness, bin, probe))) return Promise.resolve(this.admission(harness, bin, probe));
    const started = this.now();
    this.deps.log(`launcher conformance: probing ${harness} \`${bin}\` ${probe.version}`);
    const p = (async () => {
      let steps: ConformanceStep[];
      try {
        steps = await this.deps.run(harness, bin);
      } catch (err) {
        steps = [{ id: 'probe', status: 'fail', ms: this.now() - started, message: (err as Error).message.slice(0, 300) }];
      }
      const record = summarize(harness, bin, identityOf(probe), steps, started, this.now(), 'server');
      this.records[key] = record;
      try {
        writeRecord(this.file, record);
        this.reload();
      } catch (err) {
        this.deps.log(`launcher conformance: cannot write ${this.file}: ${(err as Error).message}`);
      }
      this.deps.log(`launcher conformance: ${harness} ${probe.version} ${record.outcome === 'pass' ? 'verified' : `FAILED at ${record.failed_step}: ${record.message ?? ''}`} (${steps.map((s) => `${s.id} ${s.status}`).join(', ')}; ${Math.round(record.duration_ms / 1000)} s)`);
      return record;
    })();
    const settled = p.then((record) => {
      this.running.delete(key);
      const admission = recordAdmission(record);
      this.deps.onSettled?.(harness, bin, admission);
      return admission;
    });
    this.running.set(key, settled);
    return settled;
  }
}

export function identityOf(probe: Pick<LauncherProbe, 'version' | 'path' | 'mtime_ms'>): LauncherIdentity {
  return { version: probe.version, path: probe.path ?? null, mtime_ms: probe.mtime_ms ?? null };
}

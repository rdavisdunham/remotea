/**
 * The Eridani side of the running server: owns the link (eridani-link.ts) and
 * the collector (collector/), plugs both into the hub, and follows the config.
 *
 *   - The link exists only while `eridani.json` says `enabled` and a key is on
 *     disk. Both files are checked every 30 s (mtime + size), so
 *     `remotea eridani connect|disconnect` take effect without a restart.
 *   - The collector runs on the link: a full scan when the link becomes ready
 *     and every 2 min, `scanOne` after each captured turn, and nothing while
 *     the outbox is over 80% full (the spool is for live events first).
 *   - A collector fingerprint advances only when Eridani acks the report
 *     (onDelivered); an evicted report marks its entity dirty and is re-read.
 *   - Collector mode (stage E): `parity` reports are compared by Eridani,
 *     `authoritative` ones are stored. Each mode keeps its own fingerprints
 *     (COLLECTOR_STATE_FILES), so nothing acked as a comparison ever counts as
 *     stored: the first authoritative scan sends every source once. Only an ack
 *     for a report of the CURRENT mode advances a fingerprint, and in
 *     authoritative mode a report Eridani refuses is forgotten so the next
 *     scan sends it again (collector.py's rule: no fingerprint without a store).
 *   - `remotea eridani collect` drops a request file; it is picked up on the
 *     same 30 s tick.
 *   - Stage C: Eridani's commands (dispatch.ts), held Claude questions
 *     (questions-claude.ts) and SessionStart context (context.ts) live here
 *     for the server's whole life, link or no link: a restart resumes
 *     Eridani's sessions even when the link is off. Commands accepted before
 *     a restart are replayed once Eridani's `runs.snapshot` is applied (or
 *     10 s after the link is ready without one), so their fences see the
 *     reconciled state.
 *   - `worktrees.scan` (the judge's PR evidence): a fresh worktrees.report
 *     and the named session's session.report, both sent even when nothing
 *     changed, then `executed`. Journaled like every command; its fence is
 *     informational (a stale scan is harmless), only `expires_at` is enforced.
 *   - `ci.status` (GitHub CI as the run's final verification): `gh pr view`,
 *     `gh pr checks` and failed-job log tails (redacted) for the run's branch,
 *     plus the worktree's HEAD, read with this host's `gh` (ci-status.ts).
 *   - `pr.merge` / `pr.update_branch` (Eridani's Merge and Update branch):
 *     `gh pr merge --match-head-commit` and GitHub's update-branch API, with
 *     this host's `gh` (pr-actions.ts). Journaled; a restart mid-way reports
 *     `uncertain` and Eridani reads the pull request again.
 *   - `terminal.focus` (Eridani's "Open terminal in remotea"): the hub asks
 *     every connected app that understands `focus` to bring the run's tab to
 *     the front. `executed` when at least one app was told, `rejected`
 *     `no_desktop` when none was, `unknown_surf` when the surface is gone.
 *   - What hello advertises comes from the launch environment (S-S1,
 *     launch-caps.ts): every launcher is probed through the login shell
 *     before the link first starts (later starts reuse the last results and
 *     refresh them for the next hello), so `spawn` is never claimed for a
 *     harness that would not start. hello also carries the build (S-S5).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { hostModelCatalog, claudeModelCatalog, codexModelCatalog } from './managed-models';
import { LauncherConformance, MANAGED_HARNESSES, type Admission, type ConformanceRunner, type ManagedHarness } from './launcher-conformance';
import { defaultConformanceRunner } from './launcher-conformance-probe';
import {
  ERIDANI_CAPS_VERSION,
  ERIDANI_LIMITS,
  ERIDANI_TIMING,
  STAGE_F_AUTHORITATIVE_CAPS,
  STAGE_F_CAPS,
  type CapabilityMatrix,
  type CommandBody,
  type DoctorSummary,
  type HarnessCaps,
  type LinkCap,
  type TerminalFocusCommand,
  type WorktreeReport,
  type WorktreesScanCommand,
  type CiStatusCommand,
  type PrMergeCommand,
  type PrUpdateBranchCommand,
} from '../../src/shared/eridani-link-protocol';
import {
  ERIDANI_COLLECT_REQUEST,
  eridaniConfigStamp,
  linkUrlError,
  loadEridaniConfig,
  resolveWebUrl,
  readEridaniToken,
  type CollectorMode,
  type EridaniConfig,
} from './config';
import { EridaniLink, type CommandContext, type CommandResult, type EridaniLinkDeps } from './eridani-link';
import type { Hub } from './hub';
import type { Registry } from './registry';
import { Collector } from './collector/collector';
import { COLLECTOR_STATE_FILES as STATE_FILES, CollectorState } from './collector/state';
import { statusFromRegistry } from './collector/report';
import { Dispatch, type DispatchTimers } from './dispatch';
import { QuestionBroker } from './questions-claude';
import { ContextService } from './context';
import { sameWorktreeState, WorktreeManager, worktreeStateOf, writersByPath } from './worktrees';
import { loadTargets } from './eridani-targets';
import { ciFolder, ciStatus, CiStatusError, type Exec } from './ci-status';
import { prMerge, prUpdateBranch } from './pr-actions';
import { branchDir } from './worktrees';
import { mcpStatus, resolveMcp } from './eridani-mcp';
import { withIsolation } from './verify-sandbox';
import { runPrepare, templateStatus, withTemplate } from './target-template';
import type { HelloTarget } from '../../src/shared/eridani-link-protocol';
import { defaultProbe, harnessMatrix, helloTargets, launchersToProbe, probeKey, type LauncherProbe, type ProbeFn, type ProbeHarness } from './launch-caps';
import { hookVersion, loadBuildInfo, readServerInfo, type BuildInfo } from './build-info';
import { doctorSummary, runDoctor, type GatherOptions } from './doctor';
import type { CollectorLinkStatus } from './eridani-link';
import { adapterHooks, defaultHookPaths } from './hooks-install';
import type { AdapterHooks } from './harness-adapters';

/** Delivered fingerprints per mode (defined beside CollectorState, so `remotea doctor` reads them without this module). */
export { COLLECTOR_STATE_FILE, COLLECTOR_STATE_FILES } from './collector/state';
/** collector.py's Windows side. */
export const WINDOWS_USERS = '/mnt/c/Users';
const CHECK_MS = 30_000;
const SCAN_MS = 2 * 60_000;
const MAX_FILL_FOR_SCAN = 0.8;
/** How long after ready to wait for runs.snapshot before replaying accepted commands anyway. */
const REPLAY_FALLBACK_MS = 10_000;
const WORKTREES_ENTITY = 'worktrees';
/** Launchers are probed again this often (an install or an upgrade shows in the next hello); a new target's bin on the next check. */
const PROBE_REFRESH_MS = 10 * 60_000;

export interface EridaniRuntimeDeps {
  dir: string;
  hub: Hub;
  registry: Registry;
  serverId: string;
  bootId: string;
  hostname: string;
  version: string;
  log: (msg: string) => void;
  /** Tests: replace the link's socket and timers. */
  linkOverrides?: Partial<EridaniLinkDeps>;
  /** Tests: where the collector reads sessions from. */
  collectorHome?: string;
  windowsUsers?: string | null;
  checkMs?: number;
  scanMs?: number;
  resumeAgents?: boolean;
  /** Tests: dispatch timing. */
  dispatchTiming?: ConstructorParameters<typeof Dispatch>[0]['timing'];
  questionHoldMs?: number;
  contextMs?: number;
  /** Tests: how a launcher is probed (default: `<bin> --version` through the login shell). */
  probe?: ProbeFn;
  /**
   * Tests: the managed-run conformance probe (default: the real one, launcher-conformance-probe.ts; with an
   * injected `probe` and no runner, every probe fails, so a test never starts a real harness).
   */
  conformanceRunner?: ConformanceRunner;
  /** Tests: the environment REMOTEA_MANAGED_<HARNESS>_FORCE / _BLOCK are read from (default process.env). */
  conformanceEnv?: NodeJS.ProcessEnv;
  /** Tests: whether each question adapter's hook is wired (default: read the agents' settings, hooks-install.ts). */
  adapterHooks?: () => AdapterHooks;
  /** The build hello reports (default: dist/build-info.json). */
  build?: BuildInfo;
  /** Where the hook helper is installed and shipped (default: hooks-install's). */
  hookPaths?: { cliDir: string; sourceDir: string };
  /** The service environment verify readiness is checked against (default: process.env). */
  verifyEnv?: NodeJS.ProcessEnv;
  /** Tests: how `pr.update_branch` waits for GitHub's new head (default: setTimeout). */
  prSleep?: (ms: number) => Promise<void>;
  /** Tests: how `ci.status` runs `gh` and `git` (default: execFile, no shell). */
  ciExec?: Exec;
  /**
   * S-Q1: the doctor run while the link is up (doctor.ts), every DOCTOR_MS;
   * its summary goes out in hello and `doctor` frames. `false` turns it off;
   * an object overrides what it reads (tests: systemctl, ports, statfs).
   */
  doctor?: false | Partial<GatherOptions>;
  doctorMs?: number;
}

/** How often the server recomputes the doctor summary while the link is up. */
export const DOCTOR_MS = 5 * 60_000;

/**
 * Dispatch's timers with every callback contained: a throw inside one (a
 * queued input whose `executing` the journal cannot record) is logged, never
 * an uncaught exception in the process that owns every terminal.
 */
export function containedTimers(log: (msg: string) => void, base?: DispatchTimers): DispatchTimers {
  const run = (fn: () => void) => () => {
    try {
      fn();
    } catch (err) {
      log(`eridani dispatch: a timer callback failed: ${(err as Error)?.message ?? String(err)}`);
    }
  };
  if (base) return { setTimeout: (fn, ms) => base.setTimeout(run(fn), ms), clearTimeout: (h) => base.clearTimeout(h) };
  return {
    setTimeout: (fn, ms) => {
      const t = setTimeout(run(fn), ms);
      t.unref?.();
      return t;
    },
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  };
}

/** The link caps hello advertises for a collector mode (also what `remotea eridani connect`'s probe sends). */
export function linkCaps(mode: CollectorMode | null | undefined): readonly LinkCap[] {
  return mode === 'authoritative' ? STAGE_F_AUTHORITATIVE_CAPS : STAGE_F_CAPS;
}

/** What each harness can do through remotea in stage B: observe and capture, nothing that acts. */
export function stageBCaps(versions: { claude: string | null; codex: string | null }): CapabilityMatrix {
  const caps = (version: string | null): HarnessCaps => ({ version, observe: true, capture: true, question: false, context: false, resume: true });
  return { claude: caps(versions.claude), codex: caps(versions.codex) };
}

export class EridaniRuntime {
  private link: EridaniLink | null = null;
  private started = false;
  private catalogReady: Promise<void> = Promise.resolve();
  private codexModels: import('../../src/shared/eridani-link-protocol').ModelCatalogEntry[] = [];
  private claudeModels: import('../../src/shared/eridani-link-protocol').ModelCatalogEntry[] = [];
  /** S-Q5: draining for a restart (`remotea upgrade`); a link made meanwhile drains too. */
  private draining: string | null = null;
  private stamp = '';
  private checkTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private collector: Collector | null = null;
  private state: CollectorState | null = null;
  private cfg: EridaniConfig | null = null;
  /** Launcher probes by probeKey; kept across reconfigures so a restart of the link does not wait. */
  private readonly probes = new Map<string, LauncherProbe>();
  /** Probes in flight by probeKey: a second request for one waits for it instead of starting another. */
  private readonly probing = new Map<string, Promise<void>>();
  private probedAt = 0;
  /** Which launchers may run managed sessions (launcher-conformance.ts). */
  readonly conformance: LauncherConformance;
  /** start()'s probes have settled (and its catalog read began): a later change re-reads the catalog itself. */
  private bootSettled = false;
  private readonly build: BuildInfo;
  private replayTimer: NodeJS.Timeout | null = null;
  private outputDirty = false;
  private worktreesSent = '';
  private worktreesRev = 0;
  private worktreesBusy = false;
  private worktreesAgain = false;
  /** A forced report (worktrees.scan) is due: the next run sends even an unchanged list. */
  private worktreesForce = false;
  /** Who waits for the next run to finish (a forced report starts after its request, never joins one in flight). */
  private worktreesWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly worktrees: WorktreeManager;
  /** The last worktrees report built (the doctor's recovery check reads it instead of running git again). */
  private lastWorktrees: WorktreeReport[] | null = null;
  /** The collector's last full scan (status file and doctor: parity age). */
  private lastScan: { at: number; seen: number; queued: number; failed: number; error: string | null } | null = null;
  /** S-Q1: the latest doctor summary (hello and `doctor` frames), when it was computed, and whether one is running. */
  private doctor: DoctorSummary | null = null;
  private doctorAt = 0;
  private doctorBusy = false;
  readonly dispatch: Dispatch;
  readonly questions: QuestionBroker;
  readonly context: ContextService;

  constructor(private readonly deps: EridaniRuntimeDeps) {
    const { hub, registry } = deps;
    this.build = deps.build ?? loadBuildInfo();
    this.conformance = new LauncherConformance({
      dir: deps.dir,
      run: deps.conformanceRunner ?? (deps.probe ? async () => [{ id: 'probe', status: 'fail', ms: 0, message: 'no conformance runner in this test' }] : defaultConformanceRunner),
      log: deps.log,
      env: deps.conformanceEnv,
      onSettled: () => this.conformanceChanged('a launcher conformance probe finished'),
    });
    if ((deps.conformanceEnv ?? process.env).REMOTEA_MANAGED_CLAUDE_MAX) deps.log('launcher conformance: REMOTEA_MANAGED_CLAUDE_MAX is no longer read; versions above the floor are probed (use REMOTEA_MANAGED_CLAUDE_FORCE=<version> to admit one without a probe)');
    this.questions = new QuestionBroker({
      session: (id) => registry.session(id),
      canHold: (id) => !!this.link?.ready && !!registry.session(id)?.eridani && registry.session(id)?.eridani?.execution !== 'managed',
      // Only what hello advertises is ever held: an adapter not verified on this version leaves the prompt in the terminal.
      capable: (provider, kind) => !!this.harnesses()[provider]?.question_kinds?.includes(kind),
      // No entity: a question and its resolution are separate facts, never coalesced.
      emit: (body) => void this.link?.enqueue(body as unknown as Record<string, unknown>, 0),
      needsYou: (id, reason) => hub.agentState.report(id, { awaitingHuman: reason !== null, reason }),
      holdMs: deps.questionHoldMs,
      log: deps.log,
    });
    this.dispatch = new Dispatch({
      hub,
      registry,
      dir: deps.dir,
      worktrees: (this.worktrees = new WorktreeManager({ dir: deps.dir })),
      targets: () => loadTargets(deps.dir),
      mcp: (t) => resolveMcp(deps.dir, t),
      webUrl: () => resolveWebUrl(deps.dir),
      // S-Q3: a spawn re-checks the template (it may have broken since hello) and prepares new worktrees.
      checkTarget: (t) => templateStatus(t, { env: deps.verifyEnv }),
      prepare: (t, wt, force) => runPrepare(t, wt, { force, env: deps.verifyEnv }),
      questions: this.questions,
      managedResumePending: (target, harness) => { const bin = target.launch[harness]?.bin ?? harness; return !this.probes.has(probeKey(harness, bin)) || this.conformance.probing(harness, bin); },
      managedSupported: (target, harness) => this.admission(harness, target.launch[harness]?.bin ?? harness).managed,
      managedEmit: (body) => {
        if (body.t === 'output.live') { if (this.link?.peerHas('output.live')) void this.link.enqueue(body, 1, `output:${body.surf}:${body.session_id}:${body.turn_id}:${body.message_id}`, Number(body.sequence)); return; }
        if (body.t === 'input.receipt') { if (this.link?.peerHas('input.direct')) void this.link.enqueue(body, 1, `input:${body.surf}:${body.input_id}`, body.stage === 'provider_acknowledged' ? 3 : body.stage === 'uncertain' ? 2 : 1); return; }
        if (body.t === 'activity') {
          hub.agentState.report(String(body.surf), { awaitingHuman: body.kind === 'waiting', runDepth: ['waiting', 'idle', 'unknown'].includes(String(body.kind)) ? 0 : 1, reason: body.kind === 'waiting' ? String(body.label ?? 'Waiting for a decision') : null });
          if (!this.link?.peerHas('activity')) return;
          void this.link.enqueue(body, 1, `activity:${String(body.surf)}`, Number(body.sequence)); return;
        }
        if (body.t === 'question' && !this.link?.peerHas('decisions.durable')) return;
        void this.link?.enqueue(body, 0);
      },
      emit: (body) => void this.link?.enqueue(body as unknown as Record<string, unknown>, 0),
      changed: () => void this.reportWorktrees(),
      linkReady: () => !!this.link?.ready,
      resumeAgents: deps.resumeAgents,
      log: deps.log,
      timing: deps.dispatchTiming,
      timers: containedTimers(deps.log),
    });
    this.context = new ContextService({
      session: (id) => registry.session(id),
      enabled: () => this.link !== null,
      request: (body, ms) => this.link?.request(body, ms) ?? Promise.resolve(null),
      runToken: (id) => this.dispatch.runToken(id),
      scoped: () => this.link?.peerHas('context.scope') ?? false,
      timeoutMs: deps.contextMs ?? ERIDANI_TIMING.contextMs,
      log: deps.log,
    });
    hub.setEridani(this.dispatch.hubHooks());
  }

  start(): void {
    this.started = true;
    this.dispatch.resumeOnBoot({ includeManaged: false });
    const launchers = launchersToProbe(loadTargets(this.deps.dir));
    // Managed runs resume, and the model catalog is read, once each launcher's conformance is settled.
    const versions = this.probeAll(launchers).then(() => this.conformanceSettled(launchers));
    this.catalogReady = versions.then(async () => { if (this.started && process.platform === 'linux' && !this.deps.probe) await this.refreshCatalog(); });
    void versions.then(() => { this.bootSettled = true; if (this.started) this.dispatch.resumeOnBoot({ onlyManaged: true }); });
    this.check();
    this.checkTimer = setInterval(() => this.check(), this.deps.checkMs ?? CHECK_MS);
    this.checkTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    this.teardown('shutdown');
  }

  /**
   * S-Q5 (drain.ts): hold Eridani's commands for the next server and start
   * no queued input; or stop draining and run what was held.
   */
  setDraining(on: boolean, reason = 'restart'): void {
    this.draining = on ? reason : null;
    this.dispatch.setDraining(on);
    this.link?.setDraining(on, reason);
    if (!on && this.link?.ready) this.link.replayAccepted();
  }

  /** What a drain still waits for: commands that began and have not settled, and pending steer/input writes. */
  inflight(): { commands: Array<{ op_id: string; t: string }>; writes: string[] } {
    return { commands: this.link?.begunOps() ?? [], writes: this.dispatch.pendingWrites() };
  }

  get current(): EridaniLink | null {
    return this.link;
  }

  /** Re-read the config when it changed; serve a pending collect request. */
  check(): void {
    const stamp = eridaniConfigStamp(this.deps.dir);
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      this.reconfigure();
    }
    if (this.outputDirty && this.link?.ready && this.link.spool.fill < MAX_FILL_FOR_SCAN) { this.outputDirty = false; this.dispatch.replayOutput(); }
    if (this.link) this.refreshProbes();
    // `remotea launcher probe` wrote new results.
    if (this.conformance.reload()) this.conformanceChanged('launcher conformance results changed on disk');
    if (this.link && Date.now() - this.doctorAt >= (this.deps.doctorMs ?? DOCTOR_MS)) void this.runDoctor();
    const req = path.join(this.deps.dir, ERIDANI_COLLECT_REQUEST);
    if (fs.existsSync(req)) {
      fs.rmSync(req, { force: true });
      if (this.link?.ready) {
        this.deps.log('eridani: collect requested');
        this.scan();
      }
    }
  }

  private reconfigure(): void {
    const cfg = loadEridaniConfig(this.deps.dir);
    const key = readEridaniToken(this.deps.dir);
    const want = !!cfg && cfg.enabled && !!key;
    if (this.link) this.teardown('reconfigured');
    if (!want) {
      if (cfg?.enabled && !key) this.deps.log('eridani: enabled but no link key; not connecting');
      return;
    }
    const urlError = linkUrlError(cfg!.url);
    if (urlError) {
      // Checked again here: eridani.json can be edited by hand, and the key must never go out in cleartext.
      this.deps.log(`eridani: not connecting: ${urlError}`);
      return;
    }
    this.cfg = cfg;
    // Runs started before the binding carried Eridani's web URL can be linked to it too.
    this.dispatch.backfillWebUrl();
    const machine = cfg!.machine || this.deps.hostname;
    const mode = cfg!.collector;
    const parity = mode !== 'authoritative';
    this.state = new CollectorState(path.join(this.deps.dir, STATE_FILES[mode === 'off' ? 'parity' : mode]));
    for (const other of Object.values(STATE_FILES)) this.state.rememberTerminalsFrom(path.join(this.deps.dir, other));
    const collector: Collector | null = mode === 'off' ? null : new Collector({
      home: this.deps.collectorHome,
      windowsUsers: this.deps.windowsUsers === undefined ? WINDOWS_USERS : this.deps.windowsUsers,
      machine,
      state: this.state,
      scope: cfg!.collector_scope ?? 'remotea',
      status: () => statusFromRegistry(
        {
          groups: Object.fromEntries(this.deps.registry.groups().map((g) => [g.id, g])),
          sessions: Object.fromEntries(this.deps.registry.sessions().map((s) => [s.id, s])),
        },
        this.deps.hostname,
      ),
      // A scan still running from before a reconfigure (a mode switch) sends nothing through the new link.
      send: (r) => (this.collector === collector ? this.link?.report(r, parity) ?? false : false),
      warn: (m) => this.deps.log(`eridani collector: ${m}`),
    });
    this.collector = collector;
    const link = new EridaniLink({
      url: cfg!.url,
      token: () => readEridaniToken(this.deps.dir),
      dir: this.deps.dir,
      serverId: this.deps.serverId,
      bootId: this.deps.bootId,
      hostname: this.deps.hostname,
      machine,
      version: this.deps.version,
      build: this.build,
      capsVersion: ERIDANI_CAPS_VERSION,
      hookVersion: () => hookVersion(this.deps.hookPaths ?? defaultHookPaths()).installed,
      harnesses: () => this.harnesses(),
      snapshot: () => this.deps.hub.snapshot(),
      log: this.deps.log,
      onReady: () => {
        // A steer or input begun before a reconnect writes nothing more (runs.snapshot decides).
        this.dispatch.linkUp();
        this.takeDirty();
        this.scan();
        this.worktreesSent = '';
        void this.reportWorktrees();
        if (this.replayTimer) clearTimeout(this.replayTimer);
        this.replayTimer = setTimeout(() => this.replay(), REPLAY_FALLBACK_MS);
        this.replayTimer.unref?.();
      },
      handlers: {
        ...this.dispatch.handlers(),
        'worktrees.scan': (c, ctx) => this.scanCommand(c, ctx),
        'terminal.focus': async (c, ctx) => this.focusCommand(c, ctx),
        'ci.status': (c, ctx) => this.ciCommand(c, ctx),
        'pr.merge': (c, ctx) => this.prCommand(c, ctx),
        'pr.update_branch': (c, ctx) => this.prCommand(c, ctx),
      },
      precheck: (cmd) => this.dispatch.precheck(cmd),
      // A scan (or a focus) cut off by a restart already did whatever it did; Eridani's wait bounds it.
      recover: (rec) => (rec.t === 'worktrees.scan' || rec.t === 'terminal.focus' || rec.t === 'ci.status'
        ? { state: 'failed', detail: 'interrupted by a server restart' }
        // A merge or update cut off mid-way may have happened on GitHub: Eridani reads the pull request again.
        : rec.t === 'pr.merge' || rec.t === 'pr.update_branch'
        ? { state: 'uncertain', detail: 'interrupted by a server restart' }
        : this.dispatch.recover(rec)),
      acceptFacts: (cmd) => this.dispatch.acceptFacts(cmd),
      caps: () => !Object.values(this.harnesses()).some((h) => h?.managed) ? linkCaps(mode) : [...linkCaps(mode), 'managed.sessions', 'input.direct', 'output.live', 'decisions.durable', 'commands.durable', 'role.options', 'run.pause', 'activity', 'model_catalog'],
      modelCatalog: () => [...(this.codexModels.length ? this.codexModels : hostModelCatalog(path.join(os.homedir(), '.codex', 'models_cache.json'))), ...this.claudeModels],
      targets: () => this.helloTargets(),
      doctor: () => this.doctor,
      collectorStatus: () => this.collectorStatus(),
      onRunsSnapshot: (runs) => {
        this.dispatch.applyRunsSnapshot(runs);
        this.replay();
      },
      onDelivered: (entry) => {
        const b = entry.body as { t?: unknown; parity?: unknown; revision?: unknown };
        // A report queued under the other mode (still in the outbox across a switch) advances nothing.
        if (b.t === 'session.report' && entry.entity && typeof b.revision === 'string' && b.parity === parity) {
          this.state?.delivered(entry.entity, b.revision);
        }
      },
      onRefused: (entry) => {
        if (!parity && entry.body.t === 'session.report' && entry.entity) this.state?.dirty(entry.entity);
      },
      onDirty: (entity) => {
        if (entity.startsWith('output:')) { this.outputDirty = true; return; }
        if (entity === WORKTREES_ENTITY) this.worktreesSent = '';
        else if (entity === 'doctor') this.doctorAt = 0; // not queued: computed and offered again on the next tick
        else this.state?.dirty(entity);
      },
      ...this.deps.linkOverrides,
    });
    this.link = link;
    if (this.draining) link.setDraining(true, this.draining);
    this.deps.hub.setSink({
      status: (s) => void link.agentStatus(s),
      turn: (t) => void link.turn(t),
      prompt: (p) => void link.prompt(p),
      exit: (e) => void link.exit(e),
      turnCaptured: (provider, sessionId) => {
        if (!this.collector || !link.ready || link.spool.fill > MAX_FILL_FOR_SCAN) return;
        this.collector.scanOne(provider, sessionId).catch((err) => this.deps.log(`eridani collector: ${(err as Error).message}`));
      },
    });
    this.deps.log(`eridani: link to ${cfg!.url} as ${machine} (collector ${cfg!.collector}, ${cfg!.collector_scope === 'all' ? 'all sessions' : 'remotea sessions only'}); build ${this.build.sha.slice(0, 12)}${this.build.dirty ? '+dirty' : ''}`);
    // hello is sent on every connect: probe first so it never claims a harness that would not start.
    const launchers = launchersToProbe(loadTargets(this.deps.dir));
    const known = launchers.every((l) => this.probes.has(probeKey(l.harness, l.bin)));
    this.probedAt = Date.now();
    const probed = Promise.all([this.probeAll(launchers), this.catalogReady]);
    if (known) void this.catalogReady.then(() => { if (this.link === link) link.start(); });
    else void probed.then(() => {
      if (this.link === link) link.start();
    });
    // The doctor summary hello carries; from the probes once they are in. A later hello (any reconnect) has it.
    this.lastScan = null;
    this.doctorAt = Date.now();
    void probed.then(() => {
      if (this.link === link) void this.runDoctor();
    });
    this.scanTimer = setInterval(() => this.scan(), this.deps.scanMs ?? SCAN_MS);
    this.scanTimer.unref?.();
  }

  private async refreshCatalog(): Promise<void> {
    const targets = loadTargets(this.deps.dir);
    const supportedBin = (harness: 'claude' | 'codex'): string | undefined => {
      const bins = [...targets.flatMap((target) => target.launch[harness] ? [target.launch[harness]!.bin ?? harness] : []), harness];
      return bins.find((bin) => this.admission(harness, bin).managed);
    };
    const claude = supportedBin('claude'), codex = supportedBin('codex');
    [this.claudeModels, this.codexModels] = await Promise.all([claude ? claudeModelCatalog(claude) : Promise.resolve([]), codex ? codexModelCatalog(codex) : Promise.resolve([])]);
  }

  /** The host-wide harness matrix from the latest probes (launch-caps.ts). */
  harnesses(): CapabilityMatrix {
    const matrix = harnessMatrix(this.probes, loadTargets(this.deps.dir), (this.deps.adapterHooks ?? (() => adapterHooks()))());
    for (const harness of MANAGED_HARNESSES) {
      const caps = matrix[harness];
      if (!caps) continue;
      // The bare name's launcher speaks for the harness, unless another launcher of it is admitted and it is not.
      const all = [...this.probes.keys()].filter((key) => key.startsWith(`${harness}\0`)).map((key) => this.admission(harness, key.slice(harness.length + 1)));
      const bare = this.admission(harness, harness);
      const best = bare.managed ? bare : all.find((a) => a.managed) ?? bare;
      Object.assign(caps, admissionFields(best));
      caps.managed_questions = caps.managed ? ['ask', 'approval'] : [];
    }
    return matrix;
  }

  /** Whether this launcher may run managed sessions now, and why (hello's conformance fields). */
  admission(harness: ManagedHarness, bin: string): Admission {
    return this.conformance.admission(harness, bin, this.probes.get(probeKey(harness, bin)));
  }

  /** Every managed launcher's conformance, once settled (an unchanged, recorded binary settles at once). */
  private conformanceSettled(launchers: Array<{ harness: ProbeHarness; bin: string }>): Promise<unknown> {
    return Promise.all(launchers.filter((l): l is { harness: ManagedHarness; bin: string } => (MANAGED_HARNESSES as readonly string[]).includes(l.harness)).map(({ harness, bin }) => {
      const probe = this.probes.get(probeKey(harness, bin));
      return probe ? this.conformance.ensure(harness, bin, probe).catch(() => undefined) : undefined;
    }));
  }

  /** What hello advertises about managed runs may have changed: refresh the catalog and send a new hello. */
  private conformanceChanged(reason: string): void {
    if (!this.started) return;
    if (this.bootSettled && process.platform === 'linux' && !this.deps.probe) void this.refreshCatalog().catch((err) => this.deps.log(`eridani: model catalog: ${(err as Error).message}`));
    this.link?.rehello(reason);
  }

  /** Execution targets for hello: ids, repos, permission, probed launchers and verify readiness; never argv or env. */
  helloTargets(): HelloTarget[] {
    const targets = loadTargets(this.deps.dir);
    // Whether a spawn there gets Eridani's MCP server (eridani-mcp.ts); never the key.
    const hello = helloTargets(targets, this.probes, { env: this.deps.verifyEnv }).map((h) => {
      const t = targets.find((x) => x.id === h.id);
      if (!t) return h;
      if (h.launch) for (const [name, launch] of Object.entries(h.launch)) if (launch) Object.assign(launch, admissionFields(this.admission(name as ManagedHarness, t.launch[name as ManagedHarness]?.bin ?? name)));
      // S-N4: whether each verify entry would run sandboxed (verify-sandbox.ts).
      const verify_status = h.verify_status ? withIsolation(h.verify_status, t.verify, this.deps.verifyEnv) : undefined;
      return { ...h, ...(verify_status ? { verify_status } : {}), mcp: mcpStatus(resolveMcp(this.deps.dir, t)) };
    });
    // S-Q3: the whole template checked; a target that fails it is listed with its reasons and `harnesses: []`.
    return withTemplate(hello, targets, { env: this.deps.verifyEnv });
  }

  /**
   * On the check tick: targets are read from disk on every use (a new one
   * does not reconfigure the link), so a launcher not probed yet is probed
   * now, and all of them again every PROBE_REFRESH_MS. hello carries the
   * results from the next connect on.
   */
  private refreshProbes(): void {
    const launchers = launchersToProbe(loadTargets(this.deps.dir));
    if (Date.now() - this.probedAt >= PROBE_REFRESH_MS) {
      this.probedAt = Date.now();
      void this.probeAll(launchers);
    } else {
      const missing = launchers.filter((l) => !this.probes.has(probeKey(l.harness, l.bin)));
      if (missing.length) void this.probeAll(missing);
    }
  }

  /** Probe launchers (in parallel, one at a time per launcher); a failure is a result, never a throw. */
  private async probeAll(launchers: Array<{ harness: ProbeHarness; bin: string }>): Promise<void> {
    const probe = this.deps.probe ?? defaultProbe;
    await Promise.all(launchers.map(({ harness, bin }) => {
      const key = probeKey(harness, bin);
      const running = this.probing.get(key);
      if (running) return running;
      const p = (async () => {
        let r: LauncherProbe;
        try {
          r = await probe(harness, bin);
        } catch (err) {
          r = { ok: false, version: null, error: (err as Error).message };
        }
        const was = this.probes.get(key);
        this.probes.set(key, r);
        if (!was || was.ok !== r.ok) this.deps.log(`eridani: ${harness} launcher \`${bin}\`: ${r.ok ? `ready${r.version ? ` (${r.version})` : ''}` : `not ready: ${r.error ?? 'failed'}`}`);
        // A new or changed binary is probed for managed runs in the background; hello says `probing` meanwhile.
        if ((MANAGED_HARNESSES as readonly string[]).includes(harness) && r.ok) void this.conformance.ensure(harness as ManagedHarness, bin, r).catch(() => undefined);
      })().finally(() => this.probing.delete(key));
      this.probing.set(key, p);
      return p;
    }));
  }

  /**
   * `worktrees.report`: every managed worktree with its unmerged-work
   * reasons. Sent when the link becomes ready and whenever the list changes
   * (after a spawn, an exit, and on the scan tick); coalesced in the spool.
   * `force` (worktrees.scan) sends it even unchanged; the promise settles when
   * a run that started after the request has queued it (or failed). Unforced
   * callers get a promise that never rejects.
   */
  reportWorktrees(force = false): Promise<void> {
    const done = force
      ? new Promise<void>((resolve, reject) => this.worktreesWaiters.push({ resolve, reject }))
      : Promise.resolve();
    if (force) this.worktreesForce = true;
    if (!this.link?.ready) {
      this.settleWorktrees(this.worktreesWaiters.splice(0), new Error('the link is not ready'));
      this.worktreesForce = false;
      return done;
    }
    if (this.worktreesBusy) {
      this.worktreesAgain = true;
      return done;
    }
    this.worktreesBusy = true;
    const waiters = this.worktreesWaiters.splice(0);
    const forced = this.worktreesForce;
    this.worktreesForce = false;
    const writers = writersByPath(this.deps.registry.sessions());
    const targets = loadTargets(this.deps.dir);
    // nominate fetches each base first (rate-limited), so the heads read the same fresh ref.
    this.worktrees.nominate(targets, (p) => writers.has(p), (p) => writers.get(p) ?? null).then(async (rows) => [rows, await this.worktrees.migrationHeads(targets)] as const).then(
      ([rows, heads]) => {
        this.stampWorktrees(rows);
        this.lastWorktrees = rows;
        const body = heads.length ? { t: 'worktrees.report' as const, worktrees: rows, heads } : { t: 'worktrees.report' as const, worktrees: rows };
        const text = JSON.stringify(body);
        if (!forced && text === this.worktreesSent) return this.settleWorktrees(waiters, null);
        if (!this.link?.ready) return this.settleWorktrees(waiters, new Error('the link went down during the scan'));
        if (this.link.enqueue(body, 0, WORKTREES_ENTITY, ++this.worktreesRev)) {
          this.worktreesSent = text;
          this.settleWorktrees(waiters, null);
        } else this.settleWorktrees(waiters, new Error('the outbox refused the report'));
      },
      (err) => {
        this.deps.log(`eridani: worktrees report failed: ${(err as Error).message}`);
        this.settleWorktrees(waiters, err instanceof Error ? err : new Error(String(err)));
      },
    ).finally(() => {
      this.worktreesBusy = false;
      if (this.worktreesAgain) {
        this.worktreesAgain = false;
        void this.reportWorktrees();
      }
    });
    return done;
  }

  /**
   * Each Eridani session's worktree facts onto its registry record
   * (SessionRecord.worktreeState, additive), so a desktop can offer the
   * worktree of a run that ended with unmerged work. Only a change is
   * written (and broadcast).
   */
  private stampWorktrees(rows: WorktreeReport[]): void {
    const byPath = new Map(rows.filter((r) => r.branch).map((r) => [r.path, r]));
    for (const rec of this.deps.registry.sessions()) {
      const row = rec.eridani ? byPath.get(rec.eridani.worktree) : undefined;
      if (!row) continue;
      const next = worktreeStateOf(row);
      if (sameWorktreeState(rec.worktreeState, next)) continue;
      this.deps.hub.updateRecord(rec.id, { worktreeState: { ...next, at: Date.now() } });
    }
  }

  private settleWorktrees(waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>, err: Error | null): void {
    for (const w of waiters) {
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  /**
   * `worktrees.scan`: rescan the worktrees and (when named) one session, and
   * send both reports even when nothing changed. `executed` once both are
   * queued; `failed` when either scan fails. A session this host does not have
   * (or a collector that is off) is still `executed`, with `result.session`
   * saying so: the worktrees part is what was asked for in any case.
   */
  private async scanCommand(cmd: CommandBody, ctx: CommandContext): Promise<CommandResult> {
    const c = cmd as unknown as WorktreesScanCommand;
    ctx.begin();
    const fail = (what: string, err: unknown): CommandResult => ({
      state: 'failed',
      detail: `${what}: ${(err as Error)?.message ?? String(err)}`.slice(0, ERIDANI_LIMITS.reasonChars),
    });
    try {
      await this.reportWorktrees(true);
    } catch (err) {
      return fail('worktrees scan failed', err);
    }
    const result: Record<string, unknown> = { worktrees: 'reported' };
    if (c.tool && c.session_id) {
      const collector = this.collector;
      if (!collector) result.session = 'collector_off';
      else {
        let r;
        try {
          r = await collector.scanOne(c.tool.startsWith('codex') ? 'codex' : 'claude', c.session_id, { tool: c.tool, force: true });
        } catch (err) {
          return fail('session scan failed', err);
        }
        if (r.failed) return { state: 'failed', detail: 'session scan: the outbox refused the report', result: { ...result, session: 'not_queued' } };
        result.session = r.queued ? 'reported' : 'not_found';
      }
    }
    return { state: 'executed', result };
  }

  /**
   * `ci.status`: GitHub CI's view of the run's pull request, read with this
   * host's `gh` in the branch's worktree (a target's `<worktreeRoot>/<branch>`,
   * else the live folder of a session bound to the run). Read-only; `failed`
   * with the reason when `gh` is missing or logged out or there is no folder.
   */
  private async ciCommand(cmd: CommandBody, ctx: CommandContext): Promise<CommandResult> {
    const c = cmd as unknown as CiStatusCommand;
    const bound = this.deps.registry.sessions().find((s) => s.eridani?.runId === c.run_id && s.state !== 'exited');
    const cwd = ciFolder(loadTargets(this.deps.dir), c.branch, bound ? (bound.lastCwd ?? bound.cwd) : null, c.target ?? null);
    if (!cwd) return { state: 'failed', detail: `no worktree for ${c.branch} on this host` };
    ctx.begin();
    try {
      const result = await ciStatus({ cwd, branch: c.branch, logLines: c.log_lines ?? 0, exec: this.deps.ciExec });
      return { state: 'executed', result: result as unknown as Record<string, unknown> };
    } catch (err) {
      const msg = err instanceof CiStatusError ? err.message : `ci status failed: ${(err as Error)?.message ?? String(err)}`;
      return { state: 'failed', detail: msg.slice(0, ERIDANI_LIMITS.reasonChars) };
    }
  }

  /**
   * `pr.merge` / `pr.update_branch`: Eridani's Merge and Update branch, with
   * this host's `gh` (pr-actions.ts), in the branch's worktree, else a live
   * session's folder, else the target's repository.
   */
  private async prCommand(cmd: CommandBody, ctx: CommandContext): Promise<CommandResult> {
    const c = cmd as unknown as PrMergeCommand | PrUpdateBranchCommand;
    const targets = loadTargets(this.deps.dir);
    const bound = this.deps.registry.sessions().find((s) => s.eridani?.runId === c.run_id && s.state !== 'exited');
    const cwd = ciFolder(targets, c.branch, bound ? (bound.lastCwd ?? bound.cwd) : null, c.target ?? null);
    if (!cwd) return { state: 'failed', detail: `no clone of the repository for ${c.branch} on this host` };
    const worktree = targets.map((t) => path.join(t.worktreeRoot, branchDir(c.branch))).find((d) => fs.existsSync(d)) ?? null;
    ctx.begin();
    try {
      const o = { cwd, branch: c.branch, headSha: c.head_sha, exec: this.deps.ciExec };
      const r = c.t === 'pr.merge' ? await prMerge(o) : await prUpdateBranch({ ...o, worktree, sleep: this.deps.prSleep });
      return { state: r.state, ...(r.detail ? { detail: r.detail } : {}), result: r.result };
    } catch (err) {
      const msg = err instanceof CiStatusError ? err.message : `${c.t} failed: ${(err as Error)?.message ?? String(err)}`;
      return { state: 'failed', detail: msg.slice(0, ERIDANI_LIMITS.reasonChars) };
    }
  }

  /**
   * `terminal.focus`: bring the run's tab to the front in the connected
   * apps. The surface must still exist, be running, and belong to the run;
   * otherwise `unknown_surf`. `no_desktop` when no app that understands
   * `focus` (and has not hidden the tab) is connected, so Eridani can show
   * where the terminal is instead.
   */
  private focusCommand(cmd: CommandBody, ctx: CommandContext): CommandResult {
    const c = cmd as unknown as TerminalFocusCommand;
    const rec = this.deps.registry.session(c.surf);
    if (!rec || rec.state === 'exited' || !this.deps.hub.isLive(c.surf) || rec.eridani?.runId !== c.run_id) {
      return { state: 'rejected', detail: 'unknown_surf' };
    }
    ctx.begin();
    const desktops = this.deps.hub.focus(c.surf, c.run_id);
    return desktops ? { state: 'executed', result: { desktops } } : { state: 'rejected', detail: 'no_desktop' };
  }

  /** Run what was accepted before a restart and never started (once per connection). */
  private replay(): void {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = null;
    if (this.link?.ready) this.link.replayAccepted();
  }

  /** Entities evicted from the outbox: forget their fingerprints so the next scan sends them again. */
  private takeDirty(): void {
    if (!this.link || !this.state) return;
    const dirty = this.link.spool.takeDirty();
    for (const entity of dirty) this.state.dirty(entity);
    if (dirty.length) this.state.save();
  }

  private scan(): void {
    void this.reportWorktrees();
    const link = this.link;
    if (!link || !this.collector || !link.ready) return;
    if (link.spool.fill > MAX_FILL_FOR_SCAN) {
      this.deps.log(`eridani collector: outbox ${Math.round(link.spool.fill * 100)}% full, scan skipped`);
      return;
    }
    this.takeDirty();
    this.collector.scan().then(
      (r) => {
        this.lastScan = { at: Date.now(), seen: r.seen, queued: r.queued, failed: r.failed, error: null };
        if (r.queued || r.failed) this.deps.log(`eridani collector: ${r.seen} session(s), ${r.queued} report(s) queued, ${r.failed} not queued`);
      },
      (err) => {
        this.lastScan = { at: Date.now(), seen: 0, queued: 0, failed: 0, error: String((err as Error)?.message ?? err).slice(0, 200) };
        this.deps.log(`eridani collector: scan failed: ${(err as Error).message}`);
      },
    );
  }

  /** The collector's mode and last full scan, for the status file (`remotea doctor`'s parity age). */
  collectorStatus(): CollectorLinkStatus | null {
    if (!this.cfg) return null;
    const s = this.lastScan;
    return {
      mode: this.cfg.collector,
      lastScanAt: s?.at ?? null,
      lastScan: s && !s.error ? { seen: s.seen, queued: s.queued, failed: s.failed } : null,
      lastScanError: s?.error ?? null,
      codexUnavailable: this.collector?.codexUnavailable ?? null,
    };
  }

  /** The latest doctor summary (null before the first run). */
  get doctorSummary(): DoctorSummary | null {
    return this.doctor;
  }

  /**
   * S-Q1: run the doctor from inside the server (its own link, probes,
   * worktrees report and registry; no git, no probes of its own), keep the
   * summary for the next hello, and offer it to the link, which sends a
   * `doctor` frame only to an Eridani that advertised `doctor` and only when
   * the findings changed. Never throws.
   */
  async runDoctor(): Promise<DoctorSummary | null> {
    if (this.deps.doctor === false || this.doctorBusy) return this.doctor;
    this.doctorBusy = true;
    this.doctorAt = Date.now();
    try {
      const link = this.link;
      const report = await runDoctor({
        dir: this.deps.dir,
        ...(this.deps.hookPaths ? { hookPaths: { home: defaultHookPaths().home, ...this.deps.hookPaths } } : {}),
        link: link?.status() ?? null,
        readiness: this.helloTargets(),
        worktrees: async () => this.lastWorktrees,
        registry: {
          v: 1,
          epoch: '',
          groups: Object.fromEntries(this.deps.registry.groups().map((g) => [g.id, g])),
          sessions: Object.fromEntries(this.deps.registry.sessions().map((s) => [s.id, s])),
          tombstones: {},
          devices: {},
        },
        serverInfo: readServerInfo(this.deps.dir),
        diskBuild: this.build,
        collector: this.collectorStatus(),
        ...(this.deps.doctor ?? {}),
      });
      this.doctor = doctorSummary(report);
      if (this.link === link) link?.reportDoctor(this.doctor);
    } catch (err) {
      this.deps.log(`eridani: doctor failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      this.doctorBusy = false;
    }
    return this.doctor;
  }

  private teardown(reason: string): void {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = null;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    this.deps.hub.setSink(null);
    this.link?.stop(reason);
    this.link = null;
    this.collector = null;
    this.state = null;
    this.cfg = null;
  }
}

/** The server's version, from the package.json beside the build (dist/remote-server/src → ../../..). */
export function serverVersion(): string {
  for (const rel of ['../../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'remotea-server' && pkg.version) return pkg.version;
    } catch {
      /* try the next layout */
    }
  }
  return '0.0.0';
}

/** An admission as hello carries it (HarnessCaps and HelloLaunch); absent fields are left out. */
function admissionFields(a: Admission): Pick<Admission, 'managed' | 'conformance' | 'launcher_version'> & Partial<Admission> {
  return {
    managed: a.managed,
    conformance: a.conformance,
    launcher_version: a.launcher_version,
    ...(a.conformance_step ? { conformance_step: a.conformance_step } : {}),
    ...(a.conformance_message ? { conformance_message: a.conformance_message.slice(0, 300) } : {}),
    ...(a.conformance_at ? { conformance_at: a.conformance_at } : {}),
  };
}

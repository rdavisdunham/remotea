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
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ERIDANI_TIMING, STAGE_F_AUTHORITATIVE_CAPS, STAGE_F_CAPS, type CapabilityMatrix, type HarnessCaps } from '../../src/shared/eridani-link-protocol';
import {
  ERIDANI_COLLECT_REQUEST,
  eridaniConfigStamp,
  linkUrlError,
  loadEridaniConfig,
  readEridaniToken,
  type CollectorMode,
  type EridaniConfig,
} from './config';
import { EridaniLink, type EridaniLinkDeps } from './eridani-link';
import type { Hub } from './hub';
import type { Registry } from './registry';
import { Collector } from './collector/collector';
import { CollectorState } from './collector/state';
import { statusFromRegistry } from './collector/report';
import { Dispatch } from './dispatch';
import { QuestionBroker } from './questions-claude';
import { ContextService } from './context';
import { WorktreeManager } from './worktrees';
import { loadTargets } from './eridani-targets';
import type { HelloTarget } from '../../src/shared/eridani-link-protocol';

export const COLLECTOR_STATE_FILE = 'eridani-collector.json';
/** Delivered fingerprints per mode: a parity ack says nothing about what Eridani stored. */
export const COLLECTOR_STATE_FILES: Record<Exclude<CollectorMode, 'off'>, string> = {
  parity: COLLECTOR_STATE_FILE,
  authoritative: 'eridani-collector-authoritative.json',
};
/** collector.py's Windows side. */
export const WINDOWS_USERS = '/mnt/c/Users';
const CHECK_MS = 30_000;
const SCAN_MS = 2 * 60_000;
const MAX_FILL_FOR_SCAN = 0.8;
/** How long after ready to wait for runs.snapshot before replaying accepted commands anyway. */
const REPLAY_FALLBACK_MS = 10_000;
const WORKTREES_ENTITY = 'worktrees';

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
}

/** `claude --version` / `codex --version`, once per link start. Never blocks the link. */
function probeVersion(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout).match(/\d+\.\d+(?:\.\d+)?[\w.-]*/);
        resolve(m ? m[0].slice(0, 40) : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** What each harness can do through remotea in stage B: observe and capture, nothing that acts. */
export function stageBCaps(versions: { claude: string | null; codex: string | null }): CapabilityMatrix {
  const caps = (version: string | null): HarnessCaps => ({ version, observe: true, capture: true, question: false, context: false, resume: true });
  return { claude: caps(versions.claude), codex: caps(versions.codex) };
}

/**
 * Stage C, from the stage A capability matrix: both harnesses spawn, take
 * SessionStart context and steer by interrupt; only Claude's AskUserQuestion
 * is answerable (Codex's request_user_input has no hook), and Claude's
 * PermissionRequest is captured, not answered.
 */
export function stageCCaps(versions: { claude: string | null; codex: string | null }): CapabilityMatrix {
  const base = (version: string | null): HarnessCaps => ({ version, observe: true, capture: true, question: false, context: true, resume: true, spawn: true, steer: 'interrupt' });
  return {
    claude: { ...base(versions.claude), question: true, permission: 'capture', launch_flags: ['--permission-mode', 'auto'] },
    codex: { ...base(versions.codex), launch_flags: ['--disable', 'daemon_auto_start'] },
  };
}

export class EridaniRuntime {
  private link: EridaniLink | null = null;
  private stamp = '';
  private checkTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private collector: Collector | null = null;
  private state: CollectorState | null = null;
  private cfg: EridaniConfig | null = null;
  private harnesses: CapabilityMatrix = stageCCaps({ claude: null, codex: null });
  private replayTimer: NodeJS.Timeout | null = null;
  private worktreesSent = '';
  private worktreesRev = 0;
  private worktreesBusy = false;
  private worktreesAgain = false;
  private readonly worktrees: WorktreeManager;
  readonly dispatch: Dispatch;
  readonly questions: QuestionBroker;
  readonly context: ContextService;

  constructor(private readonly deps: EridaniRuntimeDeps) {
    const { hub, registry } = deps;
    this.questions = new QuestionBroker({
      session: (id) => registry.session(id),
      canHold: (id) => !!this.link?.ready && !!registry.session(id)?.eridani,
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
      questions: this.questions,
      emit: (body) => void this.link?.enqueue(body as unknown as Record<string, unknown>, 0),
      changed: () => this.reportWorktrees(),
      linkReady: () => !!this.link?.ready,
      resumeAgents: deps.resumeAgents,
      log: deps.log,
      timing: deps.dispatchTiming,
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
    this.dispatch.resumeOnBoot();
    this.check();
    this.checkTimer = setInterval(() => this.check(), this.deps.checkMs ?? CHECK_MS);
    this.checkTimer.unref?.();
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    this.teardown('shutdown');
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
    const machine = cfg!.machine || this.deps.hostname;
    const mode = cfg!.collector;
    const parity = mode !== 'authoritative';
    this.state = new CollectorState(path.join(this.deps.dir, COLLECTOR_STATE_FILES[mode === 'off' ? 'parity' : mode]));
    const collector: Collector | null = mode === 'off' ? null : new Collector({
      home: this.deps.collectorHome,
      windowsUsers: this.deps.windowsUsers === undefined ? WINDOWS_USERS : this.deps.windowsUsers,
      machine,
      state: this.state,
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
      harnesses: () => this.harnesses,
      snapshot: () => this.deps.hub.snapshot(),
      log: this.deps.log,
      onReady: () => {
        this.takeDirty();
        this.scan();
        this.worktreesSent = '';
        this.reportWorktrees();
        if (this.replayTimer) clearTimeout(this.replayTimer);
        this.replayTimer = setTimeout(() => this.replay(), REPLAY_FALLBACK_MS);
        this.replayTimer.unref?.();
      },
      handlers: this.dispatch.handlers(),
      precheck: (cmd) => this.dispatch.precheck(cmd),
      recover: (rec) => this.dispatch.recover(rec),
      acceptFacts: (cmd) => this.dispatch.acceptFacts(cmd),
      caps: () => (mode === 'authoritative' ? STAGE_F_AUTHORITATIVE_CAPS : STAGE_F_CAPS),
      targets: () => this.helloTargets(),
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
        if (entity === WORKTREES_ENTITY) this.worktreesSent = '';
        else this.state?.dirty(entity);
      },
      ...this.deps.linkOverrides,
    });
    this.link = link;
    this.deps.hub.setSink({
      status: (s) => void link.agentStatus(s),
      turn: (t) => void link.turn(t),
      exit: (e) => void link.exit(e),
      turnCaptured: (provider, sessionId) => {
        if (!this.collector || !link.ready || link.spool.fill > MAX_FILL_FOR_SCAN) return;
        this.collector.scanOne(provider, sessionId).catch((err) => this.deps.log(`eridani collector: ${(err as Error).message}`));
      },
    });
    this.deps.log(`eridani: link to ${cfg!.url} as ${machine} (collector ${cfg!.collector})`);
    link.start();
    void Promise.all([probeVersion('claude'), probeVersion('codex')]).then(([claude, codex]) => {
      this.harnesses = stageCCaps({ claude, codex });
    });
    this.scanTimer = setInterval(() => this.scan(), this.deps.scanMs ?? SCAN_MS);
    this.scanTimer.unref?.();
  }

  /** Execution targets for hello: ids, repos and verify ids only. */
  private helloTargets(): HelloTarget[] {
    return loadTargets(this.deps.dir).map((t) => ({
      id: t.id,
      repo: t.repo,
      worktree_root: t.worktreeRoot,
      harnesses: (['claude', 'codex'] as const).filter((h) => !!t.launch[h]),
      verify: t.verify.map((v) => v.id),
      ...(t.migrations ? { migrations: { ...t.migrations } } : {}),
    }));
  }

  /**
   * `worktrees.report`: every managed worktree with its unmerged-work
   * reasons. Sent when the link becomes ready and whenever the list changes
   * (after a spawn, an exit, and on the scan tick); coalesced in the spool.
   */
  reportWorktrees(): void {
    if (!this.link?.ready) return;
    if (this.worktreesBusy) {
      this.worktreesAgain = true;
      return;
    }
    this.worktreesBusy = true;
    const active = new Set(this.deps.registry.sessions().filter((r) => r.eridani && r.state !== 'exited').map((r) => r.eridani!.worktree));
    const targets = loadTargets(this.deps.dir);
    // nominate fetches each base first (rate-limited), so the heads read the same fresh ref.
    this.worktrees.nominate(targets, (p) => active.has(p)).then(async (rows) => [rows, await this.worktrees.migrationHeads(targets)] as const).then(
      ([rows, heads]) => {
        const body = heads.length ? { t: 'worktrees.report' as const, worktrees: rows, heads } : { t: 'worktrees.report' as const, worktrees: rows };
        const text = JSON.stringify(body);
        if (text !== this.worktreesSent && this.link?.ready) {
          if (this.link.enqueue(body, 0, WORKTREES_ENTITY, ++this.worktreesRev)) this.worktreesSent = text;
        }
      },
      (err) => this.deps.log(`eridani: worktrees report failed: ${(err as Error).message}`),
    ).finally(() => {
      this.worktreesBusy = false;
      if (this.worktreesAgain) {
        this.worktreesAgain = false;
        this.reportWorktrees();
      }
    });
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
    this.reportWorktrees();
    const link = this.link;
    if (!link || !this.collector || !link.ready) return;
    if (link.spool.fill > MAX_FILL_FOR_SCAN) {
      this.deps.log(`eridani collector: outbox ${Math.round(link.spool.fill * 100)}% full, scan skipped`);
      return;
    }
    this.takeDirty();
    this.collector.scan().then(
      (r) => {
        if (r.queued || r.failed) this.deps.log(`eridani collector: ${r.seen} session(s), ${r.queued} report(s) queued, ${r.failed} not queued`);
      },
      (err) => this.deps.log(`eridani collector: scan failed: ${(err as Error).message}`),
    );
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

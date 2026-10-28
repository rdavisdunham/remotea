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
 *   - `remotea eridani collect` drops a request file; it is picked up on the
 *     same 30 s tick.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { CapabilityMatrix, HarnessCaps } from '../../src/shared/eridani-link-protocol';
import {
  ERIDANI_COLLECT_REQUEST,
  eridaniConfigStamp,
  loadEridaniConfig,
  readEridaniToken,
  type EridaniConfig,
} from './config';
import { EridaniLink, type EridaniLinkDeps } from './eridani-link';
import type { Hub } from './hub';
import type { Registry } from './registry';
import { Collector } from './collector/collector';
import { CollectorState } from './collector/state';
import { statusFromRegistry } from './collector/report';

export const COLLECTOR_STATE_FILE = 'eridani-collector.json';
/** collector.py's Windows side. */
export const WINDOWS_USERS = '/mnt/c/Users';
const CHECK_MS = 30_000;
const SCAN_MS = 2 * 60_000;
const MAX_FILL_FOR_SCAN = 0.8;

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

export class EridaniRuntime {
  private link: EridaniLink | null = null;
  private stamp = '';
  private checkTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private collector: Collector | null = null;
  private state: CollectorState | null = null;
  private cfg: EridaniConfig | null = null;
  private harnesses: CapabilityMatrix = stageBCaps({ claude: null, codex: null });

  constructor(private readonly deps: EridaniRuntimeDeps) {}

  start(): void {
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
    this.cfg = cfg;
    const machine = cfg!.machine || this.deps.hostname;
    this.state = new CollectorState(path.join(this.deps.dir, COLLECTOR_STATE_FILE));
    this.collector = cfg!.collector === 'off' ? null : new Collector({
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
      send: (r) => this.link?.report(r, true) ?? false,
      warn: (m) => this.deps.log(`eridani collector: ${m}`),
    });
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
      },
      onDelivered: (entry) => {
        if (entry.body.t === 'session.report' && entry.entity && typeof entry.revision === 'string') {
          this.state?.delivered(entry.entity, entry.revision);
        }
      },
      onDirty: (entity) => this.state?.dirty(entity),
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
      this.harnesses = stageBCaps({ claude, codex });
    });
    this.scanTimer = setInterval(() => this.scan(), this.deps.scanMs ?? SCAN_MS);
    this.scanTimer.unref?.();
  }

  /** Entities evicted from the outbox: forget their fingerprints so the next scan sends them again. */
  private takeDirty(): void {
    if (!this.link || !this.state) return;
    const dirty = this.link.spool.takeDirty();
    for (const entity of dirty) this.state.dirty(entity);
    if (dirty.length) this.state.save();
  }

  private scan(): void {
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

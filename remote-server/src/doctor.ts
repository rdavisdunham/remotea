/**
 * `remotea doctor [--json] [--probe]` (S-Q1, Eridani task 0a0c9ff4): one
 * redacted readiness report for this host. Every finding is one line, `ok`,
 * `warn` or `fail`, with a one-line fix for anything that is not ok:
 *
 *   service    the systemd user unit: installed, active, enabled, the user it
 *              runs as and the PATH it gives the server
 *   build      the running server's commit (dirty?), the one on disk, the
 *              link protocol and caps version
 *   listener   port 7717 accepts a connection and answers /healthz; the
 *              token file exists (never read or printed); the hook bridge
 *   collector  mode, node:sqlite, the last scan (parity age)
 *   eridani    configured? key present? link state, last welcome, outbox
 *              backlog, journal, refusals
 *   hooks      the helper, and Claude Code's, Codex's (with Codex's trust
 *              records) and OpenCode's entries against what an install writes
 *   targets    per execution target: the repository, launch readiness per
 *              harness, each verify entry (program on the SERVICE's PATH,
 *              dependencies in the checkout, a database URL when the command
 *              looks like it needs one), isolation, MCP
 *   disk       free space where the config, temp files and worktrees live
 *   uploads    pasted/dropped files against their budget
 *   recovery   managed worktrees holding work no live session owns, and
 *              sessions the registry still holds for a dead process
 *
 * Read-only: it never starts, restarts or installs anything, never fetches
 * (the worktree check runs git with fetch refused) and never prints a key, a
 * token, an environment or a command line; paths under $HOME are written
 * with `~`. `--probe` runs the launch probes (`<bin> --version` through the
 * login shell, as `remotea eridani status --probe`); without it launch
 * readiness comes from the running server's hello.
 *
 * The same report runs inside the server (eridani-runtime.ts) every few
 * minutes; its summary (doctorSummary) goes to Eridani in hello and in
 * `doctor` frames (docs/remotea/eridani-link.md § Doctor).
 *
 * `--json` prints DoctorReport (DOCTOR_VERSION). The exit code is 1 when any
 * check fails, else 0.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { ERIDANI_CAPS_VERSION, ERIDANI_LIMITS, ERIDANI_PROTO, type DoctorSummary, type DoctorWireItem, type HelloTarget, type WorktreeReport } from '../../src/shared/eridani-link-protocol';
import type { RegistryData } from './registry';
import { DEFAULT_CONFIG, loadEridaniConfig, readEridaniToken, type CollectorMode } from './config';
import { hookVersion, loadBuildInfo, readServerInfo, type BuildInfo, type HookVersion, type ServerInfo } from './build-info';
import { agentHookChecks, defaultHookPaths, type AgentHookCheck, type HookPaths } from './hooks-install';
import { readLinkStatus, type CollectorLinkStatus, type LinkStatus } from './eridani-link';
import { loadTargets, type ExecutionTarget, type VerifySpec } from './eridani-targets';
import { defaultProbe, launchersToProbe, probeKey, type LauncherProbe, type ProbeFn } from './launch-caps';
import { localReadiness, redact, serviceEnv, which } from './eridani-setup';
import { WorktreeManager, runGit, type GitRunner } from './worktrees';
import { COLLECTOR_STATE_FILES } from './collector/state';
import { probeSqlite } from './collector/codex-sqlite';

export const DOCTOR_VERSION = 1;

export type DoctorLevel = 'ok' | 'warn' | 'fail';
export type DoctorSection = 'service' | 'build' | 'listener' | 'collector' | 'eridani' | 'hooks' | 'targets' | 'disk' | 'uploads' | 'recovery';
export const DOCTOR_SECTIONS: readonly DoctorSection[] = ['service', 'build', 'listener', 'collector', 'eridani', 'hooks', 'targets', 'disk', 'uploads', 'recovery'];

export interface DoctorItem {
  /** Stable, dotted: `service.active`, `target.<id>.verify.<id>`, … */
  id: string;
  section: DoctorSection;
  level: DoctorLevel;
  /** One line, redacted. */
  summary: string;
  /** One line: what to run or change. Present for warn and fail. */
  fix?: string;
}

/** `remotea doctor --json`. Additions are backwards compatible; a breaking change bumps `version`. */
export interface DoctorReport {
  version: number;
  /** Epoch ms. */
  at: number;
  hostname: string;
  /** The launch probes ran now (`--probe`). */
  probed: boolean;
  ok: number;
  warn: number;
  fail: number;
  items: DoctorItem[];
}

// ── Facts ───────────────────────────────────────────────────────────────────

export interface ServiceFacts {
  unitFile: string;
  installed: boolean;
  /** `systemctl --user is-active remotea`; null when systemctl could not be asked. */
  active: string | null;
  enabled: string | null;
  /** The unit's User=, else the user running this check (a user unit runs as its owner). */
  user: string;
  /** The unit's Environment=PATH, null when it sets none. */
  path: string | null;
}

export interface ListenerFacts {
  port: number;
  accepting: boolean;
  healthy: boolean;
  /** 0: the hook bridge is off. */
  hookPort: number;
  hookAccepting: boolean | null;
  token: { present: boolean; mode: number | null };
}

export interface DiskFacts {
  id: string;
  label: string;
  path: string;
  free: number | null;
  total: number | null;
}

export interface UploadFacts {
  bytes: number;
  files: number;
  budget: number;
  /** `server`: the running server's uploads-status.json; `measured`: counted here. */
  source: 'server' | 'measured';
  degraded: string | null;
}

export interface DoctorFacts {
  now: number;
  hostname: string;
  home: string;
  probed: boolean;
  service: ServiceFacts;
  listener: ListenerFacts;
  /** The running server's server-info.json (null: not running, or an older build). */
  running: ServerInfo | null;
  diskBuild: BuildInfo;
  helper: HookVersion;
  agentHooks: AgentHookCheck[];
  eridani: {
    configured: boolean;
    enabled: boolean;
    keyPresent: boolean;
    mode: CollectorMode;
    /** The link as the running server reports it (null: none running it). */
    link: LinkStatus | null;
  };
  collector: { sqlite: string | null; stateMtime: number | null; scan: CollectorLinkStatus | null };
  targets: ExecutionTarget[];
  readiness: HelloTarget[];
  /** Where launch and verify readiness came from. */
  readinessSource: 'probed' | 'hello' | 'disk';
  /** The environment verify runs with (the unit's PATH). */
  serviceEnv: NodeJS.ProcessEnv;
  bwrap: string | null;
  disks: DiskFacts[];
  uploads: UploadFacts | null;
  /** Managed worktrees (null: no targets); `error` when they could not be inspected. */
  worktrees: WorktreeReport[] | { error: string } | null;
  registry: RegistryData | null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const MIN = 60_000;

export function fmtBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(1)} MiB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
  return `${n} B`;
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** A path under $HOME written with `~`. */
export function tilde(p: string, home: string): string {
  if (!home || home === '/') return p;
  const h = home.endsWith('/') ? home.slice(0, -1) : home;
  return p === h ? '~' : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** Every `$HOME/…` inside a line written with `~`, and anything that looks like a key masked. */
export function scrub(s: string, home: string): string {
  let out = redact(s);
  const h = home.endsWith('/') ? home.slice(0, -1) : home;
  if (h && h !== '/') out = out.split(`${h}/`).join('~/').replace(new RegExp(`${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s:;,)'"\`])`, 'g'), '~');
  return out;
}

const short = (b: { sha: string; dirty: boolean | null }) => (b.sha === 'unknown' ? 'unknown' : `${b.sha.slice(0, 12)}${b.dirty ? '+dirty' : ''}`);
const AGENT_NAME: Record<AgentHookCheck['agent'], string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
/** An id segment: what a target or verify id may contain, anything else as `_`. */
const seg = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);

// ── Evaluate: facts → findings (pure) ──────────────────────────────────────────

export function evaluate(f: DoctorFacts): DoctorItem[] {
  const items: DoctorItem[] = [];
  const add = (section: DoctorSection, id: string, level: DoctorLevel, summary: string, fix?: string) => {
    items.push({ id, section, level, summary, ...(level !== 'ok' && fix ? { fix } : {}) });
  };
  const t = (p: string) => tilde(p, f.home);
  const serverUp = f.listener.healthy;

  // service
  const s = f.service;
  if (!s.installed) add('service', 'service.unit', serverUp ? 'warn' : 'fail', `no systemd user unit at ${t(s.unitFile)}${serverUp ? ' (a server answers, started by hand?)' : ''}`, 'cd remote-server && ./scripts/install.sh');
  else {
    add('service', 'service.unit', 'ok', `unit installed: ${t(s.unitFile)}`);
    if (s.active === null) add('service', 'service.active', serverUp ? 'ok' : 'warn', `systemctl --user could not be asked${serverUp ? '; a server answers on the port' : ''}`, 'check that systemd runs in WSL ([boot] systemd=true in /etc/wsl.conf)');
    else if (s.active === 'active') {
      if (s.enabled && s.enabled !== 'enabled') add('service', 'service.active', 'warn', `remotea.service is active but ${s.enabled}: it will not start with WSL`, 'systemctl --user enable remotea');
      else add('service', 'service.active', 'ok', 'remotea.service is active and enabled');
    } else add('service', 'service.active', 'fail', `remotea.service is ${s.active}`, 'systemctl --user start remotea; then journalctl --user -u remotea -n 50');
    add('service', 'service.user', 'ok', `runs as ${s.user}`);
    if (s.path) add('service', 'service.path', 'ok', `PATH from the unit: ${s.path.split(':').map(t).join(':')}`);
    else add('service', 'service.path', 'warn', 'the unit sets no PATH: verify entries and probes see the default PATH', 'run ./scripts/install.sh again (it writes PATH into the unit)');
  }

  // build
  const r = f.running;
  if (!r) {
    add('build', 'build.running', 'warn', serverUp ? 'a server answers but wrote no server-info.json (an older build): its commit is unknown' : 'no running server: its build is unknown', serverUp ? 'systemctl --user restart remotea (running processes end; the apps respawn them)' : 'systemctl --user start remotea');
    add('build', 'build.disk', 'ok', `on disk: ${short(f.diskBuild)}`);
  } else {
    if (r.build.sha === 'unknown') add('build', 'build.running', 'warn', `running server (pid ${r.pid}) was built without git: its commit is unknown`, 'build from a git checkout: npm run build');
    else if (r.build.dirty) add('build', 'build.running', 'warn', `running ${short(r.build)}: built with uncommitted changes`, 'commit, then npm run build and systemctl --user restart remotea');
    else add('build', 'build.running', 'ok', `running ${short(r.build)} (version ${r.version}, up ${fmtAgo(f.now - r.startedAt)})`);
    if (r.build.sha !== f.diskBuild.sha || r.build.dirty !== f.diskBuild.dirty) add('build', 'build.disk', 'warn', `on disk ${short(f.diskBuild)} differs from the running ${short(r.build)}: a restart would run it`, 'systemctl --user restart remotea (running processes end; the apps respawn them)');
    else add('build', 'build.disk', 'ok', 'the build on disk is the one running');
  }
  add('build', 'build.caps', 'ok', `Eridani link proto ${r?.proto ?? ERIDANI_PROTO}, caps v${r?.capsVersion ?? ERIDANI_CAPS_VERSION}`);

  // listener
  const l = f.listener;
  if (l.accepting && l.healthy) add('listener', 'listener.port', 'ok', `127.0.0.1:${l.port} accepts connections and answers /healthz`);
  else if (l.accepting) add('listener', 'listener.port', 'warn', `127.0.0.1:${l.port} accepts connections but /healthz does not answer 200 (another program?)`, `ss -ltnp 'sport = :${l.port}'`);
  else add('listener', 'listener.port', 'fail', `nothing accepts connections on 127.0.0.1:${l.port}`, 'systemctl --user start remotea; then journalctl --user -u remotea -n 50');
  if (!l.token.present) add('listener', 'listener.token', 'fail', 'no access token: apps cannot connect', 'remotea token (creates one)');
  else if (l.token.mode !== null && (l.token.mode & 0o077) !== 0) add('listener', 'listener.token', 'warn', `the token file is readable by others (mode ${l.token.mode.toString(8)})`, 'chmod 600 ~/.config/remotea/token');
  else add('listener', 'listener.token', 'ok', 'access token present (0600; not shown)');
  if (l.hookPort === 0) add('listener', 'listener.hooks', 'ok', 'hook bridge off (hookPort 0)');
  else if (l.hookAccepting) add('listener', 'listener.hooks', 'ok', `hook bridge accepts on 127.0.0.1:${l.hookPort}`);
  else if (serverUp) add('listener', 'listener.hooks', 'warn', `hook bridge on 127.0.0.1:${l.hookPort} does not accept: agents' status will not reach the apps`, 'journalctl --user -u remotea | grep -i hook');

  // collector
  const e = f.eridani;
  if (!e.configured) add('collector', 'collector.mode', 'ok', 'no Eridani link set up: the collector does not run');
  else {
    add('collector', 'collector.mode', 'ok', `collector ${e.mode}${e.mode === 'parity' ? ' (Eridani compares reports; the Python collector stays authoritative)' : ''}`);
    const sqlite = f.collector.scan?.codexUnavailable !== undefined ? f.collector.scan?.codexUnavailable ?? null : f.collector.sqlite;
    if (sqlite) add('collector', 'collector.sqlite', 'warn', `${sqlite.split('\n')[0]} Codex sessions are not collected`, 'install Node ≥ 22.13, then run ./scripts/install.sh again');
    else add('collector', 'collector.sqlite', 'ok', `node:sqlite available: Codex sessions are read${f.collector.scan ? '' : ' (by this CLI\'s node)'}`);
    if (e.mode !== 'off') {
      const scan = f.collector.scan;
      const ready = e.link?.state === 'ready';
      if (scan?.lastScanAt) {
        const age = f.now - scan.lastScanAt;
        if (scan.lastScanError) add('collector', 'collector.scan', 'warn', `last scan failed ${fmtAgo(age)} ago: ${scan.lastScanError}`, 'journalctl --user -u remotea | grep collector');
        else if (ready && age > 10 * MIN) add('collector', 'collector.scan', 'warn', `last scan ${fmtAgo(age)} ago (it runs every 2 min while the link is ready)`, 'remotea eridani collect; journalctl --user -u remotea | grep collector');
        else if (scan.lastScan?.failed) add('collector', 'collector.scan', 'warn', `last scan ${fmtAgo(age)} ago: ${scan.lastScan.failed} report(s) not queued (outbox full?)`, 'remotea eridani status');
        else add('collector', 'collector.scan', 'ok', `last scan ${fmtAgo(age)} ago: ${scan.lastScan?.seen ?? 0} session(s), ${scan.lastScan?.queued ?? 0} report(s) queued`);
      } else if (ready && scan) add('collector', 'collector.scan', 'warn', 'no collector scan since the link came up', 'remotea eridani collect');
      else if (f.collector.stateMtime) add('collector', 'collector.scan', 'ok', `last delivered report ${fmtAgo(f.now - f.collector.stateMtime)} ago (${e.mode})`);
      else add('collector', 'collector.scan', e.enabled && ready ? 'warn' : 'ok', 'no collector report delivered yet', 'remotea eridani collect');
    }
  }

  // eridani
  if (!e.configured) add('eridani', 'eridani.link', 'ok', 'Eridani link not set up (optional)');
  else if (!e.enabled) add('eridani', 'eridani.link', 'ok', 'Eridani link disabled');
  else if (!e.keyPresent) add('eridani', 'eridani.link', 'fail', 'link enabled but the link key is missing', 'remotea eridani setup (paste the setup code from Eridani)');
  else if (!serverUp) add('eridani', 'eridani.link', 'warn', 'link enabled; the server is not running', 'systemctl --user start remotea');
  else if (!e.link) add('eridani', 'eridani.link', 'warn', 'link enabled but the running server reports no link (just started, or an older build)', 'wait 30 s and run remotea eridani status; else systemctl --user restart remotea');
  else {
    const k = e.link;
    const welcome = k.lastConnectedAt ? `last welcome ${fmtAgo(f.now - k.lastConnectedAt)} ago` : 'never welcomed';
    if (k.state === 'ready') add('eridani', 'eridani.link', 'ok', `ready: host ${k.hostId ?? '-'}, ${welcome}`);
    else if (k.state === 'auth-failed') add('eridani', 'eridani.link', 'fail', `Eridani refused the link key (retried every 5 min); ${welcome}`, 'remotea eridani setup (paste a new setup code)');
    else add('eridani', 'eridani.link', 'warn', `link ${k.state}${k.error ? `: ${k.error}` : ''}; ${welcome}`, 'remotea eridani status; journalctl --user -u remotea | grep eridani');
    const outbox = `${k.unacked} unacked, ${k.spool.entries} in the outbox (${Math.round(k.spool.fill * 100)}% full)`;
    const spoolDegraded = k.journal ? k.spool.degraded ?? null : k.degraded;
    if (spoolDegraded) add('eridani', 'eridani.backlog', 'fail', `outbox degraded (${spoolDegraded}): events are kept only in memory; ${outbox}`, 'free disk space under ~/.config/remotea');
    else if (k.spool.fill >= 0.8) add('eridani', 'eridani.backlog', 'warn', `outbox nearly full: ${outbox}; collector scans pause above 80%`, 'remotea eridani status (is the link ready?)');
    else if (k.unacked > 0 && k.state === 'ready' && k.lastAckAt !== null && f.now - k.lastAckAt > 10 * MIN) add('eridani', 'eridani.backlog', 'warn', `${outbox}; no ack for ${fmtAgo(f.now - k.lastAckAt)}`, 'remotea eridani status; journalctl --user -u remotea | grep eridani');
    else add('eridani', 'eridani.backlog', 'ok', outbox);
    if (k.journal?.degraded) add('eridani', 'eridani.journal', 'fail', `command journal degraded (${k.journal.degraded}): Eridani's commands are refused`, 'free disk space under ~/.config/remotea');
    else if (k.journal) add('eridani', 'eridani.journal', 'ok', 'command journal writable');
    if (k.rejected) add('eridani', 'eridani.rejected', 'warn', `Eridani refused ${k.rejected} event(s) for good (last: ${k.lastRejection ?? '?'})`, 'remotea eridani status; journalctl --user -u remotea | grep refused');
  }

  // hooks
  if (!f.helper.installed) add('hooks', 'hooks.helper', 'warn', 'hook helper not installed: agents in remotea terminals do not report their status', 'remotea hooks install');
  else if (f.helper.current === false) add('hooks', 'hooks.helper', 'warn', `hook helper ${f.helper.installed} is stale (this build ships ${f.helper.bundled})`, 'remotea hooks install');
  else add('hooks', 'hooks.helper', 'ok', `hook helper ${f.helper.installed}${f.helper.current ? ' (current)' : ''}`);
  for (const h of f.agentHooks) {
    const name = AGENT_NAME[h.agent];
    const id = `hooks.${h.agent}`;
    if (!h.present) add('hooks', id, 'ok', `${name} not installed here`);
    else if (h.unreadable) add('hooks', id, 'warn', `${t(h.file)} is not valid JSON: remotea's entries cannot be checked`, `fix the JSON in ${t(h.file)}, then remotea hooks install`);
    else if (!h.entries) add('hooks', id, 'warn', `${name} has no remotea hooks: its sessions do not report status to the apps or Eridani`, 'remotea hooks install');
    else if (h.entries !== h.expected) add('hooks', id, 'warn', `${name}: ${h.entries} remotea hook entries, an install writes ${h.expected} (an older install)`, 'remotea hooks install');
    else if (h.helperPath === false) add('hooks', id, 'warn', `${name}'s remotea hooks run a helper outside ~/.local/share/remotea/cli`, 'remotea hooks install');
    else if (h.version && h.version.installed && h.version.bundled && h.version.installed !== h.version.bundled) add('hooks', id, 'warn', `${name} plugin ${h.version.installed} is stale (this build ships ${h.version.bundled})`, 'remotea hooks install');
    else add('hooks', id, 'ok', `${name}: ${h.entries} remotea hook ${h.agent === 'opencode' ? 'plugin' : 'entries'}, current`);
    if (h.agent === 'codex' && h.present && h.entries) {
      const tr = h.trust;
      if (tr === null || tr === undefined) add('hooks', 'hooks.codex.trust', 'ok', 'Codex trust records: none in config.toml (an older Codex, or none approved yet)');
      else if (tr.disabled) add('hooks', 'hooks.codex.trust', 'warn', `${tr.disabled} of ${tr.total} remotea hook entries are disabled in Codex's config.toml`, 'start codex in a terminal and enable the remotea hooks when it asks (or remove enabled = false)');
      else if (tr.trusted < tr.total) add('hooks', 'hooks.codex.trust', 'warn', `Codex has no trust record for ${tr.total - tr.trusted} of ${tr.total} remotea hook entries: it asks to review hooks at its next start`, 'start codex once in a terminal and approve the hooks');
      else add('hooks', 'hooks.codex.trust', 'ok', `Codex has a trust record for all ${tr.total} remotea hook entries (the hash itself is not checked)`);
    }
  }

  // targets
  if (!f.targets.length) {
    if (e.configured) add('targets', 'targets', 'warn', 'no execution targets: Eridani cannot start work here', 'remotea eridani setup --add-repo <path> (or remotea eridani targets add)');
  } else {
    const via = f.readinessSource === 'probed' ? 'probed now' : f.readinessSource === 'hello' ? "from the running server's hello" : 'not probed';
    for (const tg of f.targets) {
      const tid = `target.${seg(tg.id)}`;
      const ready = f.readiness.find((x) => x.id === tg.id);
      if (!fs.existsSync(path.join(tg.repo, '.git'))) add('targets', `${tid}.repo`, 'fail', `${tg.id}: ${t(tg.repo)} is missing or not a git checkout`, `fix the path, or remotea eridani targets remove ${tg.id}`);
      else add('targets', `${tid}.repo`, 'ok', `${tg.id}: ${t(tg.repo)}, worktrees in ${t(tg.worktreeRoot)}, base ${tg.base}`);
      const enabled = (['claude', 'codex'] as const).filter((h) => tg.launch[h]);
      if (!enabled.length) add('targets', `${tid}.launch`, 'fail', `${tg.id}: no harness enabled`, `enable one: remotea eridani targets add --json '<target with launch.claude>'`);
      for (const h of enabled) {
        const p = ready?.launch?.[h];
        const bin = tg.launch[h]?.bin ?? h;
        if (!p || (!p.ready && p.error === 'not probed yet')) add('targets', `${tid}.launch.${h}`, 'warn', `${tg.id}: ${h} launch not probed yet`, 'remotea doctor --probe (runs `<bin> --version` through the login shell)');
        else if (p.ready) add('targets', `${tid}.launch.${h}`, 'ok', `${tg.id}: ${h}${p.version ? ` ${p.version}` : ''} starts through the login shell (${via})`);
        else add('targets', `${tid}.launch.${h}`, 'fail', `${tg.id}: ${h} cannot start: ${p.error ?? 'probe failed'}`, `put \`${path.basename(bin)}\` on the login shell's PATH, or set launch.${h}.bin to its absolute path`);
      }
      if (!tg.verify.length) add('targets', `${tid}.verify`, 'warn', `${tg.id}: no verify entry: Eridani cannot run checks here`, `remotea eridani targets add --id ${tg.id} … --verify test=<command>`);
      for (const v of tg.verify) {
        const vid = `${tid}.verify.${seg(v.id)}`;
        const st = (ready?.verify_status ?? []).find((x) => x.id === v.id);
        if (st && !st.ready) add('targets', vid, 'fail', `${tg.id}/${v.id}: ${st.reason ?? 'not ready'}`, 'use an absolute program path, or set PATH in the entry\'s env');
        else add('targets', vid, 'ok', `${tg.id}/${v.id}: \`${path.basename(v.argv[0] ?? '?')}\` resolves on the service PATH`);
        const deps = depsCheck(tg.repo, v);
        if (deps) add('targets', `${vid}.deps`, deps.ok ? 'ok' : 'warn', `${tg.id}/${v.id}: ${deps.summary}`, deps.fix);
        const db = dbCheck(tg.repo, v);
        if (db) add('targets', `${vid}.db`, db.ok ? 'ok' : 'warn', `${tg.id}/${v.id}: ${db.summary}`, db.fix);
      }
      const mcp = ready?.mcp;
      if (mcp?.configured) add('targets', `${tid}.mcp`, 'ok', `${tg.id}: spawned agents get Eridani's MCP tools`);
      else add('targets', `${tid}.mcp`, 'warn', `${tg.id}: spawned agents get no Eridani MCP tools: ${mcp?.reason ?? 'unknown'}`, 'remotea eridani setup (saves the MCP bot key)');
    }
    // Isolation: per entry when the build reports it (verify-sandbox.ts), else whether bubblewrap is there at all.
    const withVerify = f.targets.filter((x) => x.verify.length);
    if (withVerify.length) {
      const entries = f.readiness.flatMap((x) => (x.verify_status ?? []).map((v) => ({ target: x.id, ...(v as { id: string; isolated?: boolean; isolation_reason?: string }) })));
      const reported = entries.filter((v) => typeof v.isolated === 'boolean');
      if (reported.length) {
        const open = reported.filter((v) => !v.isolated);
        if (open.length) add('targets', 'targets.isolation', 'warn', `${open.length} verify entr${open.length === 1 ? 'y runs' : 'ies run'} unisolated: ${open.slice(0, 3).map((v) => `${v.target}/${v.id}${v.isolation_reason ? ` (${v.isolation_reason})` : ''}`).join('; ')}`, 'sudo apt install bubblewrap (or set isolation "none" on purpose)');
        else add('targets', 'targets.isolation', 'ok', `all ${reported.length} verify entries run in a bubblewrap sandbox`);
      } else if (f.bwrap) add('targets', 'targets.isolation', 'ok', `bubblewrap is on the service PATH (${t(f.bwrap)}): verification can be isolated`);
      else add('targets', 'targets.isolation', 'warn', 'bubblewrap (bwrap) is not on the service PATH: verification cannot be isolated', 'sudo apt install bubblewrap');
    }
  }

  // disk
  for (const d of f.disks) {
    if (d.free === null || d.total === null) {
      add('disk', d.id, 'warn', `${d.label} (${t(d.path)}): free space cannot be read`, `df -h ${t(d.path)}`);
      continue;
    }
    const ratio = d.total ? d.free / d.total : 1;
    const text = `${d.label} (${t(d.path)}): ${fmtBytes(d.free)} free of ${fmtBytes(d.total)} (${Math.round(ratio * 100)}%)`;
    if (d.free < GiB || ratio < 0.01) add('disk', d.id, 'fail', text, 'free disk space (a full disk stops the journal and the outbox)');
    else if (d.free < 5 * GiB || ratio < 0.05) add('disk', d.id, 'warn', text, 'free disk space soon');
    else add('disk', d.id, 'ok', text);
  }

  // uploads
  const u = f.uploads;
  if (u) {
    const text = `pasted/dropped files: ${fmtBytes(u.bytes)} in ${u.files} file(s) of a ${fmtBytes(u.budget)} budget${u.source === 'measured' ? ' (counted now)' : ''}`;
    if (u.degraded) add('uploads', 'uploads.budget', 'warn', `${text}; degraded: ${u.degraded}`, 'free space in the temp folder; old drops go after their age limit');
    else if (u.bytes > u.budget) add('uploads', 'uploads.budget', 'warn', `${text}: over budget`, 'remove old /tmp/remotea-drop-* folders no pane still needs');
    else if (u.bytes > 0.9 * u.budget) add('uploads', 'uploads.budget', 'warn', `${text}: over 90%`, 'remove old /tmp/remotea-drop-* folders no pane still needs');
    else add('uploads', 'uploads.budget', 'ok', text);
  }

  // recovery
  if (f.worktrees && 'error' in f.worktrees) add('recovery', 'recovery.worktrees', 'warn', `managed worktrees could not be inspected: ${f.worktrees.error}`, 'remotea eridani worktrees');
  else if (f.worktrees) {
    const stranded = f.worktrees.filter((w) => !w.active && !w.candidate);
    if (stranded.length) {
      const names = stranded.slice(0, 3).map((w) => `${w.branch ?? t(w.path)} (${w.reasons[0] ?? 'unmerged'})`).join('; ');
      add('recovery', 'recovery.worktrees', 'warn', `${stranded.length} managed worktree(s) hold work no live session owns: ${names}${stranded.length > 3 ? '; …' : ''}`, 'remotea eridani worktrees (shows what each would lose; never removes)');
    } else add('recovery', 'recovery.worktrees', 'ok', `${f.worktrees.length} managed worktree(s); none holds work outside a live session`);
  }
  if (f.registry) {
    const sessions = Object.values(f.registry.sessions ?? {});
    const issues: string[] = [];
    if (r) {
      const stale = sessions.filter((x) => x.state === 'live' && x.bootId !== r.bootId);
      if (stale.length) issues.push(`${stale.length} session(s) marked live by an earlier server boot (a stale PTY lease)`);
    }
    const lost = sessions.filter((x) => x.state === 'lost' && x.eridani);
    if (lost.length) issues.push(`${lost.length} Eridani session(s) lost and not resumed`);
    const stuck = sessions.filter((x) => x.state !== 'exited' && x.eridani?.stopRequested && f.now - x.eridani.stopRequested.at > 10 * MIN);
    if (stuck.length) issues.push(`${stuck.length} session(s) asked to stop over 10 min ago and still running`);
    if (issues.length) add('recovery', 'recovery.sessions', 'warn', issues.join('; '), 'remotea status (then remotea close <surf-id> for any that should end)');
    else add('recovery', 'recovery.sessions', 'ok', `${sessions.filter((x) => x.state !== 'exited').length} session(s) held, none stale`);
  }

  // Redaction, last: whatever went into a line, no key and no home path leave this function.
  return items.map((i) => ({ ...i, summary: scrub(i.summary, f.home), ...(i.fix ? { fix: scrub(i.fix, f.home) } : {}) }));
}

const NODE_RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'vitest', 'jest', 'tsc']);
const PY_RUNNERS = new Set(['pytest', 'python', 'python3', 'py.test', 'alembic']);

/** Does the verify command need dependencies that are not in the checkout? null: no recognised toolchain. */
export function depsCheck(repo: string, v: VerifySpec): { ok: boolean; summary: string; fix?: string } | null {
  const cwd = v.cwd ? path.resolve(repo, v.cwd) : repo;
  const prog = path.basename(v.argv[0] ?? '');
  const installs = v.argv.some((a) => a === 'ci' || a === 'install' || a === 'sync');
  if (NODE_RUNNERS.has(prog) && fs.existsSync(path.join(cwd, 'package.json'))) {
    if (installs) return { ok: true, summary: 'installs its node dependencies itself' };
    if (fs.existsSync(path.join(cwd, 'node_modules'))) return { ok: true, summary: 'node_modules present in the checkout (new worktrees start without it)' };
    return { ok: false, summary: `no node_modules in ${v.cwd ?? 'the repository'}: \`${prog}\` will not find its dependencies`, fix: 'make the entry run a script that installs first (npm ci), or run npm ci in the checkout' };
  }
  if (PY_RUNNERS.has(prog) && !path.isAbsolute(v.argv[0] ?? '')) {
    const hasProject = ['pyproject.toml', 'requirements.txt', 'setup.py', 'uv.lock'].some((x) => fs.existsSync(path.join(cwd, x)) || fs.existsSync(path.join(repo, x)));
    if (!hasProject) return null;
    if (fs.existsSync(path.join(cwd, '.venv')) || fs.existsSync(path.join(repo, '.venv'))) return { ok: true, summary: '.venv present in the checkout, but a bare `' + prog + '` runs the service PATH\'s interpreter, not the venv\'s' };
    return { ok: false, summary: `no .venv for this Python project: a bare \`${prog}\` runs without its dependencies`, fix: 'use uv run (or the venv\'s absolute python), or a script that syncs first' };
  }
  return null;
}

const DB_HINT = /(^|[/\s])(pytest|py\.test|alembic|manage\.py|prisma|knex|sequelize)(\s|$)/;
const DB_ENV = /(DATABASE_URL|DB_URL|_DSN)$|^PG(HOST|DATABASE|URL)$/;

/** When the command looks like it talks to a database, does its env name one? null: it does not look like it. */
export function dbCheck(repo: string, v: VerifySpec): { ok: boolean; summary: string; fix?: string } | null {
  const cwd = v.cwd ? path.resolve(repo, v.cwd) : repo;
  const direct = DB_HINT.test(v.argv.join(' '));
  const project = fs.existsSync(path.join(cwd, 'alembic.ini')) || fs.existsSync(path.join(repo, 'alembic.ini'));
  // A wrapper script (scripts/verify.sh) sets its own environment: not judged.
  if (!direct || !project) return null;
  const keys = Object.keys(v.env ?? {}).filter((k) => DB_ENV.test(k));
  if (keys.length) return { ok: true, summary: `database URL set in the entry's env (${keys.join(', ')}; value not shown)` };
  return { ok: false, summary: 'the command looks like it needs a database (alembic.ini) but its env sets no *DATABASE_URL: verify runs with a minimal environment', fix: 'add the test database URL to the entry\'s env, or run a wrapper script that sets it' };
}

// ── Summary for Eridani ─────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What hello and `doctor` frames carry: counts, then every warn and fail (fail first), capped and clipped. */
export function doctorSummary(report: Pick<DoctorReport, 'at' | 'ok' | 'warn' | 'fail' | 'items'>): DoctorSummary {
  const bad = report.items.filter((i) => i.level !== 'ok');
  const ordered = [...bad.filter((i) => i.level === 'fail'), ...bad.filter((i) => i.level === 'warn')];
  const items: DoctorWireItem[] = ordered.slice(0, ERIDANI_LIMITS.doctorItems).map((i) => ({
    id: clip(i.id, ERIDANI_LIMITS.doctorIdChars),
    level: i.level as 'warn' | 'fail',
    summary: clip(i.summary || '-', ERIDANI_LIMITS.doctorTextChars),
    ...(i.fix ? { fix: clip(i.fix, ERIDANI_LIMITS.doctorTextChars) } : {}),
  }));
  return { at: report.at, ok: report.ok, warn: report.warn, fail: report.fail, items, ...(ordered.length > items.length ? { truncated: true } : {}) };
}

export function buildReport(f: DoctorFacts): DoctorReport {
  const items = evaluate(f);
  const count = (l: DoctorLevel) => items.filter((i) => i.level === l).length;
  return { version: DOCTOR_VERSION, at: f.now, hostname: f.hostname, probed: f.probed, ok: count('ok'), warn: count('warn'), fail: count('fail'), items };
}

/** The human report: one line per check, grouped, with the fix under each warn and fail. */
export function fmtDoctor(r: DoctorReport): string {
  const lines: string[] = [`remotea doctor on ${r.hostname}, ${new Date(r.at).toISOString()}${r.probed ? ' (launchers probed now)' : ''}`];
  const idWidth = Math.min(36, Math.max(...r.items.map((i) => i.id.length), 8));
  for (const section of DOCTOR_SECTIONS) {
    const rows = r.items.filter((i) => i.section === section);
    if (!rows.length) continue;
    lines.push('', section);
    for (const i of rows) {
      const tag = i.level === 'ok' ? 'ok  ' : i.level === 'warn' ? 'WARN' : 'FAIL';
      lines.push(`  ${tag}  ${i.id.padEnd(idWidth)}  ${i.summary}`);
      if (i.fix) lines.push(`  ${' '.repeat(4)}  ${' '.repeat(idWidth)}  fix: ${i.fix}`);
    }
  }
  lines.push('', `${r.ok} ok, ${r.warn} warn, ${r.fail} fail`);
  return lines.join('\n') + '\n';
}

// ── Gather: the real host → facts ───────────────────────────────────────────────

export interface GatherOptions {
  dir: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  hostname?: string;
  /** Run the launch probes now (`--probe`); a function replaces the real probe (tests). */
  probe?: boolean | ProbeFn;
  /** `systemctl --user <args>` stdout, or null when systemctl cannot be run. */
  systemctl?: (args: string[]) => Promise<string | null>;
  /** Does 127.0.0.1:port accept a TCP connection? */
  accepts?: (port: number) => Promise<boolean>;
  /** Does 127.0.0.1:port answer GET /healthz with 200? */
  healthz?: (port: number) => Promise<boolean>;
  statfs?: (p: string) => { free: number; total: number } | null;
  hookPaths?: HookPaths;
  tmpDir?: string;
  /** Inside the server: its own link status, readiness, worktrees and registry instead of reading them from disk. */
  link?: LinkStatus | null;
  readiness?: HelloTarget[];
  /** null: not known yet (the check is left out). */
  worktrees?: () => Promise<WorktreeReport[] | null>;
  registry?: RegistryData | null;
  /** Inside the server: the collector's last scan. */
  collector?: CollectorLinkStatus | null;
  /** Tests: git for the worktree check (fetch is refused either way). */
  git?: GitRunner;
  serverInfo?: ServerInfo | null;
  diskBuild?: BuildInfo;
}

const run = (file: string, args: string[], timeoutMs = 3000): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      // is-active / is-enabled exit non-zero for "inactive" and "disabled" but still print the state.
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
      const out = String(stdout ?? '').trim();
      resolve(out || (err ? null : ''));
    });
  });

export const realSystemctl = (args: string[]) => run('systemctl', ['--user', ...args]);

export function tcpAccepts(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export function healthzOk(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

export function statfs(p: string): { free: number; total: number } | null {
  try {
    const s = fs.statfsSync(p);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** The nearest folder that exists at or above `p` (a worktree root not created yet lives on its parent's disk). */
function existingAncestor(p: string): string {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

/** config.json without creating it (loadConfig writes a default one). */
function readServerConfig(dir: string): { port: number; hookPort: number; uploadBudgetMiB: number } {
  let user: Record<string, unknown> = {};
  try {
    user = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return { port: num(user.port, DEFAULT_CONFIG.port), hookPort: num(user.hookPort, DEFAULT_CONFIG.hookPort), uploadBudgetMiB: num(user.uploadBudgetMiB, 2048) };
}

function readRegistry(dir: string): RegistryData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')) as RegistryData;
  } catch {
    return null;
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The running server's uploads-status.json when recent (a newer build writes it), else /tmp/remotea-drop-* counted now. */
function uploadFacts(dir: string, tmpDir: string, budgetMiB: number, serverUp: boolean, now: number): UploadFacts {
  if (serverUp) {
    try {
      const u = JSON.parse(fs.readFileSync(path.join(dir, 'uploads-status.json'), 'utf8')) as Record<string, unknown>;
      if (typeof u.bytes === 'number' && typeof u.budget === 'number' && typeof u.at === 'number' && now - u.at < 30 * MIN) {
        return { bytes: u.bytes, files: typeof u.files === 'number' ? u.files : 0, budget: u.budget, source: 'server', degraded: typeof u.degraded === 'string' ? u.degraded : null };
      }
    } catch {
      /* count it here */
    }
  }
  let bytes = 0;
  let files = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(tmpDir).filter((n) => n.startsWith('remotea-drop-'));
  } catch {
    /* none */
  }
  for (const n of names) {
    try {
      for (const f of fs.readdirSync(path.join(tmpDir, n))) {
        const st = fs.statSync(path.join(tmpDir, n, f));
        if (st.isFile()) {
          bytes += st.size;
          files++;
        }
      }
    } catch {
      /* not ours to read */
    }
  }
  return { bytes, files, budget: budgetMiB * MiB, source: 'measured', degraded: null };
}

/** git that refuses to fetch: the doctor never touches the network. */
function noFetch(git: GitRunner): GitRunner {
  return (args, cwd, o) => (args[0] === 'fetch' ? Promise.resolve({ code: 1, stdout: '', stderr: 'fetch skipped by remotea doctor' }) : git(args, cwd, o));
}

export async function gatherFacts(o: GatherOptions): Promise<DoctorFacts> {
  const dir = o.dir;
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const now = (o.now ?? Date.now)();
  const systemctl = o.systemctl ?? realSystemctl;
  const cfg = readServerConfig(dir);

  // service
  const unitFile = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'remotea.service');
  let unit: string | null = null;
  try {
    unit = fs.readFileSync(unitFile, 'utf8');
  } catch {
    /* not installed */
  }
  const [active, enabled] = unit !== null ? await Promise.all([systemctl(['is-active', 'remotea']), systemctl(['is-enabled', 'remotea'])]) : [null, null];
  const unitPath = unit ? /^\s*Environment="?PATH=([^"\n]*)"?\s*$/m.exec(unit)?.[1]?.trim() ?? null : null;
  const unitUser = unit ? /^\s*User=(\S+)\s*$/m.exec(unit)?.[1] ?? null : null;
  let user = unitUser ?? 'unknown';
  if (!unitUser) {
    try {
      user = os.userInfo().username;
    } catch {
      /* unknown */
    }
  }

  // listener
  const accepts = o.accepts ?? ((p: number) => tcpAccepts(p));
  const healthz = o.healthz ?? ((p: number) => healthzOk(p));
  const [accepting, healthy, hookAccepting] = await Promise.all([
    accepts(cfg.port),
    healthz(cfg.port),
    cfg.hookPort ? accepts(cfg.hookPort) : Promise.resolve(null),
  ]);
  let token = { present: false, mode: null as number | null };
  try {
    const st = fs.statSync(path.join(dir, 'token'));
    token = { present: st.isFile() && st.size > 0, mode: st.mode & 0o777 };
  } catch {
    /* missing */
  }

  // build
  const running = o.serverInfo !== undefined ? o.serverInfo : healthy ? readServerInfo(dir) : null;
  const hookPaths = o.hookPaths ?? defaultHookPaths();

  // eridani
  const ecfg = loadEridaniConfig(dir);
  const fileLink = o.link !== undefined ? o.link : readLinkStatus(dir);
  const link = o.link !== undefined ? o.link : fileLink && healthy && fileLink.enabled && pidAlive(fileLink.pid) ? fileLink : null;
  const mode: CollectorMode = ecfg?.collector ?? 'parity';
  let stateMtime: number | null = null;
  try {
    stateMtime = fs.statSync(path.join(dir, COLLECTOR_STATE_FILES[mode === 'authoritative' ? 'authoritative' : 'parity'])).mtimeMs;
  } catch {
    /* none yet */
  }

  // targets and readiness
  const targets = loadTargets(dir, () => {});
  const svc = serviceEnv(home, env).env;
  let readiness: HelloTarget[];
  let readinessSource: DoctorFacts['readinessSource'];
  const probes = new Map<string, LauncherProbe>();
  if (o.readiness) {
    readiness = o.readiness;
    readinessSource = 'hello';
  } else if (o.probe) {
    const probe: ProbeFn = typeof o.probe === 'function' ? o.probe : defaultProbe;
    await Promise.all(launchersToProbe(targets).map(async ({ harness, bin }) => probes.set(probeKey(harness, bin), await probe(harness, bin))));
    readiness = localReadiness(dir, targets, probes, svc);
    readinessSource = 'probed';
  } else {
    const local = localReadiness(dir, targets, probes, svc);
    const adv = link?.advertised?.targets;
    if (adv) {
      // Launch and verify from the running hello (the service's own probes and PATH); mcp, and targets added since, from disk now.
      readiness = local.map((t) => {
        const a = adv.find((x) => x.id === t.id);
        return a ? { ...a, mcp: t.mcp } : t;
      });
      readinessSource = 'hello';
    } else {
      readiness = local;
      readinessSource = 'disk';
    }
  }

  // disk
  const tmpDir = o.tmpDir ?? os.tmpdir();
  const sfs = o.statfs ?? statfs;
  const diskOf = (id: string, label: string, p: string): DiskFacts => {
    const s = sfs(existingAncestor(p));
    return { id, label, path: p, free: s?.free ?? null, total: s?.total ?? null };
  };
  const disks = [diskOf('disk.config', 'config', dir), diskOf('disk.temp', 'temp', tmpDir), ...targets.map((t) => diskOf(`disk.worktrees.${seg(t.id)}`, `worktrees of ${t.id}`, t.worktreeRoot))];

  // recovery
  const registry = o.registry !== undefined ? o.registry : readRegistry(dir);
  let worktrees: DoctorFacts['worktrees'] = null;
  if (targets.length) {
    try {
      if (o.worktrees) worktrees = await o.worktrees();
      else {
        const active = new Set(Object.values(registry?.sessions ?? {}).filter((r) => r.eridani && r.state !== 'exited').map((r) => r.eridani!.worktree));
        worktrees = await new WorktreeManager({ dir, git: noFetch(o.git ?? runGit) }).nominate(targets, (p) => active.has(p));
      }
    } catch (err) {
      worktrees = { error: ((err as Error)?.message ?? String(err)).slice(0, 160) };
    }
  }

  return {
    now,
    hostname: o.hostname ?? os.hostname(),
    home,
    probed: readinessSource === 'probed',
    service: { unitFile, installed: unit !== null, active, enabled, user, path: unitPath },
    listener: { port: cfg.port, accepting, healthy, hookPort: cfg.hookPort, hookAccepting, token },
    running,
    diskBuild: o.diskBuild ?? loadBuildInfo(),
    helper: hookVersion(hookPaths),
    agentHooks: agentHookChecks(hookPaths),
    eridani: { configured: !!ecfg, enabled: !!ecfg?.enabled, keyPresent: readEridaniToken(dir) !== null, mode, link },
    collector: { sqlite: probeSqlite(), stateMtime, scan: o.collector !== undefined ? o.collector : link?.collector ?? null },
    targets,
    readiness,
    readinessSource,
    serviceEnv: svc,
    bwrap: which('bwrap', svc.PATH),
    disks,
    uploads: uploadFacts(dir, tmpDir, cfg.uploadBudgetMiB, healthy, now),
    worktrees,
    registry,
  };
}

export async function runDoctor(o: GatherOptions): Promise<DoctorReport> {
  return buildReport(await gatherFacts(o));
}

/** `remotea doctor [--json] [--probe]`: prints the report; 1 when anything fails. */
export async function doctorCommand(dir: string, args: string[], out: NodeJS.WritableStream = process.stdout, o: Partial<GatherOptions> = {}): Promise<number> {
  for (const a of args) if (a !== '--json' && a !== '--probe') throw new Error(`usage: remotea doctor [--json] [--probe] (unknown option ${a})`);
  const report = await runDoctor({ dir, probe: args.includes('--probe'), ...o });
  out.write(args.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : fmtDoctor(report));
  return report.fail ? 1 : 0;
}

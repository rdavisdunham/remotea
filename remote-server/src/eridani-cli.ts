/**
 * `remotea eridani …`: set up and inspect the link to Eridani.
 *
 *   connect [--url <wss://…>] [--machine <name>] [--no-probe]
 *       Asks for the link key (hidden, on a terminal; read from stdin when
 *       piped), checks it is an `eri_bot_` key, proves it with one hello →
 *       welcome against the URL, then writes `eridani-token` (0600) and
 *       enables the link in `eridani.json`. The running server picks the
 *       change up within 30 s; nothing restarts.
 *   setup [flags]        the whole setup, re-runnable: link, targets, MCP
 *                        key and user-level MCP entries, hooks report,
 *                        readiness table (eridani-setup.ts)
 *   status [--json] [--probe]
 *                        the link as the running server last wrote it, the
 *                        MCP wiring per harness and per-target readiness
 *   disconnect [--forget]
 *       disables the link; --forget also deletes the key
 *   collect [--dry-run] [--days N]
 *       --dry-run prints what the collector would report (like collector.py
 *       --dry-run); without it, asks the running server for a scan now
 *   targets list | add | remove | setup <repo-path>
 *       where Eridani may start work (eridani-targets.ts). `setup` is the
 *       guided way to add one: it proposes the target with a harness, shows
 *       it, tries the check in the verify sandbox only once confirmed, and
 *       asks before saving (eridani-target-setup.ts)
 *   collector [parity|authoritative]
 *   collector scope [remotea|all]
 *       shows or switches the collector mode and prints what to do around
 *       the switch (the cutover checklist, or the rollback). The running
 *       server follows within 30 s; status --json turns v2 in authoritative.
 *
 * The key never appears in output, logs or the status file.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { resolveMcp } from './eridani-mcp';
import {
  ERIDANI_COLLECT_REQUEST,
  ERIDANI_KEY_RE,
  LEGACY_TIMER_HINT,
  ensureServerId,
  forgetEridaniToken,
  linkUrlError,
  loadEridaniConfig,
  readEridaniToken,
  saveEridaniConfig,
  writeEridaniToken,
  type CollectorMode,
  type EridaniConfig,
} from './config';
import { ERIDANI_CAPS_VERSION, ERIDANI_PROTO, ERIDANI_SUBPROTOCOL, ERIDANI_TIMING, parseDownFrame, type HelloTarget, type LinkCap } from '../../src/shared/eridani-link-protocol';
import { helloIdentity, readLinkStatus, type Advertised, type HelloIdentity, type LinkStatus } from './eridani-link';
import { hookVersion, loadBuildInfo } from './build-info';
import { Collector, formatRows } from './collector/collector';
import { CollectorState } from './collector/state';
import { statusFromRegistry } from './collector/report';
import { WINDOWS_USERS, linkCaps, serverVersion } from './eridani-runtime';
import type { RegistryData } from './registry';
import { loadTargets, removeTarget, saveTarget, type ExecutionTarget, type PrepareSpec, type VerifySpec } from './eridani-targets';
import { templateStatus } from './target-template';
import { WorktreeManager, cleanupCommands, writersByPath } from './worktrees';
import { defaultHookPaths } from './hooks-install';
import { defaultProbe, launchersToProbe, probeKey, type LauncherProbe } from './launch-caps';
import { TARGET_SETUP_USAGE, parseTargetSetupArgs, runTargetSetup } from './eridani-target-setup';
import { DEFAULT_VERIFY_TIMEOUT, fmtReadiness, fmtWiring, localReadiness, mcpWiring, parseSetupArgs, readSecret, runSetup, serviceEnv, SETUP_USAGE, stdinLinesOnce, ttyPrompter, noPrompter } from './eridani-setup';

export interface EridaniSummary {
  enabled: boolean;
  url: string | null;
  machine: string;
  collector: string;
  /** Which sessions the collector reports: 'remotea' (default) or 'all'. */
  collectorScope: string;
  keyPresent: boolean;
  /** The link's state as the running server reports it; 'stopped' when no server is running it. */
  state: string;
  link: LinkStatus | null;
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

export function eridaniSummary(dir: string, serverRunning: boolean): EridaniSummary {
  const cfg = loadEridaniConfig(dir);
  const link = readLinkStatus(dir);
  const enabled = !!cfg?.enabled;
  const fresh = !!link && serverRunning && link.enabled && pidAlive(link.pid);
  return {
    enabled,
    url: cfg?.url ?? null,
    machine: cfg?.machine ?? os.hostname(),
    collector: cfg?.collector ?? 'parity',
    collectorScope: cfg?.collector_scope ?? 'remotea',
    keyPresent: readEridaniToken(dir) !== null,
    state: !enabled ? 'disabled' : fresh ? link!.state : 'stopped',
    link: fresh ? link : null,
  };
}

/**
 * The additive `server.eridani` block of `remotea status --json`. `advertised`
 * (S-S1/S-S5): what the running link's hello says now (build, caps,
 * harnesses, targets with launch and verify readiness); null without a link.
 */
export function statusBlock(dir: string, serverRunning: boolean): { enabled: boolean; state: string; unacked: number; lastAckAt: number | null; advertised: Advertised | null } {
  const s = eridaniSummary(dir, serverRunning);
  return { enabled: s.enabled, state: s.state, unacked: s.link?.unacked ?? 0, lastAckAt: s.link?.lastAckAt ?? null, advertised: s.link?.advertised ?? null };
}

/** Human lines for what hello advertises: harness readiness, then each target's launchers and verify entries. */
export function fmtAdvertised(a: Advertised): string[] {
  const lines: string[] = [];
  const hs = Object.entries(a.harnesses).map(([h, c]) => `${h} ${c!.installed === false ? `not installed (${c!.launch_error ?? '?'})` : c!.version ?? 'installed'}${c!.spawn ? ', spawn' : ''}${c!.question ? `, answers ${(c!.question_kinds ?? []).join('/') || 'questions'}` : ''}`);
  lines.push(`build ${!a.build_sha || a.build_sha === 'unknown' ? 'unknown' : a.build_sha.slice(0, 12)}${a.build_dirty ? '+dirty' : ''}  proto ${a.proto}  caps v${a.caps_version ?? 1}  hooks ${a.hook_version ?? 'not installed'}`);
  lines.push(`harnesses: ${hs.join('; ') || 'none'}`);
  for (const t of a.targets ?? []) {
    const launch = (t.enabled ?? t.harnesses).map((h) => {
      const l = t.launch?.[h];
      return l ? `${h} ${l.ready ? 'ready' : `NOT ready (${l.error ?? '?'})`}` : h;
    });
    const verify = (t.verify_status ?? t.verify.map((id) => ({ id, ready: true }))).map((v) => {
      const state = 'reason' in v && v.reason ? `${v.id} NOT ready (${v.reason})` : `${v.id} ${v.ready ? 'ready' : 'NOT ready'}`;
      // S-N4: whether it runs in the bubblewrap sandbox.
      if (!('isolated' in v) || v.isolated === undefined) return state;
      return v.isolated ? `${state}, sandboxed` : `${state}, NOT sandboxed${v.isolation_reason ? ` (${v.isolation_reason})` : ''}`;
    });
    lines.push(`target ${t.id}: ${launch.join(', ') || 'no harness enabled'}; verify ${verify.join(', ') || 'none'}`);
    // S-Q3: a target whose template fails is not advertised as ready.
    if (t.template && !t.template.ready) lines.push(`  NOT ready: ${(t.template.problems ?? []).filter((p) => p.level === 'fail').map((p) => p.reason).join('; ')}`);
    if (t.prepare?.length) lines.push(`  prepare (new worktrees): ${t.prepare.join(', ')}`);
  }
  return lines;
}

/** Read the key without echoing it (terminal) or from stdin (pipe). */
async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) {
      data += chunk;
      if (data.length > 4096) break;
    }
    return data.trim();
  }
  return readSecret('Eridani link key (eri_bot_…): ');
}

/**
 * The identity the running server's hello would carry (eridani-runtime.ts):
 * this checkout's build, the caps shape, the installed hook helper, and the
 * caps for the configured collector mode.
 */
export function localHelloIdentity(version: string, mode: CollectorMode = 'parity'): HelloIdentity & { caps: LinkCap[] } {
  return {
    ...helloIdentity({ version, build: loadBuildInfo(), capsVersion: ERIDANI_CAPS_VERSION, hookVersion: hookVersion(defaultHookPaths()).installed }),
    caps: [...linkCaps(mode)],
  };
}

/**
 * One hello → welcome against `url` with `key`. Resolves with Eridani's host id;
 * rejects with a sentence a person can act on. The hello carries the same
 * identity as the real one (build, caps version, hook version, caps), so
 * Eridani sees the same host on the probe; `identity` defaults to this
 * checkout's (localHelloIdentity).
 */
export function probeLink(url: string, key: string, hello: { server_id: string; machine: string; version: string; identity?: HelloIdentity & { caps: LinkCap[] } }, timeoutMs: number = ERIDANI_TIMING.probeMs): Promise<{ hostId: string | null; connEpoch: number; caps: string[] }> {
  const identity = hello.identity ?? localHelloIdentity(hello.version);
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, [ERIDANI_SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': `remotea-server/${hello.version}` },
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
    });
    const finish = (err: Error | null, value?: { hostId: string | null; connEpoch: number; caps: string[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* gone */
      }
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`no welcome from ${url} within ${timeoutMs / 1000} s`)), timeoutMs);
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      finish(new Error(code === 401 || code === 403 ? `Eridani refused the key (HTTP ${code})` : `Eridani answered HTTP ${code}`));
    });
    ws.on('error', (err) => finish(new Error(`cannot reach ${url}: ${err.message}`)));
    ws.on('close', (code) => finish(new Error(code === 4401 || code === 4403 ? 'Eridani refused the key' : `Eridani closed the connection (${code})`)));
    ws.on('open', () => {
      ws.send(JSON.stringify({
        v: 1, id: crypto.randomUUID(), conn_epoch: null, at: Date.now(), t: 'hello',
        server_id: hello.server_id, boot_id: `probe-${crypto.randomUUID()}`, hostname: os.hostname(), machine: hello.machine,
        ...identity, proto: ERIDANI_PROTO, version: hello.version, harnesses: {},
      }));
    });
    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      const f = parseDownFrame(raw);
      if (f?.t !== 'welcome') return;
      const w = f as unknown as { host_id: string | null; conn_epoch: number; caps?: unknown };
      try {
        ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), conn_epoch: w.conn_epoch, at: Date.now(), t: 'bye', reason: 'probe' }));
      } catch {
        /* closing anyway */
      }
      finish(null, { hostId: w.host_id, connEpoch: w.conn_epoch, caps: Array.isArray(w.caps) ? w.caps.filter((c): c is string => typeof c === 'string') : [] });
    });
  });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function readRegistry(dir: string): RegistryData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')) as RegistryData;
  } catch {
    return null;
  }
}

/**
 * What to do around a switch (docs/remotea/eridani-link.md § Collector
 * cutover, mirroring Eridani's retirement steps in
 * ~/jarvis/scripts/session_collector/README.md).
 */
export function collectorChecklist(mode: 'parity' | 'authoritative'): string {
  if (mode === 'authoritative') {
    return [
      'Collector cutover checklist (this host now reports to the store; status --json is v2):',
      '  before  [ ] Eridani\'s parity summary says "ready for cutover" (7 consecutive clean days)',
      '          [ ] this release is the one installed and running (systemctl --user status remotea)',
      '  now     [ ] stop the Python collector:  ' + LEGACY_TIMER_HINT,
      '          [ ] remove its SessionStart hook:  remotea hooks --remove-legacy-collector  (--dry-run first)',
      '          [ ] within 2 min: remotea eridani status shows the link ready, no refusals, outbox draining',
      '          [ ] a new or resumed session appears in Eridani with its resume hint',
      '          [ ] the agents\' MCP key ("cli-agents") still works: it is not part of the cutover',
      '  later   [ ] one release on, after a clean cutover: remove the collector\'s units and',
      '              ~/.config/eridani-collector, then revoke the old collector credential in Eridani',
      '              (Settings → Integrations → Connected agents). Never the link key or cli-agents.',
      'Rollback: remotea eridani collector parity, then systemctl --user enable --now eridani-collector.timer',
      '',
    ].join('\n');
  }
  return [
    'Collector back in parity mode (reports are compared, not stored; status --json is v1).',
    'If this is a rollback, the Python collector must report again:',
    '  [ ] systemctl --user enable --now eridani-collector.timer',
    '  [ ] its SessionStart hook, if you removed it and want it back: add',
    '      `python3 ~/jarvis/scripts/session_collector/session_hook.py` to SessionStart in ~/.claude/settings.json',
    '',
  ].join('\n');
}

/**
 * What `status` adds: the MCP wiring per harness, and each target's
 * readiness: the running link's hello when there is one, else computed here
 * (verify and mcp; launchers only with --probe, which runs them the way the
 * server does).
 */
async function statusExtras(dir: string, s: EridaniSummary, probe: boolean): Promise<{ wiring: ReturnType<typeof mcpWiring>; readiness: HelloTarget[]; source: string }> {
  const wiring = mcpWiring(dir, { home: os.homedir(), env: process.env });
  const targets = loadTargets(dir);
  const venv = serviceEnv(os.homedir(), process.env).env;
  const probes = new Map<string, LauncherProbe>();
  if (probe) {
    await Promise.all(launchersToProbe(targets).map(async ({ harness, bin }) => probes.set(probeKey(harness, bin), await defaultProbe(harness, bin))));
    return { wiring, readiness: localReadiness(dir, targets, probes, venv), source: 'probed now' };
  }
  const adv = s.link?.advertised?.targets;
  if (adv) {
    // The running hello for launch and verify; mcp and any target added since, from disk now.
    const local = localReadiness(dir, targets, probes, venv);
    return { wiring, readiness: local.map((t) => { const a = adv.find((x) => x.id === t.id); return a ? { ...a, mcp: t.mcp, ...(a.template ? {} : t.template ? { template: t.template } : {}) } : t; }), source: 'launch and verify from the running hello; mcp from disk now' };
  }
  return { wiring, readiness: localReadiness(dir, targets, probes, venv), source: `${s.link ? 'the running server does not report its hello targets (an older build)' : 'no running link'}: launchers not probed (--probe), verify and mcp from disk` };
}

function fmtTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString() : '-';
}

export async function eridaniCommand(dir: string, args: string[], serverRunning: () => Promise<boolean>, out = process.stdout): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'connect': {
      const prev = loadEridaniConfig(dir);
      const url = flag(rest, '--url') ?? prev?.url;
      if (!url) throw new Error('usage: remotea eridani connect --url wss://<eridani>/api/v1/external/agents/link [--machine <name>]');
      const urlError = linkUrlError(url);
      if (urlError) throw new Error(urlError);
      const machine = flag(rest, '--machine') ?? prev?.machine;
      const key = await readKey();
      if (!ERIDANI_KEY_RE.test(key)) throw new Error('that is not an Eridani link key (it starts with eri_bot_)');
      if (!rest.includes('--no-probe')) {
        const res = await probeLink(url, key, { server_id: ensureServerId(dir), machine: machine || os.hostname(), version: serverVersion(), identity: localHelloIdentity(serverVersion(), prev?.collector) });
        out.write(res.hostId ? `Eridani accepted the key (host ${res.hostId})\n` : 'Eridani accepted the key (new host; it is registered when the server connects)\n');
      }
      writeEridaniToken(dir, key);
      const cfg: EridaniConfig = { enabled: true, url, machine, collector: prev?.collector ?? 'parity' };
      saveEridaniConfig(dir, cfg);
      out.write(`link enabled: ${url} as ${machine || os.hostname()} (collector ${cfg.collector}); the server connects within 30 s\n`);
      return 0;
    }
    case 'status': {
      const s = eridaniSummary(dir, await serverRunning());
      const extra = await statusExtras(dir, s, rest.includes('--probe'));
      if (rest.includes('--json')) {
        out.write(JSON.stringify({ ...s, mcpWiring: extra.wiring, readiness: extra.readiness }, null, 2) + '\n');
        return 0;
      }
      if (!s.url) {
        out.write('not set up: run `remotea eridani setup` (or `remotea eridani connect --url wss://…`)\n');
        return 0;
      }
      out.write(`link ${s.state}  ${s.url}  as ${s.machine}  collector ${s.collector} (${s.collectorScope === 'all' ? 'all sessions' : 'remotea sessions'})  key ${s.keyPresent ? 'present' : 'MISSING'}\n`);
      const l = s.link;
      if (l) {
        out.write(`host ${l.hostId ?? '-'}  epoch ${l.connEpoch ?? '-'}  last connected ${fmtTime(l.lastConnectedAt)}  last ack ${fmtTime(l.lastAckAt)}\n`);
        // An older server's status file has no `journal`, and its `degraded` is the outbox's.
        const outboxDegraded = l.journal ? l.spool.degraded ?? null : l.degraded;
        out.write(`outbox ${l.unacked} unacked, ${l.spool.entries} entries, ${Math.round(l.spool.fill * 100)}% full${l.dirty ? `, ${l.dirty} to re-read` : ''}${outboxDegraded ? `, DEGRADED: ${outboxDegraded}` : ''}\n`);
        if (l.journal?.degraded) {
          out.write(`journal DEGRADED: ${l.journal.degraded}; commands are refused (journal_unavailable) until a write succeeds${l.journal.unrecorded ? `, ${l.journal.unrecorded} outcome(s) waiting to be recorded` : ''}\n`);
        }
        if (l.journal?.refused) out.write(`commands refused with journal_unavailable: ${l.journal.refused}\n`);
        if (l.error) out.write(`error: ${l.error}\n`);
        if (l.rejected) out.write(`refused by Eridani: ${l.rejected} (last: ${l.lastRejection})\n`);
        if (l.advertised) for (const line of fmtAdvertised(l.advertised)) out.write(`${line}\n`);
        if (l.doctor) out.write(`doctor (as Eridani sees it, ${fmtTime(l.doctor.at)}): ${l.doctor.ok} ok, ${l.doctor.warn} warn, ${l.doctor.fail} fail${l.doctor.items.length ? `: ${l.doctor.items.slice(0, 3).map((i) => i.id).join(', ')}${l.doctor.items.length > 3 ? ', …' : ''}` : ''} (details: remotea doctor)\n`);
      }
      out.write('\nMCP for coding agents:\n');
      for (const line of fmtWiring(extra.wiring)) out.write(`  ${line}\n`);
      out.write(`\nReadiness per target (${extra.source}):\n`);
      for (const line of fmtReadiness(extra.readiness)) out.write(`  ${line}\n`);
      return 0;
    }
    case 'setup': {
      if (rest.includes('--help') || rest.includes('-h')) {
        out.write(`${SETUP_USAGE}\n`);
        return 0;
      }
      const o = parseSetupArgs(rest);
      const report = await runSetup(o, {
        dir,
        home: os.homedir(),
        env: process.env,
        out,
        prompt: process.stdin.isTTY && process.stderr.isTTY ? ttyPrompter() : noPrompter,
        serverRunning,
        probeLink: (url, key, hello) => probeLink(url, key, hello),
        probe: defaultProbe,
        hookPaths: defaultHookPaths(),
        stdinLines: stdinLinesOnce(),
        version: serverVersion(),
      });
      return report.skipped.some((x) => /failed/.test(x)) ? 1 : 0;
    }
    case 'disconnect': {
      const prev = loadEridaniConfig(dir);
      if (prev) saveEridaniConfig(dir, { ...prev, enabled: false });
      if (rest.includes('--forget')) forgetEridaniToken(dir);
      out.write(`link disabled${rest.includes('--forget') ? ' and key deleted' : ''}; the server disconnects within 30 s\n`);
      return 0;
    }
    case 'collect': {
      const daysArg = flag(rest, '--days');
      const days = daysArg !== undefined ? Number(daysArg) : undefined;
      if (days !== undefined && !(days > 0)) throw new Error('--days takes a positive number');
      if (rest.includes('--dry-run')) {
        const cfg = loadEridaniConfig(dir);
        const reg = readRegistry(dir);
        const collector = new Collector({
          machine: cfg?.machine,
          home: process.env.REMOTEA_COLLECTOR_HOME || undefined,
          windowsUsers: process.env.REMOTEA_COLLECTOR_HOME ? null : WINDOWS_USERS,
          state: new CollectorState(null),
          status: () => (reg ? statusFromRegistry(reg, os.hostname()) : null),
          warn: (m) => process.stderr.write(`${m}\n`),
        });
        const res = await collector.scan({ dryRun: true, days });
        out.write(formatRows(res.rows, days ?? 7));
        return 0;
      }
      if (!(await serverRunning())) throw new Error('the server is not running');
      if (!loadEridaniConfig(dir)?.enabled) throw new Error('the link is not enabled (remotea eridani connect)');
      fs.writeFileSync(path.join(dir, ERIDANI_COLLECT_REQUEST), String(Date.now()), { mode: 0o600 });
      out.write('scan requested; the server runs it within 30 s\n');
      return 0;
    }
    case 'collector': {
      const prev = loadEridaniConfig(dir);
      const want = rest[0];
      if (want === 'scope') {
        const scope = rest[1];
        if (!prev) throw new Error('the link is not set up: run `remotea eridani connect --url wss://…` first');
        const now = prev.collector_scope ?? 'remotea';
        if (scope === undefined) {
          out.write(`collector scope ${now}\n`);
          return 0;
        }
        if (scope !== 'remotea' && scope !== 'all') throw new Error('usage: remotea eridani collector scope [remotea|all]');
        if (now === scope) out.write(`collector scope already ${scope}\n`);
        else {
          saveEridaniConfig(dir, { ...prev, collector_scope: scope });
          out.write(`collector scope ${now} → ${scope}; the server follows within 30 s\n`);
        }
        out.write(scope === 'remotea'
          ? 'Only sessions that ran in a remotea terminal are reported. Sessions reported before stay in Eridani.\n'
          : 'Every Claude Code, Claude Desktop and Codex session on this machine is reported, as the Python collector did.\n');
        return 0;
      }
      if (want === undefined) {
        out.write(`collector ${prev?.collector ?? 'parity'}${prev ? '' : ' (no link set up)'}\n`);
        return 0;
      }
      if (want !== 'parity' && want !== 'authoritative') throw new Error('usage: remotea eridani collector [parity|authoritative]');
      if (!prev) throw new Error('the link is not set up: run `remotea eridani connect --url wss://…` first');
      if (prev.collector === want) out.write(`collector already ${want}\n`);
      else {
        saveEridaniConfig(dir, { ...prev, collector: want });
        out.write(`collector ${prev.collector} → ${want}; the server follows within 30 s\n`);
      }
      if (want === 'authoritative' && !prev.enabled) out.write('note: the link is disabled, so nothing reports until `remotea eridani connect`\n');
      out.write(collectorChecklist(want));
      return 0;
    }
    case 'targets':
      return targetsCommand(dir, rest, out);
    case 'worktrees':
      return worktreesCommand(dir, rest, out);
    default:
      process.stderr.write(`usage: remotea eridani setup [--help | <flags>] | connect [--url <wss://…>] [--machine <name>] | status [--json] [--probe] | disconnect [--forget] | collect [--dry-run] [--days N]
       remotea eridani collector [parity|authoritative] | collector scope [remotea|all]
       remotea eridani targets setup <repo-path> [--id <id>] [--worktree-root <path>] [--harness claude|codex] [--model <name>] [--no-harness] [--yes] [--json]   (guided; --help for all flags)
       remotea eridani targets list [--json] | add --id <id> --repo <path> --worktree-root <path> [--base <branch>] [--claude] [--codex] [--verify <id>=<command>]… [--verify-timeout <s>] [--prepare <id>=<command>]… [--prepare-timeout <s>] [--max-runs <n>] | add --json '<target>' | remove <id>
       remotea eridani worktrees [--json]\n`);
      return sub === undefined ? 0 : 2;
  }
}

/** Every value of a repeated flag. */
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
    out.push(v);
  }
  return out;
}

/**
 * `remotea eridani targets`: where Eridani may start work (eridani-targets.ts).
 * `setup <repo-path>` is the guided way (eridani-target-setup.ts); `add` takes
 * everything by hand. A verify command is split on spaces into a fixed argv and runs with no
 * shell; for quoting or anything unusual, `add --json` takes the whole target.
 */
function targetsCommand(dir: string, args: string[], out: NodeJS.WritableStream): number | Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list': {
      const list = loadTargets(dir, (m) => process.stderr.write(`${m}\n`));
      if (rest.includes('--json')) {
        out.write(JSON.stringify(list, null, 2) + '\n');
        return 0;
      }
      if (!list.length) {
        out.write('no execution targets: add one with `remotea eridani targets add`\n');
        return 0;
      }
      for (const t of list) {
        const harnesses = (['claude', 'codex'] as const).filter((h) => t.launch[h]).join(', ') || 'none';
        out.write(`${t.id}  ${t.repo}  worktrees in ${t.worktreeRoot}  base ${t.base}  harnesses ${harnesses}\n`);
        for (const p of t.prepare ?? []) out.write(`  prepare ${p.id}: ${p.argv.join(' ')}${p.cwd ? ` (in ${p.cwd})` : ''}, ${p.timeout} s\n`);
        for (const v of t.verify) out.write(`  verify ${v.id}: ${v.argv.join(' ')}${v.cwd ? ` (in ${v.cwd})` : ''}, ${v.timeout} s\n`);
        if (t.limits) out.write(`  limits: ${Object.entries(t.limits).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
        const mcp = resolveMcp(dir, t);
        out.write(`  eridani mcp: ${mcp.configured ? `configured (${mcp.url})` : `not configured: ${mcp.reason}`}\n`);
      }
      return 0;
    }
    case 'add': {
      let target: ExecutionTarget;
      const json = flag(rest, '--json');
      if (json) {
        target = JSON.parse(json) as ExecutionTarget;
      } else {
        const id = flag(rest, '--id');
        const repo = flag(rest, '--repo');
        const root = flag(rest, '--worktree-root');
        if (!id || !repo || !root) throw new Error('targets add needs --id, --repo and --worktree-root (or --json)');
        const timeout = Number(flag(rest, '--verify-timeout') ?? DEFAULT_VERIFY_TIMEOUT);
        const verify: VerifySpec[] = flags(rest, '--verify').map((v) => {
          const eq = v.indexOf('=');
          if (eq < 1) throw new Error(`--verify ${v}: <id>=<command>`);
          return { id: v.slice(0, eq), argv: v.slice(eq + 1).trim().split(/\s+/).filter(Boolean), timeout };
        });
        const prepareTimeout = Number(flag(rest, '--prepare-timeout') ?? 900);
        const prepare: PrepareSpec[] = flags(rest, '--prepare').map((v) => {
          const eq = v.indexOf('=');
          if (eq < 1) throw new Error(`--prepare ${v}: <id>=<command>`);
          return { id: v.slice(0, eq), argv: v.slice(eq + 1).trim().split(/\s+/).filter(Boolean), timeout: prepareTimeout };
        });
        const maxRuns = flag(rest, '--max-runs');
        const launch: ExecutionTarget['launch'] = {};
        if (rest.includes('--claude')) launch.claude = {};
        if (rest.includes('--codex')) launch.codex = {};
        if (!launch.claude && !launch.codex) launch.claude = {};
        target = {
          id, repo: path.resolve(repo), worktreeRoot: path.resolve(root), base: flag(rest, '--base') ?? 'main', launch, verify,
          ...(prepare.length ? { prepare } : {}),
          ...(maxRuns ? { limits: { maxRuns: Number(maxRuns) } } : {}),
        };
      }
      if (!fs.existsSync(path.join(target.repo ?? '', '.git'))) throw new Error(`${target.repo} is not a git repository`);
      saveTarget(dir, target);
      out.write(`target ${target.id} saved; it applies to the next spawn (no restart)\n`);
      // S-Q3: what hello will say about it, checked against the service's PATH.
      const saved = loadTargets(dir).find((t) => t.id === target.id);
      const tpl = saved ? templateStatus(saved, { env: serviceEnv(os.homedir(), process.env).env }) : null;
      if (tpl && !tpl.ready) out.write(`warning: target ${target.id} is not ready, so Eridani will not be offered it until this is fixed:\n`);
      for (const p of tpl?.problems ?? []) out.write(`  ${p.level === 'fail' ? 'NOT READY' : 'warn'} ${p.check}: ${p.reason}\n`);
      return 0;
    }
    case 'setup': {
      if (rest.includes('--help') || rest.includes('-h')) {
        out.write(`${TARGET_SETUP_USAGE}\n`);
        return 0;
      }
      const o = parseTargetSetupArgs(rest);
      // Asked only on a terminal; without one nothing is written unless --yes.
      return runTargetSetup(o, { dir, out, prompt: process.stdin.isTTY && process.stderr.isTTY ? ttyPrompter() : noPrompter }).then((r) => r.code);
    }
    case 'remove': {
      const id = rest[0];
      if (!id) throw new Error('targets remove <id>');
      out.write(removeTarget(dir, id) ? `target ${id} removed (its worktrees stay on disk)\n` : `no target ${id}\n`);
      return 0;
    }
    default:
      throw new Error(`unknown targets command ${sub}`);
  }
}

/**
 * `remotea eridani worktrees`: every managed worktree, with what would be
 * lost by removing it. Nothing is ever removed: a candidate gets the commands
 * that would, recovery ref first, for a person to run.
 */
async function worktreesCommand(dir: string, args: string[], out: NodeJS.WritableStream): Promise<number> {
  const targets = loadTargets(dir, (m) => process.stderr.write(`${m}\n`));
  const reg = readRegistry(dir);
  const writers = writersByPath(Object.values(reg?.sessions ?? {}));
  const rows = await new WorktreeManager({ dir }).nominate(targets, (p) => writers.has(p), (p) => writers.get(p) ?? null);
  if (args.includes('--json')) {
    out.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  if (!rows.length) {
    out.write('no managed worktrees\n');
    return 0;
  }
  for (const r of rows) {
    out.write(`${r.candidate ? 'candidate ' : 'keep      '} ${r.target}  ${r.branch ?? '(detached)'}  ${r.path}\n`);
    if (r.writer) out.write(`           writer ${r.writer.surf} (run ${r.writer.run_id})\n`);
    if (r.reasons.length) out.write(`           ${r.reasons.join('; ')}\n`);
    if (r.candidate) {
      const t = targets.find((x) => x.id === r.target);
      if (t) for (const c of cleanupCommands(t.repo, r)) out.write(`           $ ${c}\n`);
    }
  }
  return 0;
}

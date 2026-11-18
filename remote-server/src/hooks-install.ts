/**
 * `remotea hooks install|remove|status`: register wmux's hook helper with the
 * agents that run in this WSL, so their status reaches the apps through the
 * hook bridge (see hook-bridge.ts).
 *
 * - Claude Code: ~/.claude/settings.json, the exact entries the Windows app
 *   writes there (src/shared/claude-hooks.ts).
 * - Codex CLI: ~/.codex/hooks.json, the same helper with `--provider codex`.
 * - OpenCode, pi and omp: wmux's plugin for each (~/.config/opencode/plugin,
 *   ~/.pi/agent/extensions, ~/.omp/agent/extensions). They report through the
 *   wmux CLI (`node $REMOTEA_CLI …`), which sessions are told about in hookEnv,
 *   and do nothing outside a remotea pane.
 * - Grok: ~/.grok/hooks/remotea.json, a file of wmux's own (Claude's hooks plus
 *   Grok's two extra turn endings).
 * - Qwen Code: ~/.qwen/settings.json, wmux's Qwen entries (`--provider qwen`).
 * - Antigravity (agy): wmux's plugin directory, ~/.gemini/config/plugins/remotea.
 *
 * The same files the Windows app writes for its own agents, built by the same
 * code (src/main/*-context.ts), pointed at this machine's copy of the helper.
 *
 * Only entries whose command runs `remotea-hook` are ours; every other hook (the
 * user's, herdr's, anything else) is left exactly as it was. The helper itself
 * is copied to ~/.local/share/remotea/cli, so the hooks keep working if the
 * repository moves, and it exits at once in a session that is not remotea's.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HOOK_TIMEOUTS_S, applyWmuxHooks, removeWmuxHooks } from '../../src/shared/claude-hooks';
import type { AdapterHooks } from './harness-adapters';
import { applyQwenHooks, removeQwenHooksFrom } from '../../src/main/qwen-context';
import { buildGrokHooks } from '../../src/main/grok-context';
import { ensureAgyPlugin, getAgyPluginDir, removeAgyPlugin } from '../../src/main/agy-context';
import { isWmuxPluginFile } from '../../src/main/agent-plugin-file';
import type { HookAgentStatus } from '../../src/shared/remote-host-protocol';
import { countLegacyHookEntries, isLegacyRemoteaGrokHooksFile, stripLegacyHookEntries } from '../../src/shared/legacy-cleanup';
import { LEGACY_PLUGIN_FILES } from '../../src/shared/legacy-names';
import type { OwnershipContext } from '../../src/shared/artifact-ownership';

// The helper's file name, not a bare prefix (see claude-hooks.ts).
const MARKER = 'remotea-hook.js';

/** Codex's hook events, and what remotea-hook reports each as (PermissionRequest → a permission Notification). */
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'] as const;

export interface HookPaths {
  home: string;
  /** Where the helper scripts are copied. */
  cliDir: string;
  /** The checked-in helper scripts to copy (resources/cli). */
  sourceDir: string;
}

export function defaultHookPaths(): HookPaths {
  // REMOTEA_HOOKS_HOME: whose agent settings to manage. The desktop test
  // harness points its test server at a scratch home so a test install never
  // touches the real ~/.claude or ~/.codex.
  const home = process.env.REMOTEA_HOOKS_HOME || os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return {
    home,
    cliDir: path.join(dataHome, 'remotea', 'cli'),
    // dist/remote-server/src/hooks-install.js → <repo>/resources/cli
    sourceDir: path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'cli'),
  };
}

type Json = Record<string, any>;

function isOurs(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return Array.isArray(hooks) && hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(MARKER));
}

/**
 * Codex's timeout per event, in seconds. PermissionRequest is held for
 * Eridani (questions-claude.ts, `remotea.approval`): remotea gives the prompt
 * back to the terminal at 570 s, before Codex kills the hook at 600 s. Codex
 * 0.166 records a trust hash per hook entry (config.toml `[hooks.state]`), so
 * changing an entry makes Codex ask to review hooks once at its next start.
 */
export const CODEX_TIMEOUTS_S: Record<(typeof CODEX_EVENTS)[number], number> = {
  SessionStart: 10,
  UserPromptSubmit: 10,
  PreToolUse: 10,
  PostToolUse: 10,
  PermissionRequest: HOOK_TIMEOUTS_S.question,
  Stop: 10,
  SessionEnd: 10,
};

export function applyCodexHooks(config: Json, hookScript: string): Json {
  const next: Json = { ...(config || {}) };
  next.hooks = { ...(next.hooks || {}) };
  for (const event of CODEX_EVENTS) {
    const kept = (Array.isArray(next.hooks[event]) ? next.hooks[event] : []).filter((e: unknown) => !isOurs(e));
    next.hooks[event] = [...kept, { hooks: [{ type: 'command', command: `node "${hookScript}" --event ${event} --provider codex`, timeout: CODEX_TIMEOUTS_S[event] }] }];
  }
  return next;
}

/** Our helper's handler for `event` in a hooks map (optionally only a matcher's group), or null. */
function ourHandler(hooks: unknown, event: string, matcher?: string): { command: string; timeout?: unknown } | null {
  const groups = hooks && typeof hooks === 'object' ? (hooks as Json)[event] : null;
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (matcher !== undefined && g?.matcher !== matcher) continue;
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (typeof h?.command === 'string' && h.command.includes(MARKER) && h.command.includes(`--event ${matcher ?? event}`)) return h;
    }
  }
  return null;
}

const longEnough = (h: { timeout?: unknown } | null): boolean => !!h && typeof h.timeout === 'number' && h.timeout >= HOOK_TIMEOUTS_S.question;

/**
 * Whether each question adapter's hook is wired the way its hold needs
 * (harness-adapters.ts): our entry is there, synchronous, with the long
 * timeout. Read-only; an unreadable file is "not wired".
 */
export function adapterHooks(p: Pick<HookPaths, 'home'> = defaultHookPaths()): AdapterHooks {
  const read = (file: string): Json | null => {
    try {
      return readJson(file);
    } catch {
      return null;
    }
  };
  const claude = read(path.join(p.home, '.claude', 'settings.json'));
  const ask = ourHandler(claude?.hooks, 'PreToolUse', 'AskUserQuestion') as { async?: unknown; timeout?: unknown } | null;
  const codex = read(path.join(p.home, '.codex', 'hooks.json'));
  return {
    claudeAsk: longEnough(ask) && ask?.async !== true,
    codexApproval: longEnough(ourHandler(codex?.hooks, 'PermissionRequest')),
  };
}

export function removeCodexHooks(config: Json): Json {
  const next: Json = { ...(config || {}) };
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  const hooks: Json = { ...next.hooks };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => !isOurs(e));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

function countOurs(config: Json | null): number {
  if (!config?.hooks || typeof config.hooks !== 'object') return 0;
  let n = 0;
  for (const entries of Object.values(config.hooks)) if (Array.isArray(entries)) n += entries.filter(isOurs).length;
  return n;
}

function readJson(file: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }
}

/**
 * Atomic write; the first time remotea changes a file, the original is kept
 * beside it. The file keeps its mode (settings.json is 0600 and can carry API
 * keys in `env`; the process umask must not widen it), a new one is 0600, and
 * the backup is always 0600 (stage F, L12).
 */
function writeJson(file: string, value: Json): void {
  const backup = `${file}.remotea-backup`;
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  if (fs.existsSync(backup)) fs.chmodSync(backup, 0o600);
  const tmp = `${file}.remotea-tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  // writeFileSync's mode is filtered by the umask; set it exactly.
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** The hook helper and the wmux CLI with the modules it loads (resources/cli), copied together. */
function copyHelper(p: HookPaths): string {
  fs.mkdirSync(p.cliDir, { recursive: true });
  for (const f of ['remotea-hook.js', 'transport-deadline.js', 'remotea.js']) {
    if (!fs.existsSync(path.join(p.sourceDir, f))) throw new Error(`missing ${path.join(p.sourceDir, f)} (is the repository intact?)`);
  }
  for (const f of fs.readdirSync(p.sourceDir)) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(p.sourceDir, f), path.join(p.cliDir, f));
  }
  return path.join(p.cliDir, 'remotea-hook.js');
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** A file wmux installed: the OpenCode plugin by its export, the others by their version marker. */
function isOurPluginFile(file: string): boolean {
  const text = readText(file);
  return text !== null && (text.includes('WmuxPlugin') || isWmuxPluginFile(text));
}

/** Grok's hooks file is wmux's own; ours only while every command in it is the helper. */
function isOurGrokFile(file: string): boolean {
  let parsed: Json | null;
  try {
    parsed = readJson(file);
  } catch {
    return false;
  }
  const entries = Object.values((parsed?.hooks ?? {}) as Json).flat() as Array<{ hooks?: Array<{ command?: unknown }> }>;
  return entries.length > 0 && entries.every((e) => Array.isArray(e?.hooks) && e.hooks.every((h) => typeof h?.command === 'string' && h.command.includes(MARKER)));
}

export type HookAgent = 'claude' | 'codex' | 'opencode' | 'pi' | 'omp' | 'grok' | 'qwen' | 'agy';

export interface HookTarget {
  agent: HookAgent;
  file: string;
  /** Present: the agent's config directory exists, so it is installed here. */
  present: boolean;
  entries: number;
}

type Target =
  /** Our entries merged into the agent's own settings file. */
  | { agent: HookAgent; dir: string; file: string; kind: 'settings'; apply: (c: Json, script: string) => Json; remove: (c: Json) => Json }
  /** A file of wmux's own, copied from resources/. */
  | { agent: HookAgent; dir: string; file: string; kind: 'plugin'; source: string }
  | { agent: HookAgent; dir: string; file: string; kind: 'grok' | 'agy' };

function targets(p: HookPaths): Target[] {
  const res = (...parts: string[]) => path.resolve(p.sourceDir, '..', ...parts);
  const h = (...parts: string[]) => path.join(p.home, ...parts);
  return [
    { agent: 'claude', dir: h('.claude'), file: h('.claude', 'settings.json'), kind: 'settings', apply: (c, script) => applyWmuxHooks(c, script, { questions: true }), remove: removeWmuxHooks },
    { agent: 'codex', dir: h('.codex'), file: h('.codex', 'hooks.json'), kind: 'settings', apply: applyCodexHooks, remove: removeCodexHooks },
    { agent: 'opencode', dir: h('.config', 'opencode'), file: h('.config', 'opencode', 'plugin', 'remotea.js'), kind: 'plugin', source: res('opencode-plugin', 'remotea.js') },
    { agent: 'pi', dir: h('.pi'), file: h('.pi', 'agent', 'extensions', 'remotea.js'), kind: 'plugin', source: res('pi-extension', 'remotea.js') },
    { agent: 'omp', dir: h('.omp'), file: h('.omp', 'agent', 'extensions', 'remotea.js'), kind: 'plugin', source: res('omp-extension', 'remotea.js') },
    { agent: 'grok', dir: h('.grok'), file: h('.grok', 'hooks', 'remotea.json'), kind: 'grok' },
    { agent: 'qwen', dir: h('.qwen'), file: h('.qwen', 'settings.json'), kind: 'settings', apply: applyQwenHooks, remove: removeQwenHooksFrom },
    { agent: 'agy', dir: h('.gemini', 'antigravity-cli'), file: path.join(getAgyPluginDir(p.home), 'remotea-agy-hook.cjs'), kind: 'agy' },
  ];
}

function entriesOf(t: Target): number {
  switch (t.kind) {
    case 'settings':
      try {
        return countOurs(readJson(t.file));
      } catch {
        return 0; // not plain JSON (Qwen allows comments): not ours to read or write
      }
    case 'grok':
      return isOurGrokFile(t.file) ? 1 : 0;
    default:
      return isOurPluginFile(t.file) ? 1 : 0;
  }
}

export function hooksStatus(p: HookPaths = defaultHookPaths()): HookTarget[] {
  return targets(p).map((t) => ({ agent: t.agent, file: t.file, present: fs.existsSync(t.dir), entries: entriesOf(t) }));
}

/**
 * The folders that prove an old-named hook entry is this host's: the helper
 * copy and the checkout it came from. A wmux install's entries never match.
 */
export function hostOwnershipContext(p: HookPaths): OwnershipContext {
  return { knownDirs: [p.cliDir, p.sourceDir], readFile: readText };
}

/**
 * This host's old-named hook entries, by agent: entries whose helper path is
 * this host's (Claude, Codex, Qwen), and Grok's old hooks file when every
 * handler in it is. The move rewrites them when any are found.
 */
export function legacyHookEntries(p: HookPaths = defaultHookPaths()): Array<{ agent: HookAgent; entries: number }> {
  const ctx = hostOwnershipContext(p);
  const out: Array<{ agent: HookAgent; entries: number }> = [];
  for (const t of targets(p)) {
    let entries = 0;
    if (t.kind === 'settings') {
      try {
        entries = countLegacyHookEntries(readJson(t.file), ctx);
      } catch {
        entries = 0; // not plain JSON: installHooks leaves it too
      }
    } else if (t.kind === 'grok') {
      const old = readText(path.join(path.dirname(t.file), LEGACY_PLUGIN_FILES.grokHooks[0]));
      entries = old !== null && isLegacyRemoteaGrokHooksFile(old, ctx) ? 1 : 0;
    }
    if (entries > 0) out.push({ agent: t.agent, entries });
  }
  return out;
}

/** Install for every agent whose config directory exists. Returns what was written. */
export function installHooks(p: HookPaths = defaultHookPaths()): HookTarget[] {
  const script = copyHelper(p);
  // Old-named entries go only when their path is this host's (KTD8).
  const ctx = hostOwnershipContext(p);
  for (const t of targets(p)) {
    if (!fs.existsSync(t.dir)) continue;
    switch (t.kind) {
      case 'settings': {
        let current: Json | null;
        try {
          current = readJson(t.file);
        } catch (err) {
          // Claude's and Codex's files are plain JSON, so a bad one is worth
          // stopping for; Qwen's may carry comments, and is left as it is.
          if (t.agent === 'qwen') continue;
          throw err;
        }
        writeJson(t.file, t.apply(stripLegacyHookEntries(current ?? {}, ctx), script));
        break;
      }
      case 'plugin':
        // A file someone else put at that name is theirs: left alone.
        if (fs.existsSync(t.file) && !isOurPluginFile(t.file)) continue;
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
        fs.copyFileSync(t.source, t.file);
        break;
      case 'grok': {
        const oldFile = path.join(path.dirname(t.file), LEGACY_PLUGIN_FILES.grokHooks[0]);
        const old = readText(oldFile);
        if (old !== null && isLegacyRemoteaGrokHooksFile(old, ctx)) fs.rmSync(oldFile);
        if (fs.existsSync(t.file) && !isOurGrokFile(t.file)) continue;
        writeJson(t.file, buildGrokHooks(script));
        break;
      }
      case 'agy':
        ensureAgyPlugin(p.home, path.resolve(p.sourceDir, '..', 'agy-plugin', 'remotea-agy-hook.cjs'));
        break;
    }
  }
  return hooksStatus(p);
}

/** The protocol's view: which agents are here, and whether they report to remotea. */
export function toAgentStatus(rows: HookTarget[]): HookAgentStatus[] {
  return rows.map((r) => ({ agent: r.agent, present: r.present, installed: r.present && r.entries > 0 }));
}

export function removeHooks(p: HookPaths = defaultHookPaths()): HookTarget[] {
  for (const t of targets(p)) {
    switch (t.kind) {
      case 'settings': {
        if (!entriesOf(t)) continue;
        writeJson(t.file, t.remove(readJson(t.file)!));
        break;
      }
      case 'plugin':
        if (isOurPluginFile(t.file)) fs.rmSync(t.file);
        break;
      case 'grok':
        if (isOurGrokFile(t.file)) fs.rmSync(t.file);
        break;
      case 'agy':
        removeAgyPlugin(p.home);
        break;
    }
  }
  return hooksStatus(p);
}

// ── Doctor: are the hooks of the harnesses Eridani works with current? ─────

/** What `remotea doctor` checks per harness (read-only; never a key or a command line). */
export interface AgentHookCheck {
  agent: 'claude' | 'codex' | 'opencode';
  file: string;
  /** The agent's config folder exists (it is installed here). */
  present: boolean;
  /** remotea's entries found (the plugin counts as one). */
  entries: number;
  /** What `remotea hooks install` writes now. */
  expected: number;
  /** Every entry of ours runs the installed helper (cliDir); null when there is none. */
  helperPath: boolean | null;
  /** The file could not be parsed. */
  unreadable?: boolean;
  /** OpenCode: the plugin's content hash against the one this checkout ships. */
  version?: { installed: string | null; bundled: string | null };
  /**
   * Codex 0.166+: Codex records a trust hash per hook entry in config.toml
   * (`[hooks.state."<hooks.json>:<event>:<group>:<hook>"]`) once a person
   * approved it. `trusted` entries of ours have a record, `disabled` ones are
   * switched off there. null: config.toml has no hooks.state (an older Codex,
   * or none approved yet), so trust cannot be told.
   */
  trust?: { trusted: number; disabled: number; total: number } | null;
}

const snake = (event: string) => event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

function hashOf(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/** Our handlers in a hooks map, with their positions: [event, group index, hook index, command]. */
function ourHandlers(config: Json | null): Array<[string, number, number, string]> {
  const out: Array<[string, number, number, string]> = [];
  const hooks = config?.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks as Json)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g: any, i: number) => {
      (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h: any, j: number) => {
        if (typeof h?.command === 'string' && h.command.includes(MARKER)) out.push([event, i, j, h.command]);
      });
    });
  }
  return out;
}

/** Codex's trust records for our handlers in `hooksFile`, from config.toml's `[hooks.state."…"]` tables. */
export function codexTrust(configToml: string | null, hooksFile: string, handlers: Array<[string, number, number, string]>): AgentHookCheck['trust'] {
  if (configToml === null || !/^\s*\[hooks\.state[.\]]/m.test(configToml)) return null;
  const sections = new Map<string, string>();
  let current: string | null = null;
  for (const line of configToml.split('\n')) {
    const m = /^\s*\[hooks\.state\."([^"]+)"\]\s*$/.exec(line);
    if (m) {
      current = m[1];
      sections.set(current, '');
    } else if (/^\s*\[/.test(line)) current = null;
    else if (current) sections.set(current, sections.get(current)! + line + '\n');
  }
  let trusted = 0;
  let disabled = 0;
  for (const [event, i, j] of handlers) {
    const body = sections.get(`${hooksFile}:${snake(event)}:${i}:${j}`);
    if (body === undefined) continue;
    if (/^\s*enabled\s*=\s*false\b/m.test(body)) disabled++;
    if (/^\s*trusted_hash\s*=/m.test(body)) trusted++;
  }
  return { trusted, disabled, total: handlers.length };
}

/** Claude Code's, Codex's and OpenCode's remotea hooks against what an install writes now. */
export function agentHookChecks(p: HookPaths = defaultHookPaths()): AgentHookCheck[] {
  const script = path.join(p.cliDir, 'remotea-hook.js');
  const all = targets(p);
  const out: AgentHookCheck[] = [];
  for (const agent of ['claude', 'codex'] as const) {
    const t = all.find((x) => x.agent === agent) as Extract<Target, { kind: 'settings' }>;
    let config: Json | null = null;
    let unreadable = false;
    try {
      config = readJson(t.file);
    } catch {
      unreadable = true;
    }
    const handlers = ourHandlers(config);
    const row: AgentHookCheck = {
      agent,
      file: t.file,
      present: fs.existsSync(t.dir),
      entries: countOurs(config),
      expected: countOurs(t.apply({}, script)),
      helperPath: handlers.length ? handlers.every(([, , , cmd]) => cmd.includes(script)) : null,
      ...(unreadable ? { unreadable } : {}),
    };
    if (agent === 'codex') row.trust = codexTrust(readText(path.join(p.home, '.codex', 'config.toml')), t.file, handlers);
    out.push(row);
  }
  const oc = all.find((x) => x.agent === 'opencode') as Extract<Target, { kind: 'plugin' }>;
  const ours = isOurPluginFile(oc.file);
  out.push({
    agent: 'opencode',
    file: oc.file,
    present: fs.existsSync(oc.dir),
    entries: ours ? 1 : 0,
    expected: 1,
    helperPath: null,
    version: { installed: ours ? hashOf(oc.file) : null, bundled: hashOf(oc.source) },
  });
  return out;
}

// ── The Python session collector's hook (stage E cutover) ──────────────────

/** Where the Python collector's SessionStart hook lives, relative to the home. */
export const LEGACY_COLLECTOR_HOOK = path.join('jarvis', 'scripts', 'session_collector', 'session_hook.py');
/** Its timer: the one unit the cutover disables. */
export const LEGACY_COLLECTOR_TIMER = 'eridani-collector.timer';

/** Split a hook command into words; null when it is anything but plain words (a pipe, `;`, `$(…)`, a redirect). */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += command.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\' && j + 1 < command.length) j++;
        else if (command[j] === '`' || (command[j] === '$' && command[j + 1] === '(')) return null;
      }
      if (j >= command.length) return null;
      cur += command.slice(i + 1, j).replace(/\\(["\\$`])/g, '$1');
      i = j;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else if (/[;&|<>()`\\]/.test(c)) {
      return null;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/**
 * Is `command` exactly the Python collector's SessionStart hook? Ownership is
 * the script's full path, not its file name: `session_hook.py` anywhere else is
 * somebody else's. Accepted shapes are the ones a person or installer writes:
 * `<path>`, `python3 <path>` (any python/pythonX.Y, by name or absolute path),
 * `/usr/bin/env python3 <path>`, with `~/`, `$HOME/` or `${HOME}/` spelled out
 * or not. Arguments after the path, or anything compound, are not ours.
 */
export function isLegacyCollectorCommand(command: unknown, home: string): boolean {
  if (typeof command !== 'string') return false;
  const words = shellWords(command.trim());
  if (!words?.length) return false;
  const expand = (w: string) => w.replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, home);
  const target = path.join(home, LEGACY_COLLECTOR_HOOK);
  const isPython = (w: string) => /^python(\d+(\.\d+)?)?$/.test(path.posix.basename(w)) && (!w.includes('/') || path.posix.isAbsolute(w));
  let rest = words.map(expand);
  if (rest[0] === '/usr/bin/env' || rest[0] === 'env') rest = rest.slice(1);
  if (rest.length === 2 && isPython(rest[0])) rest = rest.slice(1);
  return rest.length === 1 && path.posix.normalize(rest[0]) === target;
}

export interface LegacyRemoval {
  file: string;
  /** The commands taken out (or that would be, with dryRun). */
  removed: string[];
  /** The timer's unit file when it exists here, else null. */
  timerUnit: string | null;
  dryRun: boolean;
}

/**
 * Strip the Python collector's SessionStart hook from ~/.claude/settings.json.
 * Handler by handler: another handler in the same group stays, a group left
 * empty goes, every other event and key is untouched. Never run on its own:
 * `remotea hooks --remove-legacy-collector` is the cutover's step.
 */
export function removeLegacyCollectorHooks(p: HookPaths = defaultHookPaths(), opts: { dryRun?: boolean } = {}): LegacyRemoval {
  const file = path.join(p.home, '.claude', 'settings.json');
  // XDG_CONFIG_HOME only for the real home (collector install.sh's rule); a scratch home has its own.
  const configHome = (p.home === os.homedir() && process.env.XDG_CONFIG_HOME) || path.join(p.home, '.config');
  const unit = path.join(configHome, 'systemd', 'user', LEGACY_COLLECTOR_TIMER);
  const result: LegacyRemoval = { file, removed: [], timerUnit: fs.existsSync(unit) ? unit : null, dryRun: !!opts.dryRun };
  const config = readJson(file);
  const groups = config?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return result;
  const kept: unknown[] = [];
  for (const group of groups) {
    const handlers = (group as { hooks?: unknown })?.hooks;
    if (!Array.isArray(handlers)) {
      kept.push(group);
      continue;
    }
    const rest = handlers.filter((h: any) => {
      if (!isLegacyCollectorCommand(h?.command, p.home)) return true;
      result.removed.push(h.command);
      return false;
    });
    if (rest.length === handlers.length) kept.push(group);
    else if (rest.length) kept.push({ ...group, hooks: rest });
  }
  if (!result.removed.length || opts.dryRun) return result;
  const hooks: Json = { ...config!.hooks };
  if (kept.length) hooks.SessionStart = kept;
  else delete hooks.SessionStart;
  const next: Json = { ...config! };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  writeJson(file, next);
  return result;
}

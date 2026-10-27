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
 *   wmux CLI (`node $WMUX_CLI …`), which sessions are told about in hookEnv,
 *   and do nothing outside a remotea pane.
 * - Grok: ~/.grok/hooks/wmux.json, a file of wmux's own (Claude's hooks plus
 *   Grok's two extra turn endings).
 * - Qwen Code: ~/.qwen/settings.json, wmux's Qwen entries (`--provider qwen`).
 * - Antigravity (agy): wmux's plugin directory, ~/.gemini/config/plugins/wmux.
 *
 * The same files the Windows app writes for its own agents, built by the same
 * code (src/main/*-context.ts), pointed at this machine's copy of the helper.
 *
 * Only entries whose command runs `wmux-hook` are ours; every other hook (the
 * user's, herdr's, anything else) is left exactly as it was. The helper itself
 * is copied to ~/.local/share/remotea/cli, so the hooks keep working if the
 * repository moves, and it exits at once in a session that is not remotea's.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyWmuxHooks, removeWmuxHooks } from '../../src/shared/claude-hooks';
import { applyQwenHooks, removeQwenHooksFrom } from '../../src/main/qwen-context';
import { buildGrokHooks } from '../../src/main/grok-context';
import { ensureAgyPlugin, getAgyPluginDir, removeAgyPlugin } from '../../src/main/agy-context';
import { isWmuxPluginFile } from '../../src/main/agent-plugin-file';
import type { HookAgentStatus } from '../../src/shared/remote-host-protocol';

const MARKER = 'wmux-hook';

/** Codex's hook events, and what wmux-hook reports each as (PermissionRequest → a permission Notification). */
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

export function applyCodexHooks(config: Json, hookScript: string): Json {
  const next: Json = { ...(config || {}) };
  next.hooks = { ...(next.hooks || {}) };
  for (const event of CODEX_EVENTS) {
    const kept = (Array.isArray(next.hooks[event]) ? next.hooks[event] : []).filter((e: unknown) => !isOurs(e));
    next.hooks[event] = [...kept, { hooks: [{ type: 'command', command: `node "${hookScript}" --event ${event} --provider codex`, timeout: 10 }] }];
  }
  return next;
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

/** Atomic write; the first time remotea changes a file, the original is kept beside it. */
function writeJson(file: string, value: Json): void {
  const backup = `${file}.remotea-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tmp = `${file}.remotea-tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** The hook helper and the wmux CLI with the modules it loads (resources/cli), copied together. */
function copyHelper(p: HookPaths): string {
  fs.mkdirSync(p.cliDir, { recursive: true });
  for (const f of ['wmux-hook.js', 'transport-deadline.js', 'wmux.js']) {
    if (!fs.existsSync(path.join(p.sourceDir, f))) throw new Error(`missing ${path.join(p.sourceDir, f)} (is the repository intact?)`);
  }
  for (const f of fs.readdirSync(p.sourceDir)) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(p.sourceDir, f), path.join(p.cliDir, f));
  }
  return path.join(p.cliDir, 'wmux-hook.js');
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
    { agent: 'claude', dir: h('.claude'), file: h('.claude', 'settings.json'), kind: 'settings', apply: applyWmuxHooks, remove: removeWmuxHooks },
    { agent: 'codex', dir: h('.codex'), file: h('.codex', 'hooks.json'), kind: 'settings', apply: applyCodexHooks, remove: removeCodexHooks },
    { agent: 'opencode', dir: h('.config', 'opencode'), file: h('.config', 'opencode', 'plugin', 'wmux.js'), kind: 'plugin', source: res('opencode-plugin', 'wmux.js') },
    { agent: 'pi', dir: h('.pi'), file: h('.pi', 'agent', 'extensions', 'wmux.js'), kind: 'plugin', source: res('pi-extension', 'wmux.js') },
    { agent: 'omp', dir: h('.omp'), file: h('.omp', 'agent', 'extensions', 'wmux.js'), kind: 'plugin', source: res('omp-extension', 'wmux.js') },
    { agent: 'grok', dir: h('.grok'), file: h('.grok', 'hooks', 'wmux.json'), kind: 'grok' },
    { agent: 'qwen', dir: h('.qwen'), file: h('.qwen', 'settings.json'), kind: 'settings', apply: applyQwenHooks, remove: removeQwenHooksFrom },
    { agent: 'agy', dir: h('.gemini', 'antigravity-cli'), file: path.join(getAgyPluginDir(p.home), 'wmux-agy-hook.cjs'), kind: 'agy' },
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

/** Install for every agent whose config directory exists. Returns what was written. */
export function installHooks(p: HookPaths = defaultHookPaths()): HookTarget[] {
  const script = copyHelper(p);
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
        writeJson(t.file, t.apply(current ?? {}, script));
        break;
      }
      case 'plugin':
        // A file someone else put at that name is theirs: left alone.
        if (fs.existsSync(t.file) && !isOurPluginFile(t.file)) continue;
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
        fs.copyFileSync(t.source, t.file);
        break;
      case 'grok':
        if (fs.existsSync(t.file) && !isOurGrokFile(t.file)) continue;
        writeJson(t.file, buildGrokHooks(script));
        break;
      case 'agy':
        ensureAgyPlugin(p.home, path.resolve(p.sourceDir, '..', 'agy-plugin', 'wmux-agy-hook.cjs'));
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

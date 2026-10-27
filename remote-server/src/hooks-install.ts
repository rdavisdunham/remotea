/**
 * `remotea hooks install|remove|status`: register wmux's hook helper with the
 * agents that run in this WSL, so their status reaches the apps through the
 * hook bridge (see hook-bridge.ts).
 *
 * - Claude Code: ~/.claude/settings.json, the exact entries the Windows app
 *   writes there (src/shared/claude-hooks.ts).
 * - Codex CLI: ~/.codex/hooks.json, the same helper with `--provider codex`.
 * - OpenCode: wmux's OpenCode plugin, ~/.config/opencode/plugin/wmux.js. It
 *   reports through the wmux CLI (`node $WMUX_CLI …`), which sessions are
 *   told about in hookEnv; the plugin does nothing outside a remotea pane.
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

/** wmux's OpenCode plugin, which lives beside resources/cli. */
const OPENCODE_MARKER = 'WmuxPlugin';
function opencodePluginSource(p: HookPaths): string {
  return path.resolve(p.sourceDir, '..', 'opencode-plugin', 'wmux.js');
}
function isOurOpencodePlugin(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(OPENCODE_MARKER);
  } catch {
    return false;
  }
}

export interface HookTarget {
  agent: 'claude' | 'codex' | 'opencode';
  file: string;
  /** Present: the agent's config directory exists, so it is installed here. */
  present: boolean;
  entries: number;
}

function targets(p: HookPaths): Array<{ agent: HookTarget['agent']; file: string; dir: string }> {
  return [
    { agent: 'claude', dir: path.join(p.home, '.claude'), file: path.join(p.home, '.claude', 'settings.json') },
    { agent: 'codex', dir: path.join(p.home, '.codex'), file: path.join(p.home, '.codex', 'hooks.json') },
    { agent: 'opencode', dir: path.join(p.home, '.config', 'opencode'), file: path.join(p.home, '.config', 'opencode', 'plugin', 'wmux.js') },
  ];
}

export function hooksStatus(p: HookPaths = defaultHookPaths()): HookTarget[] {
  return targets(p).map((t) => ({
    agent: t.agent,
    file: t.file,
    present: fs.existsSync(t.dir),
    entries: t.agent === 'opencode' ? (isOurOpencodePlugin(t.file) ? 1 : 0) : countOurs(readJson(t.file)),
  }));
}

/** Install for every agent whose config directory exists. Returns what was written. */
export function installHooks(p: HookPaths = defaultHookPaths()): HookTarget[] {
  const script = copyHelper(p);
  for (const t of targets(p)) {
    if (!fs.existsSync(t.dir)) continue;
    if (t.agent === 'opencode') {
      // A plugin file someone else put at that name is theirs: left alone.
      if (fs.existsSync(t.file) && !isOurOpencodePlugin(t.file)) continue;
      fs.mkdirSync(path.dirname(t.file), { recursive: true });
      fs.copyFileSync(opencodePluginSource(p), t.file);
      continue;
    }
    const current = readJson(t.file) ?? {};
    writeJson(t.file, t.agent === 'claude' ? applyWmuxHooks(current, script) : applyCodexHooks(current, script));
  }
  return hooksStatus(p);
}

/** The protocol's view: which agents are here, and whether they report to remotea. */
export function toAgentStatus(rows: HookTarget[]): HookAgentStatus[] {
  return rows.map((r) => ({ agent: r.agent, present: r.present, installed: r.present && r.entries > 0 }));
}

export function removeHooks(p: HookPaths = defaultHookPaths()): HookTarget[] {
  for (const t of targets(p)) {
    if (t.agent === 'opencode') {
      if (isOurOpencodePlugin(t.file)) fs.rmSync(t.file);
      continue;
    }
    const current = readJson(t.file);
    if (!current || !countOurs(current)) continue;
    writeJson(t.file, t.agent === 'claude' ? removeWmuxHooks(current) : removeCodexHooks(current));
  }
  return hooksStatus(p);
}

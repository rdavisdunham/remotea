import { reportIntegrationFailure } from './integration-failures';
/**
 * Grok Build (xAI's `grok` CLI) integration.
 *
 * Grok needs less from remotea than any agent before it, because it already reads
 * Claude Code's files: with its Claude compatibility on (every `[compat.claude]`
 * cell defaults to true) it loads ~/.claude/CLAUDE.md and runs the hooks in
 * ~/.claude/settings.json. So a machine with the Claude integration granted was
 * already teaching Grok about remotea. This module covers the two places that
 * falls short.
 *
 * ── Hooks: $GROK_HOME/hooks/remotea.json ────────────────────────────────────────
 *
 * The same entries `applyRemoteaHooks` writes for Claude Code, byte for byte, plus
 * the two turn endings only Grok has. `StopCancelled` runs INSTEAD of `Stop`
 * when a turn ends without completing (Ctrl+C, a declined permission, the turn
 * limit) and `StopFailure` instead of it on an API error; without them an
 * interrupted Grok turn left the pane reading `working` until the trust window
 * aged it out. remotea-hook.js reports both as the turn ending.
 *
 * Duplicating the Claude entries is safe because Grok dedupes handlers across
 * sources on (event, command, url, matcher) — so with compat on each hook runs
 * once, and with `compat.claude.hooks = false` this file alone still carries
 * the full set. That only holds while the bytes match, which is why the command
 * strings come from claude-context.ts rather than being spelled again here.
 *
 * ── Instructions: $GROK_HOME/rules/remotea.md, only when Grok would miss them ───
 *
 * Grok loads every `*.md` in its home rules dir, so like Kiro this is a file of
 * remotea's own. But it is written only when Grok will NOT already read the remotea
 * block out of ~/.claude/CLAUDE.md — otherwise every Grok session would load the
 * same ~5 KB of instructions twice.
 *
 * Nothing is written unless Grok's home directory exists: creating ~/.grok on a
 * machine that has never run Grok would be the #132 mistake.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readRenderedInstructions } from './agent-instructions';
import { isLegacyRemoteaBlockFile, isLegacyRemoteaGrokHooksFile } from '../shared/legacy-cleanup';
import { LEGACY_PLUGIN_FILES } from '../shared/legacy-names';
import { desktopOwnershipContext } from './ownership-context';
import {
  applyRemoteaHooks,
  getClaudeMdPath,
  getHookScriptPath,
  remoteaEventHookCommand,
} from './claude-context';

const START_MARKER = '<!-- remotea:start';

/** Grok's turn endings that Claude Code has no equivalent for. */
const GROK_ONLY_EVENTS = ['StopCancelled', 'StopFailure'] as const;

function defaultGrokHome(): string {
  return path.join(os.homedir(), '.grok');
}

/**
 * `$GROK_HOME`, default ~/.grok — the root of both the rules and hooks dirs.
 *
 * The override is read only from remotea's OWN environment (one exported per-shell
 * after launch is unknowable here — a miss, never a write to the wrong place),
 * and only when it is ABSOLUTE. A relative value means "relative to wherever
 * grok is started", which is a different directory for every pane and not the
 * one remotea happens to be running in; resolving it against remotea's cwd would
 * write hooks into a folder nobody named.
 */
export function getGrokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override && path.isAbsolute(override) ? path.normalize(override) : defaultGrokHome();
}

/**
 * Every home remotea may have written into: the current one, and the default. They
 * differ only while GROK_HOME is set, and removal sweeps both — an uninstall
 * that only looks where it would write TODAY leaves behind the file it wrote
 * before the variable was set, which is an inverse that cannot undo (#132).
 */
function grokHomes(): string[] {
  return [...new Set([getGrokHome(), defaultGrokHome()])];
}

const rulesPathIn = (home: string) => path.join(home, 'rules', 'remotea.md');
const hooksPathIn = (home: string) => path.join(home, 'hooks', 'remotea.json');

/**
 * Delete a file remotea wrote under its old name, only when the path inside it
 * is this install's (KTD8). A wmux install writes the same file names.
 */
function removeProvenOldFile(filePath: string, isProven: (content: string) => boolean): void {
  try {
    if (isProven(fs.readFileSync(filePath, 'utf-8'))) fs.unlinkSync(filePath);
  } catch { /* absent or unreadable: leave it */ }
}

function removeOldRules(home: string): void {
  const ctx = desktopOwnershipContext();
  removeProvenOldFile(path.join(home, 'rules', LEGACY_PLUGIN_FILES.grokRules[0]), (s) => isLegacyRemoteaBlockFile(s, ctx));
}

function removeOldHooks(home: string): void {
  const ctx = desktopOwnershipContext();
  removeProvenOldFile(path.join(home, 'hooks', LEGACY_PLUGIN_FILES.grokHooks[0]), (s) => isLegacyRemoteaGrokHooksFile(s, ctx));
}

export function getGrokRulesPath(): string {
  return rulesPathIn(getGrokHome());
}

export function getGrokHooksPath(): string {
  return hooksPathIn(getGrokHome());
}

function readOrEmpty(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

/**
 * Pure: does this config.toml switch `compat.claude.agents` off?
 *
 * Accepts the `[compat.claude]` table, a dotted key under `[compat]`, and a
 * fully dotted key at the top level.
 * ponytail: line scan, not a TOML parser — an inline table
 * (`claude = { agents = false }`) reads as "on". The miss costs a Grok session
 * the remotea instructions, which is where things stood before; add a parser if
 * anyone writes it that way.
 */
export function claudeAgentsCompatOff(toml: string): boolean {
  let table = '';
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) { table = '\0'; continue; } // array of tables: never ours
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { table = header[1].replace(/["'\s]/g, ''); continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (!kv) continue;
    const key = [table, kv[1].replace(/["'\s]/g, '')].filter(Boolean).join('.');
    if (key === 'compat.claude.agents') return kv[2].trim() === 'false';
  }
  return false;
}

/**
 * Will Grok already see the remotea block in ~/.claude/CLAUDE.md?
 *
 * Resolved the way Grok resolves the cell — env var over config.toml over the
 * default (on). The env var read is remotea's own, which every pane inherits; one
 * exported per-shell after launch is unknowable here, and the worst case is the
 * instructions loading twice.
 */
export function grokReadsClaudeContext(): boolean {
  const env = process.env.GROK_CLAUDE_AGENTS_ENABLED?.trim();
  const compatOn = env
    ? !/^(0|false|no|off)$/i.test(env)
    : !claudeAgentsCompatOff(readOrEmpty(path.join(getGrokHome(), 'config.toml')));
  return compatOn && readOrEmpty(getClaudeMdPath()).includes(START_MARKER);
}

/** Pure: the whole hooks file, given the absolute path to remotea-hook.js. */
export function buildGrokHooks(hookScript: string): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = { ...applyRemoteaHooks({}, hookScript).hooks };
  for (const event of GROK_ONLY_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command: remoteaEventHookCommand(hookScript, event) }] }];
  }
  return { hooks };
}

/**
 * Write `content` to a file remotea owns inside Grok's home, or leave a same-named
 * file of the user's alone. No-op when Grok has never run here.
 */
function writeOwnedFile(filePath: string, content: string, isOurs: (s: string) => boolean): void {
  if (!isDirectory(getGrokHome())) return;
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf-8');
    if (!isOurs(current)) {
      console.warn(`[remotea] ${filePath} exists and is not remotea's — leaving it alone`);
      return;
    }
    if (current === content) return; // already current; don't churn the mtime
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`[remotea] Updated ${filePath}`);
}

function removeOwnedFile(filePath: string, isOurs: (s: string) => boolean): void {
  if (!fs.existsSync(filePath)) return;
  if (!isOurs(fs.readFileSync(filePath, 'utf-8'))) return;
  fs.unlinkSync(filePath);
  console.log(`[remotea] Removed ${filePath}`);
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `node "<anything>remotea-hook.js" <arg>` — the only command shape remotea registers. */
const REMOTEA_HOOK_COMMAND_RE = /^node "[^"]*remotea-hook\.js" \S/;

function isRemoteaHandler(handler: unknown): boolean {
  return isRecord(handler)
    && handler.type === 'command'
    && typeof handler.command === 'string'
    && REMOTEA_HOOK_COMMAND_RE.test(handler.command);
}

/** Every handler under one event, or null when it is not a list of matcher groups. */
function handlersOf(groups: unknown): unknown[] | null {
  if (!Array.isArray(groups)) return null;
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return null;
    out.push(...group.hooks);
  }
  return out;
}

/**
 * Pure: is this hooks file ENTIRELY remotea's?
 *
 * JSON has no comment to carry a marker, and "contains the string remotea-hook" is
 * not ownership: `remotea.json` is the obvious name for a file a user writes by
 * hand to wire Grok into remotea, and the moment they add one hook of their own to
 * it a substring test has remotea overwrite that hook on the next launch and delete
 * it when the toggle goes off. So the test is structural — nothing but a `hooks`
 * object, and every handler in it a remotea-hook.js command. One foreign handler,
 * one extra top-level key, or a file that does not parse, and it is the user's.
 * It matches the command SHAPE rather than this install's path, so a file
 * written before the install moved is still recognised and refreshed.
 */
export function isRemoteaHooksFile(content: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return false;
  if (Object.keys(parsed).some(k => k !== 'hooks')) return false;
  let count = 0;
  for (const groups of Object.values(parsed.hooks)) {
    const handlers = handlersOf(groups);
    if (!handlers?.every(isRemoteaHandler)) return false;
    count += handlers.length;
  }
  return count > 0;
}

const isOurRules = (s: string) => s.includes(START_MARKER);

/**
 * Called AFTER ensureClaudeContext, so the CLAUDE.md check sees this launch's
 * write. When Grok reads that block, a rules file left by an earlier launch
 * (compat was off then) is removed rather than kept as a duplicate.
 */
export function ensureGrokContext(): void {
  try {
    if (grokReadsClaudeContext()) { removeGrokContext(); return; }
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const rendered = readRenderedInstructions();
    if (rendered === null) return;
    removeOldRules(getGrokHome());
    writeOwnedFile(getGrokRulesPath(), rendered.trimEnd() + '\n', isOurRules);
  } catch (err) {
    reportIntegrationFailure('Grok', 'write', err);
    console.warn('[remotea] Failed to update Grok context:', err);
  }
}

export function removeGrokContext(): void {
  try {
    for (const home of grokHomes()) removeOwnedFile(rulesPathIn(home), isOurRules);
  } catch (err) {
    reportIntegrationFailure('Grok', 'remove', err);
    console.warn('[remotea] Failed to remove Grok context:', err);
  }
}

export function ensureGrokHooks(): void {
  try {
    const content = JSON.stringify(buildGrokHooks(getHookScriptPath()), null, 2) + '\n';
    removeOldHooks(getGrokHome());
    writeOwnedFile(getGrokHooksPath(), content, isRemoteaHooksFile);
  } catch (err) {
    reportIntegrationFailure('Grok', 'write', err);
    console.warn('[remotea] Failed to update Grok hooks:', err);
  }
}

export function removeGrokHooks(): void {
  try {
    for (const home of grokHomes()) removeOwnedFile(hooksPathIn(home), isRemoteaHooksFile);
  } catch (err) {
    reportIntegrationFailure('Grok', 'remove', err);
    console.warn('[remotea] Failed to remove Grok hooks:', err);
  }
}

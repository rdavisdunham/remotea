import { reportIntegrationFailure } from './integration-failures';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readRenderedInstructions } from './agent-instructions';

const START_MARKER = '<!-- remotea:start';
const END_MARKER = '<!-- remotea:end -->';


export function getClaudeMdPath(): string {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md');
}

/** An H1 that opens a block wmux wrote before it delimited them with markers. */
const LEGACY_HEADING = /^#\s+[ws]mux\s*$/;
/** Text only wmux's own block contains — a user's `# wmux` notes must survive. */
const LEGACY_SIGNATURES = [
  /You are running inside [ws]mux/,
  /^[ws]mux browser open <url>/m,
];

/**
 * Remove copies of the wmux block that predate the markers (and the smux-era
 * name), so the managed section is the only one left.
 *
 * Early versions appended the block with no `<!-- remotea:start -->` around it.
 * Splicing keys off the FIRST marker pair, so those copies were never updated
 * and never removed: they accumulate, one per rename or marker change, and are
 * loaded into every session on the machine forever. The file this was found on
 * carried six — five `# wmux`, one `# smux` — several contradicting each other
 * about the CLI's own name.
 *
 * Only a `# wmux` / `# smux` H1 whose body carries one of wmux's own sentences
 * is taken. Fenced code is tracked so a `# Title` inside an example cannot end
 * a span early, and the managed block is excluded from the scan entirely — it
 * has the same heading and is handled by the markers.
 */
export function stripLegacyBlocks(content: string): string {
  const managed = managedSpan(content);
  if (managed) {
    return collapse(
      stripLegacyBlocks(content.substring(0, managed.start))
      + content.substring(managed.start, managed.end)
      + stripLegacyBlocks(dropMarkedBlocks(content.substring(managed.end))),
    );
  }
  return collapse(dropLegacySections(content.split('\n')).join('\n'));
}

/**
 * Remove every complete `<!-- remotea:start … <!-- remotea:end -->` pair.
 *
 * Applied only to what follows the FIRST pair — the one block that is managed.
 * This used to recurse with stripLegacyBlocks, which treated each later pair as
 * managed in turn and so protected every one of them: a machine that had lived
 * through a few marker revisions carried six stale copies of wmux's block,
 * MARKED, that no launch would ever remove — each loaded into every Claude
 * session as instructions contradicting the current one (found while working
 * #282, which is about another app named wmux; that app writes no CLAUDE.md
 * block, so these markers are only ever wmux's own). An unterminated start is
 * left alone: without its end there is no telling where the user's text resumes.
 */
function dropMarkedBlocks(content: string): string {
  let out = content;
  for (let start = out.indexOf(START_MARKER); start !== -1; start = out.indexOf(START_MARKER, start)) {
    const end = out.indexOf(END_MARKER, start);
    if (end === -1) break;
    out = out.substring(0, start) + out.substring(end + END_MARKER.length);
  }
  return out;
}

/** The marker-delimited block, which the scan must leave alone. */
function managedSpan(content: string): { start: number; end: number } | null {
  const start = content.indexOf(START_MARKER);
  if (start === -1) return null;
  const end = content.indexOf(END_MARKER, start);
  return end === -1 ? null : { start, end: end + END_MARKER.length };
}

const isFence = (line: string): boolean => line.trimStart().startsWith('```');

/** Index just past the section opened at `from`: the next unfenced H1, or EOF. */
function sectionEnd(lines: string[], from: number): number {
  let end = from + 1;
  let fenced = false;
  while (end < lines.length) {
    if (isFence(lines[end])) fenced = !fenced;
    else if (!fenced && /^#\s+\S/.test(lines[end])) break;
    end++;
  }
  return end;
}

function dropLegacySections(lines: string[]): string[] {
  const kept: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    if (isFence(lines[i])) inFence = !inFence;
    const end = !inFence && LEGACY_HEADING.test(lines[i]) ? sectionEnd(lines, i) : -1;
    if (end !== -1 && LEGACY_SIGNATURES.some((re) => re.test(lines.slice(i, end).join('\n')))) {
      i = end;
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return kept;
}

/** Removal leaves gaps behind; three or more blank lines become one break. */
function collapse(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Ensures the user's global ~/.claude/CLAUDE.md contains the wmux section.
 * - Creates ~/.claude/ and CLAUDE.md if they don't exist
 * - Inserts the wmux block if not present
 * - Updates the wmux block if it's outdated
 * - Drops marker-less copies left by older versions (they are ours, and stale)
 * - Never touches content outside the <!-- remotea:start --> / <!-- remotea:end --> markers
 */
export function ensureClaudeContext(): void {
  try {
    // Rendered rather than read: the block carries this install's absolute CLI
    // path, so a session that wmux did not spawn (and therefore has no `wmux`
    // on PATH) can still tell "not running" from "not reachable" — issue #158.
    const remoteaBlock = readRenderedInstructions();
    if (remoteaBlock === null) return;
    const claudeMdPath = getClaudeMdPath();
    const claudeDir = path.dirname(claudeMdPath);

    // Ensure ~/.claude/ exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    if (!fs.existsSync(claudeMdPath)) {
      // No CLAUDE.md yet — create with just the wmux block
      fs.writeFileSync(claudeMdPath, remoteaBlock, 'utf-8');
      console.log('[remotea] Created ~/.claude/CLAUDE.md with remotea context');
      return;
    }

    // CLAUDE.md exists — check for existing wmux block
    const raw = fs.readFileSync(claudeMdPath, 'utf-8');
    // Old-named blocks go only when their path is this install's (KTD8).
    const existing = stripLegacyBlocks(stripOldRemoteaBlocks(raw, desktopOwnershipContext()));
    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);

    if (startIdx === -1) {
      // No wmux block — append it
      if (existing.trim() === '') {
        fs.writeFileSync(claudeMdPath, remoteaBlock, 'utf-8');
      } else {
        const separator = existing.endsWith('\n') ? '\n' : '\n\n';
        fs.writeFileSync(claudeMdPath, existing + separator + remoteaBlock, 'utf-8');
      }
      console.log('[remotea] Appended remotea context to ~/.claude/CLAUDE.md');
      return;
    }

    if (endIdx === -1) {
      // Broken markers — replace from start marker to end of file
      const before = existing.substring(0, startIdx);
      fs.writeFileSync(claudeMdPath, before + remoteaBlock, 'utf-8');
      console.log('[remotea] Fixed and updated remotea context in ~/.claude/CLAUDE.md');
      return;
    }

    // Both markers found — replace the block
    const currentBlock = existing.substring(startIdx, endIdx + END_MARKER.length);
    if (currentBlock.trim() === remoteaBlock.trim() && existing === raw) {
      // Already up to date, and nothing stale left beside it
      return;
    }

    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + END_MARKER.length);
    fs.writeFileSync(claudeMdPath, before + remoteaBlock + after, 'utf-8');
    console.log('[remotea] Updated remotea context in ~/.claude/CLAUDE.md');
  } catch (err) {
    reportIntegrationFailure('Claude Code', 'write', err);
    console.warn('[remotea] Failed to update Claude context:', err);
  }
}

/**
 * Remove the marker-delimited wmux block from a CLAUDE.md-style document,
 * leaving everything the user wrote (issue #132). Pure, so the marker
 * arithmetic is testable without touching a real home directory.
 *
 * Returns `null` when there is nothing to remove, so callers can skip the write
 * entirely rather than rewriting a file they did not change. A start marker with
 * no end marker means a previous write was interrupted or hand-edited: the block
 * is taken to run to end-of-file, matching how ensureClaudeContext repairs the
 * same damage. The blank lines that joined the block to its surroundings are
 * collapsed so removal doesn't leave a growing gap behind.
 */
export function stripRemoteaBlock(content: string): string | null {
  const startIdx = content.indexOf(START_MARKER);
  if (startIdx === -1) return null;
  const endIdx = content.indexOf(END_MARKER, startIdx);
  const before = content.substring(0, startIdx);
  // Stale duplicates after it go too — an uninstall that leaves copies of the
  // block behind has not uninstalled (see dropMarkedBlocks).
  const after = endIdx === -1 ? '' : collapse(dropMarkedBlocks(content.substring(endIdx + END_MARKER.length)));
  const joined = before.trimEnd() + (after.trim() ? '\n\n' + after.trimStart() : '');
  return joined.trim() ? joined.trimEnd() + '\n' : '';
}

/**
 * Delete wmux's block from ~/.claude/CLAUDE.md. When the file consisted of
 * nothing but that block — i.e. wmux created it — the file itself is removed,
 * since leaving an empty CLAUDE.md behind is still a file the user never asked
 * for.
 */
export function removeClaudeContext(): void {
  try {
    const claudeMdPath = getClaudeMdPath();
    if (!fs.existsSync(claudeMdPath)) return;
    const stripped = stripRemoteaBlock(fs.readFileSync(claudeMdPath, 'utf-8'));
    if (stripped === null) return; // no wmux block — nothing of ours to take back
    if (stripped === '') fs.unlinkSync(claudeMdPath);
    else fs.writeFileSync(claudeMdPath, stripped, 'utf-8');
    console.log('[remotea] Removed remotea context from ~/.claude/CLAUDE.md');
  } catch (err) {
    reportIntegrationFailure('Claude Code', 'remove', err);
    console.warn('[remotea] Failed to remove Claude context:', err);
  }
}


function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getCliAbsolutePath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli', 'remotea.js');
    }
  } catch {}
  return path.resolve(path.join(__dirname, '../cli/remotea.js'));
}

// The hook-entry builders are pure and shared with the remotea server (which
// installs the same hooks inside WSL): see src/shared/claude-hooks.ts.
export { applyRemoteaHooks, removeRemoteaHooks, remoteaEventHookCommand, REMOTEA_HOOK_EVENTS } from '../shared/claude-hooks';
import { applyRemoteaHooks, removeRemoteaHooks, REMOTEA_HOOK_EVENTS } from '../shared/claude-hooks';
import { stripLegacyBlocks as stripOldRemoteaBlocks, stripLegacyHookEntries } from '../shared/legacy-cleanup';
import { desktopOwnershipContext } from './ownership-context';

/**
 * Absolute, forward-slashed path to the hook helper OUTSIDE the ASAR.
 * __dirname is inside app.asar when packaged — Node.js outside Electron can't
 * read ASAR files, so we use the standalone copy in resources/cli/.
 */
export function getHookScriptPath(): string {
  let hookScript: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      hookScript = path.join(process.resourcesPath, 'cli', 'remotea-hook.js');
    } else {
      hookScript = path.resolve(path.join(__dirname, '../../resources/cli/remotea-hook.js'));
    }
  } catch {
    hookScript = path.resolve(path.join(__dirname, '../../resources/cli/remotea-hook.js'));
  }
  return hookScript.split(path.sep).join('/');
}

/**
 * Ensures Claude Code's ~/.claude/settings.json has the wmux hooks:
 *  - PostToolUse   → drives the sidebar/diff view (tool activity)
 *  - Notification  → fires a wmux notification when the agent needs input/permission
 *  - Stop          → fires a wmux notification when the agent finishes its turn
 *  - SubagentStop  → fires when one parallel subagent finishes (sidebar agent lines)
 *  - SessionStart  → the pane is now an agent session, idle (issue #151)
 *  - UserPromptSubmit → the human replied: turn started, block over (issue #151)
 *  - PreToolUse    → a tool started, so long tools don't read as idle (issue #151)
 *  - SessionEnd    → Claude Code exited; release the pane (issue #151)
 * Uses absolute CLI paths (not env var). Never touches non-wmux hook entries
 * (issue #53): existing user hooks in each array are preserved.
 */
export function ensureClaudeHooks(): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return;

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; }

    // Old-named entries go only when their path is this install's (KTD8).
    const updated = applyRemoteaHooks(stripLegacyHookEntries(settings, desktopOwnershipContext()), getHookScriptPath());
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf-8');
    console.log(`[remotea] Configured ${REMOTEA_HOOK_EVENTS.join('/')} hooks in ~/.claude/settings.json`);
  } catch (err) {
    reportIntegrationFailure('Claude Code', 'write', err);
    console.warn('[remotea] Failed to update Claude hooks:', err);
  }
}

/** Take wmux's hooks back out of ~/.claude/settings.json, leaving user hooks (issue #132). */
export function removeClaudeHooks(): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return;
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; }

    const updated = removeRemoteaHooks(settings);
    // Compare before writing: on every launch after a decline this function runs
    // again, and rewriting an unchanged file would keep bumping its mtime for no
    // reason (and race anyone else editing it).
    const next = JSON.stringify(updated, null, 2);
    if (next === JSON.stringify(settings, null, 2)) return;
    fs.writeFileSync(settingsPath, next, 'utf-8');
    console.log('[remotea] Removed remotea hooks from ~/.claude/settings.json');
  } catch (err) {
    reportIntegrationFailure('Claude Code', 'remove', err);
    console.warn('[remotea] Failed to remove Claude hooks:', err);
  }
}

/**
 * Where Claude Code actually reads user-scope MCP servers from (issue #237).
 *
 * NOT `~/.claude/settings.json`, which is where wmux wrote this for six
 * releases. `settings.json` has no `mcpServers` key — its schema strips unknown
 * keys rather than erroring, so the entry landed in a file, changed nothing, and
 * `ensureChromeDevtoolsConfig` logged a success. `claude mcp list` never showed
 * it. That is the whole of #237's first blocker, and it is a silent failure by
 * construction: there is no observable difference between "written" and
 * "written somewhere nobody reads" unless you go and look.
 *
 * `~/.claude.json`'s top-level `mcpServers` is the user scope — what
 * `claude mcp add --scope user` writes. `settings.json` holds only the
 * approval/policy keys (`enabledMcpjsonServers`, `allowedMcpServers`, …), which
 * is why the `enabledPlugins` half below stays exactly where it was.
 */
function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Version selected for this wmux release. Do not use a mutable npm dist-tag
 * here: this command is persisted in Claude's config and may execute long
 * after the wmux release that wrote it.
 */
export const CHROME_DEVTOOLS_MCP_PACKAGE = 'chrome-devtools-mcp@1.7.0';

/** Build the custom MCP server entry written to Claude's user config. */
export function buildChromeDevtoolsMcpServer(): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['-y', CHROME_DEVTOOLS_MCP_PACKAGE, '--browserUrl=http://127.0.0.1:9222'],
  };
}

/**
 * Whether a `chrome-devtools` entry already in Claude's config is one wmux wrote.
 *
 * The predicate has to be "did wmux author this", not "is this what wmux wants".
 * Pinning the package (#161) means the desired entry changes on every release
 * that moves the pin, and a plain inequality check would therefore rewrite the
 * entry on every launch — including one the user had deliberately retuned. That
 * is precisely the behaviour issue #132 was filed about, and it would have made
 * the write path contradict {@link removeChromeDevtoolsConfig}, which already
 * takes care to leave a user's own entry alone on the way out.
 *
 * wmux's signature is narrow and stable across pins: launched via npx, running
 * the chrome-devtools-mcp package, aimed at wmux's own CDP proxy port. Anything
 * else — a different port, a global install, extra flags someone added — is
 * treated as the user's and left untouched.
 */
export function isRemoteaAuthoredMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { command?: unknown; args?: unknown };
  if (e.command !== 'npx') return false;
  if (!Array.isArray(e.args)) return false;
  const args = e.args.filter((a): a is string => typeof a === 'string');
  return (
    args.some(a => a.startsWith('chrome-devtools-mcp@')) &&
    args.includes('--browserUrl=http://127.0.0.1:9222')
  );
}

/** The `mcpServers` object of a parsed config, or undefined if there isn't a usable one. */
function mcpServersOf(config: unknown): Record<string, unknown> | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const servers = (config as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined;
  return servers as Record<string, unknown>;
}

/**
 * Put the `chrome-devtools` entry into a parsed `~/.claude.json`, or report that
 * it is already right.
 *
 * Pure and separate from the write because `~/.claude.json` is Claude Code's own
 * live state file — it holds the OAuth account, per-project history, onboarding
 * flags — and wmux rewrites it whole. Every needless write is a chance to lose
 * something Claude Code wrote a millisecond earlier, so "changed" has to be
 * exact, not approximate.
 */
export function applyChromeDevtoolsMcp(config: unknown): { next: any; changed: boolean } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { next: config, changed: false };
  }
  const next = config as Record<string, any>;
  const existing = mcpServersOf(next)?.['chrome-devtools'];
  // Somebody else's entry stands; wmux does not get to retune it.
  if (existing && !isRemoteaAuthoredMcpEntry(existing)) return { next, changed: false };
  const desired = buildChromeDevtoolsMcpServer();
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) return { next, changed: false };
  if (!mcpServersOf(next)) next.mcpServers = {};
  next.mcpServers['chrome-devtools'] = desired;
  return { next, changed: true };
}

/**
 * The inverse: drop the entry, and the `mcpServers` object with it if wmux's was
 * the only one in there — an empty key left behind is still a footprint in a
 * file wmux was asked to stay out of.
 *
 * Matches on {@link isRemoteaAuthoredMcpEntry}, not on the port alone: a user who
 * has since pointed `chrome-devtools` at their own Chrome keeps it.
 *
 * This is also the migration for #237's first blocker. Older releases wrote the
 * entry into `~/.claude/settings.json`, where it did nothing; the same function
 * clears it from there, because the shape is identical and it is wmux's litter
 * either way. It is actively confusing litter: #237 was reported by someone who
 * found the entry sitting in settings.json, correct in every detail, while
 * `claude mcp list` disagreed.
 */
export function stripChromeDevtoolsMcp(config: unknown): { next: any; changed: boolean } {
  const next = config as Record<string, any>;
  const servers = mcpServersOf(config);
  if (!servers || !('chrome-devtools' in servers)) return { next, changed: false };
  if (!isRemoteaAuthoredMcpEntry(servers['chrome-devtools'])) return { next, changed: false };
  delete servers['chrome-devtools'];
  if (Object.keys(servers).length === 0) delete next.mcpServers;
  return { next, changed: true };
}

/** Parsed JSON at `filePath`, or null if it is missing or unreadable. */
function readJsonIfExists(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write a parsed config back over Claude Code's live state file.
 *
 * Temp-file + rename, for the reason `session-persistence.ts` spells out at
 * length (#214): a plain `writeFileSync` over 160 KB of somebody else's state
 * leaves a truncated file readable if the process dies mid-write, and this
 * particular file holds the user's Claude Code login. `renameSync` maps onto
 * `MoveFileExW`/`MOVEFILE_REPLACE_EXISTING`, so the old file is replaced rather
 * than ever being absent.
 */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = filePath + '.wmux.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The temp file is already gone, or is locked by whatever just failed the
      // write. Either way the original config is untouched, which is the only
      // thing this cleanup is protecting.
    }
    throw err;
  }
}

/**
 * The `~/.claude.json` half, both directions. Guarded on the file existing:
 * wmux does not bring Claude Code's state file into being on a machine where
 * Claude Code has never run, and an absent file means there is no install to
 * configure either.
 */
function syncClaudeConfigMcp(wanted: boolean): void {
  try {
    const configPath = getClaudeConfigPath();
    const config = readJsonIfExists(configPath);
    if (!config) return;
    const { next, changed } = wanted ? applyChromeDevtoolsMcp(config) : stripChromeDevtoolsMcp(config);
    if (!changed) return;
    writeJsonAtomic(configPath, next);
    console.log(
      wanted
        ? '[remotea] Configured chrome-devtools-mcp in ~/.claude.json → localhost:9222'
        : '[remotea] Removed chrome-devtools-mcp from ~/.claude.json'
    );
  } catch (err) {
    reportIntegrationFailure('Claude Code', wanted ? 'write' : 'remove', err);
    console.warn('[remotea] Failed to update chrome-devtools-mcp in ~/.claude.json:', err);
  }
}

/**
 * The `~/.claude/settings.json` half: the official plugin's enabled flag, which
 * genuinely IS read from here, plus the removal of the MCP entry older releases
 * wrote into this file by mistake. The stale entry goes on BOTH paths, so an
 * existing install is cleaned up by the upgrade rather than by the user first
 * having to switch the feature off.
 */
function syncSettingsPluginFlag(wanted: boolean): void {
  const pluginKey = 'chrome-devtools-mcp@claude-plugins-official';
  try {
    const settingsPath = getSettingsPath();
    const settings = readJsonIfExists(settingsPath);
    if (!settings) return;

    let changed = stripChromeDevtoolsMcp(settings).changed;

    if (wanted) {
      // The official plugin launches its own Chrome, which is the thing being
      // replaced.
      if (settings.enabledPlugins?.[pluginKey] !== false) {
        if (!settings.enabledPlugins) settings.enabledPlugins = {};
        settings.enabledPlugins[pluginKey] = false;
        changed = true;
      }
    } else if (settings.enabledPlugins?.[pluginKey] === false) {
      // Only `false` — the value wmux set. A user who deliberately re-enabled
      // the plugin keeps their `true`.
      delete settings.enabledPlugins[pluginKey];
      if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
      changed = true;
    }

    if (changed) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    reportIntegrationFailure('Claude Code', wanted ? 'write' : 'remove', err);
    console.warn('[remotea] Failed to update the chrome-devtools plugin flag:', err);
  }
}

/**
 * Point chrome-devtools-mcp at wmux's CDP proxy on localhost:9222, and stop the
 * official plugin from launching a Chrome of its own.
 *
 * Two files, because the two halves are read from two places (issue #237): the
 * server definition goes to `~/.claude.json`, the plugin flag stays in
 * `~/.claude/settings.json`.
 */
export function ensureChromeDevtoolsConfig(): void {
  syncClaudeConfigMcp(true);
  syncSettingsPluginFlag(true);
}

/**
 * Undo {@link ensureChromeDevtoolsConfig} (issue #132): drop the MCP server
 * entry wmux added — from both the file it belongs in and the file older
 * releases put it in — and stop forcing the official plugin off.
 */
export function removeChromeDevtoolsConfig(): void {
  syncClaudeConfigMcp(false);
  syncSettingsPluginFlag(false);
}

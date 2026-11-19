import { reportIntegrationFailure } from './integration-failures';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stripRemoteaBlock, stripLegacyBlocks } from './claude-context';
import { injectRemoteaBlock as spliceBlock, readRenderedInstructions } from './agent-instructions';
import { isRemoteaPluginFile, pluginNeedsUpdate } from './agent-plugin-file';

/**
 * Re-exported rather than moved, because the tests target it here and because
 * this is still the file that documents what the marker is for. The
 * implementation went to agent-plugin-file.ts when the pi extension (#231)
 * became the second thing wmux installs into somebody else's config directory —
 * a duplicate with no enforcement is not a duplicate, it is a time bomb (#137).
 */
export { pluginNeedsUpdate };

/**
 * Pure: insert/replace the wmux block within existing content, preserving the rest.
 *
 * Thin wrapper over the shared splice in agent-instructions.ts, kept as a named
 * export because the existing tests target it here. The implementation moved
 * when omp became the third agent needing it (#165) — and the copy written for
 * omp had already lost the `trimEnd()` this one depends on, appending one blank
 * line per launch to a file the agent reads every session.
 */
export function injectRemoteaBlock(rawExisting: string, remoteaBlock: string): string {
  return spliceBlock(rawExisting, remoteaBlock, stripLegacyBlocks);
}

function getAgentsMdPath(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
}

/** Ensures ~/.config/opencode/AGENTS.md contains the wmux block. */
export function ensureOpencodeContext(): void {
  try {
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const remoteaBlock = readRenderedInstructions();
    if (remoteaBlock === null) return;
    const agentsPath = getAgentsMdPath();
    const dir = path.dirname(agentsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
    const next = injectRemoteaBlock(existing, remoteaBlock);
    if (next !== existing) {
      fs.writeFileSync(agentsPath, next, 'utf-8');
      console.log('[remotea] Updated remotea context in ~/.config/opencode/AGENTS.md');
    }
  } catch (err) {
    reportIntegrationFailure('OpenCode', 'write', err);
    console.warn('[remotea] Failed to update OpenCode context:', err);
  }
}

export function getPluginSrcPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'opencode-plugin', 'remotea.js');
    }
  } catch { /* not running under Electron */ }
  return path.join(__dirname, '../../resources/opencode-plugin/remotea.js');
}

/** Installs/updates the wmux OpenCode plugin into ~/.config/opencode/plugin/. */
export function ensureOpencodePlugin(): void {
  try {
    const srcPath = getPluginSrcPath();
    if (!fs.existsSync(srcPath)) {
      console.warn('[remotea] opencode plugin source not found at', srcPath);
      return;
    }
    const src = fs.readFileSync(srcPath, 'utf-8');
    const destDir = path.join(os.homedir(), '.config', 'opencode', 'plugin');
    const dest = path.join(destDir, 'remotea.js');
    const target = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;
    if (!pluginNeedsUpdate(src, target)) return;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, src, 'utf-8');
    console.log('[remotea] Installed remotea OpenCode plugin to', dest);
  } catch (err) {
    reportIntegrationFailure('OpenCode', 'write', err);
    console.warn('[remotea] Failed to install OpenCode plugin:', err);
  }
}

/**
 * Delete wmux's block from ~/.config/opencode/AGENTS.md (issue #132).
 *
 * Mirrors removeClaudeContext: the file goes only when it held nothing but our
 * block, so an AGENTS.md the user wrote survives with just the block excised.
 * The stripping itself is shared — the two files use identical markers, and
 * having one implementation is what stops the two paths from drifting.
 */
export function removeOpencodeContext(): void {
  try {
    const agentsPath = getAgentsMdPath();
    if (!fs.existsSync(agentsPath)) return;
    const stripped = stripRemoteaBlock(fs.readFileSync(agentsPath, 'utf-8'));
    if (stripped === null) return;
    if (stripped === '') fs.unlinkSync(agentsPath);
    else fs.writeFileSync(agentsPath, stripped, 'utf-8');
    console.log('[remotea] Removed remotea context from ~/.config/opencode/AGENTS.md');
  } catch (err) {
    reportIntegrationFailure('OpenCode', 'remove', err);
    console.warn('[remotea] Failed to remove OpenCode context:', err);
  }
}

/**
 * Remove the wmux OpenCode plugin (issue #132).
 *
 * Guarded on the version marker wmux stamps into its own plugin source: a
 * remotea.js the user wrote or vendored themselves has no marker and is left where
 * it is, because uninstalling our integration must not delete their file.
 */
export function removeOpencodePlugin(): void {
  try {
    const dest = path.join(os.homedir(), '.config', 'opencode', 'plugin', 'remotea.js');
    if (!fs.existsSync(dest)) return;
    if (!isRemoteaPluginFile(fs.readFileSync(dest, 'utf-8'))) return;
    fs.unlinkSync(dest);
    console.log('[remotea] Removed the remotea OpenCode plugin from', dest);
  } catch (err) {
    reportIntegrationFailure('OpenCode', 'remove', err);
    console.warn('[remotea] Failed to remove OpenCode plugin:', err);
  }
}

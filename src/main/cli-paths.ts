/**
 * Where the `remotea` CLI entry points live on this install.
 *
 * Split out of pty-manager.ts because two very different callers need the same
 * answer and must not disagree about it: the PTY spawner, which prepends these
 * directories to PATH so bare `remotea` resolves inside a pane, and the agent
 * context writers, which have to tell a session that is NOT inside a pane where
 * to find the CLI (issue #158).
 */
import * as path from 'path';

/**
 * Dir holding the `remotea`/`remotea.cmd` shims (each runs `node $REMOTEA_CLI`).
 *
 * Prepended to PATH in every spawned shell so bare `remotea` resolves in
 * NON-interactive shells too (Claude Code's Bash tool, orchestrator hook
 * scripts) — the interactive `remotea` shell function only exists in the pane's
 * own interactive shell. The dir has no remotea.exe, so there is no PATHEXT
 * collision with the GUI.
 */
export function getCliBinPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli-bin');
    }
  } catch {
    // Not running in Electron
  }
  return path.join(__dirname, '../../src/cli-bin');
}

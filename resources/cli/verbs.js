"use strict";
/**
 * One `remotea` command, two programs (KTD11). Inside a remotea terminal it
 * drives the app (the desktop CLI, `remotea.ts`); on a host outside a
 * terminal it administers the host (`remote-server/src/cli.ts`). Each side
 * hands the other what it does not know:
 *   - the host CLI, inside a terminal, runs these verbs through
 *     `node $REMOTEA_CLI` (and `token`, so an agent gets the bridge token);
 *   - the desktop CLI passes a verb it does not know to the next `remotea` on
 *     PATH, so `remotea doctor` works in a WSL pane.
 * A handed-over call carries REMOTEA_FORWARDED=1 and is never handed on again,
 * so a verb neither side knows ends in an error instead of a loop.
 *
 * No imports: the host compiles this file on its own.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHIM_MARKER = exports.FORWARDED_ENV = exports.DESKTOP_VERBS = void 0;
/** Every verb the desktop CLI has. tests/unit/cli-dispatch.test.ts keeps it equal to COMMAND_SPECS. */
exports.DESKTOP_VERBS = [
    'ping', 'identify', 'capabilities', 'list-windows', 'focus-window', 'new-window', 'open', 'bridge', 'token',
    'remote', 'workspace', 'new-workspace', 'ssh', 'close-workspace', 'select-workspace', 'rename-workspace',
    'list-workspaces', 'current-workspace', 'whoami', 'new-surface', 'close-surface', 'rename-surface',
    'focus-surface', 'list-surfaces', 'set-color-scheme', 'clear-color-scheme', 'list-themes', 'themes',
    'reload-config', 'config', 'locales', 'split', 'pane', 'close-pane', 'focus-pane', 'zoom-pane', 'list-panes',
    'tree', 'layout', 'send', 'send-key', 'read-screen', 'prompts', 'trigger-flash', 'browser', 'agent',
    'markdown', 'notify', 'list-notifications', 'clear-notifications', 'set-status', 'set-progress', 'log',
    'sidebar-state', 'crash-report', 'diff', 'hook', 'opencode-tui', 'agent-activity', 'raw-v1', 'report-agent',
    'report-metadata', 'report-subagent', 'report-session', 'answer-agent', 'release-agent', 'agent-state',
    'detect',
];
/** Set on a call one CLI handed to the other; neither hands it on again. */
exports.FORWARDED_ENV = 'REMOTEA_FORWARDED';
/** A line in the remotea bash shim (src/cli-bin/remotea), so the forwarder never picks one of ours. */
exports.SHIM_MARKER = '# remotea CLI shim.';

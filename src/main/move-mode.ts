/**
 * The Electron half of `--move` (`npm run move`; the steps are rename-move.ts).
 * index.ts calls this instead of starting the app: no window, no pipe server,
 * no agent integration at startup. It refuses while the app is open, because
 * the open app would write settings.json back over the moved keys.
 *
 * `--yes` answers the one question (remove old plugin files nothing proves
 * are remotea's) with yes; otherwise a native dialog asks, defaulting to No.
 */
import * as fs from 'fs';
import * as os from 'os';
import { app, dialog } from 'electron';
import { getAppDataDir } from '../shared/instance';
import { LEGACY_REGISTRY_VERB, legacyPluginPaths } from '../shared/legacy-names';
import { applyConsent, readConsent } from './agent-integration';
import { integrationFailures } from './integration-failures';
import { logDiagnostic } from './crash-diagnostics';
import { formatMoveResult, runDesktopMove, type StepResult } from './rename-move';
import { deleteVerb, installContextMenu, REG_ROOTS, registeredVerbCommand } from './shell-context-menu';

export function isMoveRun(argv: readonly string[]): boolean {
  return argv.includes('--move');
}

/** Rewrites the agent configs through the same consent-gated path app startup uses. */
function agentConfigs(): StepResult[] {
  const step = 'agent configs';
  const consent = readConsent();
  if (consent.decision !== 'granted') {
    return [{ step, status: 'skipped', detail: 'agent integration is off in Settings; nothing of remotea\'s to rewrite' }];
  }
  applyConsent(consent);
  const failures = integrationFailures();
  if (!failures.length) return [{ step, status: 'done', detail: 'old remotea entries replaced with remotea-named ones' }];
  return failures.map((f) => ({ step: `${step} (${f.provider})`, status: 'failed' as const, detail: `${f.operation} failed: ${f.code}` }));
}

export async function runMoveMode(gotInstanceLock: boolean): Promise<void> {
  if (!gotInstanceLock) {
    process.stderr.write('remotea is open. Quit it (from the tray too), then run the move again.\n');
    app.exit(1);
    return;
  }
  const yes = process.argv.includes('--yes');
  await app.whenReady();
  const home = os.homedir();
  const result = await runDesktopMove({
    home,
    appDataDir: getAppDataDir(),
    registry: process.platform === 'win32'
      ? {
          roots: REG_ROOTS,
          oldCommand: (root) => registeredVerbCommand(LEGACY_REGISTRY_VERB, root),
          removeOld: (root) => deleteVerb(LEGACY_REGISTRY_VERB, root),
          installNew: () => installContextMenu(process.execPath),
        }
      : null,
    agentConfigs,
    oldPlugins: () => legacyPluginPaths(home, process.env).filter((p) => fs.existsSync(p)),
    confirmRemovePlugins: (paths) => {
      if (yes) return true;
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Keep them', 'Remove them'],
        defaultId: 0,
        cancelId: 0,
        title: 'remotea move',
        message: 'Remove these old plugin files?',
        detail: `${paths.join('\n')}\n\nThey carry the old name. Nothing in them says whether remotea or a wmux install wrote them, so keep them if you also use wmux.`,
      });
      return choice === 1;
    },
  });
  const text = formatMoveResult(result);
  process.stdout.write(text + '\n');
  logDiagnostic('rename-move', { ok: result.ok, alreadyMoved: result.alreadyMoved, steps: result.steps.map((s) => `${s.step}:${s.status}`).join('|') });
  app.exit(result.ok ? 0 : 1);
}

/**
 * `remotea move`: the host half of the rename move (KTD10). Run once on each
 * host after `remotea upgrade`, so the agents here report through the
 * remotea-named helper and nothing still points at the old one.
 *
 * In order: rewrite this host's old hook entries (only path-proven ones, the
 * same rule `remotea hooks install` applies); list old plugin files nothing
 * proves are ours and remove them only on a yes; remove the old helper files
 * from the helper folder; write the marker. Terminals opened before the
 * upgrade still run with the old variables, so the run ends by saying to
 * reopen them.
 */
import fs from 'fs';
import path from 'path';
import { LEGACY_HOST_HELPER_FILES, legacyPluginPaths } from '../../src/shared/legacy-names';
import { defaultHookPaths, installHooks, legacyHookEntries, type HookPaths } from './hooks-install';

export const HOST_MOVE_MARKER = 'moved-from-wmux.json';
export const REOPEN_LINE = "Reopen host terminals that were open before the move; agents in them won't report status until reopened.";

export type HostStepStatus = 'done' | 'skipped' | 'failed';
export interface HostStep {
  step: string;
  status: HostStepStatus;
  detail: string;
}
export interface HostMoveResult {
  ok: boolean;
  alreadyMoved: boolean;
  steps: HostStep[];
  /** Old helper files were removed, so terminals from before the move need reopening. */
  reopenTerminals: boolean;
}

export interface HostMoveDeps {
  paths?: HookPaths;
  env?: NodeJS.ProcessEnv;
  /** Asked once with the list of unproven old plugin files; false keeps them. */
  confirmRemovePlugins: (paths: string[]) => boolean | Promise<boolean>;
  now?: () => Date;
}

export function hostMoveMarker(p: HookPaths): string {
  return path.join(path.dirname(p.cliDir), HOST_MOVE_MARKER);
}

export async function runHostMove(deps: HostMoveDeps): Promise<HostMoveResult> {
  const p = deps.paths ?? defaultHookPaths();
  const env = deps.env ?? process.env;
  const marker = hostMoveMarker(p);
  const alreadyMoved = fs.existsSync(marker);
  const steps: HostStep[] = [];
  if (alreadyMoved) steps.push({ step: 'move', status: 'skipped', detail: 'already moved; tidying leftovers only' });

  // 1. Hook entries.
  try {
    const old = legacyHookEntries(p);
    if (!old.length) {
      steps.push({ step: 'agent hooks', status: 'skipped', detail: 'no old remotea entries' });
    } else {
      installHooks(p);
      steps.push({ step: 'agent hooks', status: 'done', detail: `replaced old remotea entries: ${old.map((o) => `${o.agent} ${o.entries}`).join(', ')}` });
    }
  } catch (err) {
    steps.push({ step: 'agent hooks', status: 'failed', detail: (err as Error).message });
  }

  // 2. Old plugin files nothing proves are ours.
  const plugins = legacyPluginPaths(p.home, env).filter((f) => fs.existsSync(f));
  if (!plugins.length) {
    steps.push({ step: 'old plugin files', status: 'skipped', detail: 'none found' });
  } else if (!(await deps.confirmRemovePlugins(plugins))) {
    steps.push({ step: 'old plugin files', status: 'skipped', detail: `kept (they may be a wmux install's): ${plugins.join(', ')}` });
  } else {
    try {
      for (const f of plugins) fs.rmSync(f, { recursive: true, force: true });
      steps.push({ step: 'old plugin files', status: 'done', detail: `removed ${plugins.join(', ')}` });
    } catch (err) {
      steps.push({ step: 'old plugin files', status: 'failed', detail: (err as Error).message });
    }
  }

  // 3. Old helper files. Last of the changes: nothing written above points at them.
  let reopenTerminals = false;
  try {
    const removed: string[] = [];
    for (const f of LEGACY_HOST_HELPER_FILES) {
      const file = path.join(p.cliDir, f);
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        removed.push(file);
      }
    }
    reopenTerminals = removed.length > 0;
    steps.push(removed.length
      ? { step: 'old helper files', status: 'done', detail: `removed ${removed.join(', ')}` }
      : { step: 'old helper files', status: 'skipped', detail: `none in ${p.cliDir}` });
  } catch (err) {
    steps.push({ step: 'old helper files', status: 'failed', detail: (err as Error).message });
  }

  // 4. Marker.
  if (!alreadyMoved) {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      const at = (deps.now ?? (() => new Date()))();
      fs.writeFileSync(marker, JSON.stringify({ movedAt: at.toISOString(), steps }, null, 2) + '\n');
      steps.push({ step: 'marker', status: 'done', detail: marker });
    } catch (err) {
      steps.push({ step: 'marker', status: 'failed', detail: (err as Error).message });
      return { ok: false, alreadyMoved, steps, reopenTerminals };
    }
  }
  return { ok: true, alreadyMoved, steps, reopenTerminals };
}

export function formatHostMoveResult(r: HostMoveResult): string {
  const lines = r.steps.map((s) => `${s.status.padEnd(7)} ${s.step}: ${s.detail}`);
  if (r.reopenTerminals) lines.push(REOPEN_LINE);
  return lines.join('\n');
}

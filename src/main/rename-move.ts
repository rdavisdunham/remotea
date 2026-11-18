/**
 * The desktop move (`npm run move`, the app binary with `--move`, KTD10):
 * brings an install that predates the rename over to the remotea names, once,
 * without touching anything a real wmux on the same machine could own (KTD9).
 *
 * Like chromium-profile.ts: copy and verify, one result per step, the marker
 * written last. A failed settings or config copy writes no marker, so a rerun
 * resumes; a rerun after success says so and only tidies leftovers.
 *
 * Pure apart from the deps, which the tests give a temp home and a fake
 * registry.
 */
import * as fs from 'fs';
import * as path from 'path';
import { LEGACY_CONFIG_DIR, LEGACY_REGISTRY_VERB, LEGACY_STORAGE_PREFIX } from '../shared/legacy-names';
import { CONFIG_DIR, MOVE_MARKER_FILE } from './old-state-notice';

export const NEW_STORAGE_PREFIX = 'remotea-';
export const SETTINGS_BACKUP = 'settings.json.pre-move';

export type StepStatus = 'done' | 'skipped' | 'failed';

export interface StepResult {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface MoveResult {
  ok: boolean;
  alreadyMoved: boolean;
  steps: StepResult[];
}

/** The old Explorer right-click verb, by root (shell-context-menu.ts). */
export interface MoveRegistry {
  roots: readonly string[];
  /** The command the old verb runs under `root`, or null when it is not registered. */
  oldCommand: (root: string) => string | null;
  removeOld: (root: string) => void;
  /** Registers the new verb for every root. */
  installNew: () => void;
}

export interface DesktopMoveDeps {
  home: string;
  /** Where settings.json and the marker live. */
  appDataDir: string;
  /** Null off Windows. */
  registry: MoveRegistry | null;
  /** Rewrites the agent configs (old entries out, new in); a result per target. */
  agentConfigs: () => StepResult[];
  /** Existing old plugin files that nothing proves are remotea's. */
  oldPlugins: () => string[];
  /** Asked once with the list; false keeps them. */
  confirmRemovePlugins: (paths: string[]) => boolean | Promise<boolean>;
  /** Defaults to fs.copyFileSync; a test makes it throw. */
  copyFile?: (src: string, dst: string) => void;
  /** Reads a file, or null; for the registry's checkout proof. */
  readFile?: (p: string) => string | null;
  now?: () => Date;
}

const readOrNull = (p: string): string | null => {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
};

/** Settings with every old key renamed; the old value wins over a new one. */
export function renameSettingsKeys(settings: Record<string, unknown>): { next: Record<string, unknown>; renamed: string[] } {
  const next: Record<string, unknown> = {};
  const renamed: string[] = [];
  for (const [k, v] of Object.entries(settings)) if (!k.startsWith(LEGACY_STORAGE_PREFIX)) next[k] = v;
  for (const [k, v] of Object.entries(settings)) {
    if (!k.startsWith(LEGACY_STORAGE_PREFIX)) continue;
    next[NEW_STORAGE_PREFIX + k.slice(LEGACY_STORAGE_PREFIX.length)] = v;
    renamed.push(k);
  }
  return { next, renamed };
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Copies `src` into `dst` (old wins on a clash) and checks every byte arrived. */
function copyTree(src: string, dst: string, copyFile: (a: string, b: string) => void): number {
  const files = filesUnder(src);
  for (const rel of files) {
    const to = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    copyFile(path.join(src, rel), to);
    if (!fs.readFileSync(path.join(src, rel)).equals(fs.readFileSync(to))) throw new Error(`copy of ${rel} does not match`);
  }
  return files.length;
}

/** The executable a registry command runs: its first argument, quoted or bare. */
export function commandExecutable(command: string): string {
  const m = /^\s*(?:"([^"]+)"|(\S+))/.exec(command);
  return m ? (m[1] ?? m[2]) : '';
}

/**
 * Whether a right-click command runs remotea: a `remotea.exe`, or Electron
 * inside a checkout whose package.json says `"name": "remotea"` (a source
 * run). A real wmux's `wmux.exe` never matches.
 */
export function isRemoteaExecutable(exe: string, readFile: (p: string) => string | null): boolean {
  const norm = exe.replace(/\\/g, '/');
  const base = norm.split('/').pop()?.toLowerCase() ?? '';
  if (base === 'remotea.exe') return true;
  const at = norm.toLowerCase().indexOf('/node_modules/electron/');
  if (at <= 0) return false;
  const raw = readFile(`${norm.slice(0, at)}/package.json`);
  if (raw === null) return false;
  try {
    return (JSON.parse(raw) as { name?: unknown }).name === 'remotea';
  } catch {
    return false;
  }
}

function registryStep(reg: MoveRegistry | null, readFile: (p: string) => string | null): StepResult {
  const step = 'right-click entry';
  if (!reg) return { step, status: 'skipped', detail: 'not Windows' };
  const removed: string[] = [];
  const left: string[] = [];
  try {
    for (const root of reg.roots) {
      const cmd = reg.oldCommand(root);
      if (cmd === null) continue;
      const exe = commandExecutable(cmd);
      if (isRemoteaExecutable(exe, readFile)) {
        reg.removeOld(root);
        removed.push(root);
      } else {
        left.push(`${root} (runs ${exe || 'nothing'})`);
      }
    }
    if (removed.length) reg.installNew();
  } catch (err) {
    return { step, status: 'failed', detail: (err as Error).message };
  }
  if (!removed.length && !left.length) return { step, status: 'skipped', detail: `no shell\\${LEGACY_REGISTRY_VERB} entry` };
  const parts = [];
  if (removed.length) parts.push(`moved shell\\${LEGACY_REGISTRY_VERB} to shell\\remotea for ${removed.join(', ')}`);
  if (left.length) parts.push(`left shell\\${LEGACY_REGISTRY_VERB}, not remotea's: ${left.join('; ')}`);
  return { step, status: 'done', detail: parts.join('; ') };
}

async function pluginsStep(deps: DesktopMoveDeps): Promise<StepResult> {
  const step = 'old plugin files';
  const found = deps.oldPlugins();
  if (!found.length) return { step, status: 'skipped', detail: 'none found' };
  if (!(await deps.confirmRemovePlugins(found))) {
    return { step, status: 'skipped', detail: `kept (they may be a wmux install's): ${found.join(', ')}` };
  }
  const failed: string[] = [];
  for (const p of found) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      failed.push(`${p}: ${(err as Error).message}`);
    }
  }
  if (failed.length) return { step, status: 'failed', detail: failed.join('; ') };
  return { step, status: 'done', detail: `removed ${found.join(', ')}` };
}

/** The steps that are safe to run again after a finished move. */
async function tidySteps(deps: DesktopMoveDeps, readFile: (p: string) => string | null): Promise<StepResult[]> {
  return [...deps.agentConfigs(), registryStep(deps.registry, readFile), await pluginsStep(deps)];
}

export async function runDesktopMove(deps: DesktopMoveDeps): Promise<MoveResult> {
  const copyFile = deps.copyFile ?? ((a: string, b: string) => fs.copyFileSync(a, b));
  const readFile = deps.readFile ?? readOrNull;
  const marker = path.join(deps.appDataDir, MOVE_MARKER_FILE);
  const settingsPath = path.join(deps.appDataDir, 'settings.json');

  if (fs.existsSync(marker)) {
    const steps = [{ step: 'move', status: 'skipped' as const, detail: 'already moved; tidying leftovers only' }, ...(await tidySteps(deps, readFile))];
    return { ok: steps.every((s) => s.status !== 'failed'), alreadyMoved: true, steps };
  }

  const steps: StepResult[] = [];
  const stop = (): MoveResult => ({ ok: false, alreadyMoved: false, steps });

  // 1. Back up settings.json once: a rerun must not back up a half-moved file.
  const backup = path.join(deps.appDataDir, SETTINGS_BACKUP);
  let settings: Record<string, unknown> = {};
  try {
    const raw = readOrNull(settingsPath);
    if (raw === null) {
      steps.push({ step: 'settings backup', status: 'skipped', detail: 'no settings.json' });
    } else {
      settings = JSON.parse(raw) as Record<string, unknown>;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json is not an object');
      if (fs.existsSync(backup)) {
        steps.push({ step: 'settings backup', status: 'skipped', detail: `${backup} already there` });
      } else {
        copyFile(settingsPath, backup);
        steps.push({ step: 'settings backup', status: 'done', detail: backup });
      }
    }
  } catch (err) {
    steps.push({ step: 'settings backup', status: 'failed', detail: (err as Error).message });
    return stop();
  }

  // 2. Copy ~/.wmux into ~/.remotea, leaving the old folder (a real wmux reads it too).
  const oldConfig = path.join(deps.home, LEGACY_CONFIG_DIR);
  const newConfig = path.join(deps.home, CONFIG_DIR);
  try {
    if (!fs.existsSync(oldConfig)) {
      steps.push({ step: 'config folder', status: 'skipped', detail: `no ${oldConfig}` });
    } else {
      const n = copyTree(oldConfig, newConfig, copyFile);
      steps.push({ step: 'config folder', status: 'done', detail: `copied ${n} file(s) from ${oldConfig} to ${newConfig}; ${oldConfig} left in place` });
    }
  } catch (err) {
    steps.push({ step: 'config folder', status: 'failed', detail: (err as Error).message });
    return stop();
  }

  // 3. Rename the settings keys.
  try {
    const { next, renamed } = renameSettingsKeys(settings);
    if (!renamed.length) {
      steps.push({ step: 'settings keys', status: 'skipped', detail: 'no old keys' });
    } else {
      const tmp = settingsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
      fs.renameSync(tmp, settingsPath);
      steps.push({ step: 'settings keys', status: 'done', detail: `renamed ${renamed.length}: ${renamed.join(', ')}` });
    }
  } catch (err) {
    steps.push({ step: 'settings keys', status: 'failed', detail: (err as Error).message });
    return stop();
  }

  // 4-6. Agent configs, the right-click entry, unproven plugins. A failure is
  // reported and does not hold back the marker.
  steps.push(...(await tidySteps(deps, readFile)));

  // 7. Marker last.
  const at = (deps.now ?? (() => new Date()))();
  fs.writeFileSync(marker, JSON.stringify({ movedAt: at.toISOString(), steps }, null, 2) + '\n', 'utf-8');
  steps.push({ step: 'marker', status: 'done', detail: marker });
  return { ok: true, alreadyMoved: false, steps };
}

/** One line per step, for the terminal. */
export function formatMoveResult(r: MoveResult): string {
  const lines = r.steps.map((s) => `${s.status.padEnd(7)} ${s.step}: ${s.detail}`);
  if (!r.ok) lines.push('The move stopped before finishing. Fix the failed step and run it again; it picks up where it stopped.');
  else if (!r.alreadyMoved) lines.push('Moved. Start remotea as usual. Project files (.wmux.json, wmux.workspace.json) are yours to rename.');
  return lines.join('\n');
}

/**
 * Whether this machine still holds state under the old names that the move
 * command (`npm run move`, `rename-move.ts`) has not brought over, and the
 * one-line hint for a project folder whose files still carry an old name.
 *
 * Existence checks only: nothing old is read or loaded. The app runs on the
 * new names whether or not the move ran; this only tells the user why their
 * settings look reset. Once the move writes its marker the notice stops for
 * good, even if a real wmux later writes `~/.wmux` again (AE7).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LEGACY_CONFIG_DIR, LEGACY_PROJECT_FILES, LEGACY_STORAGE_PREFIX } from '../shared/legacy-names';

/** Written last by the desktop move, in the app's data folder. */
export const MOVE_MARKER_FILE = 'moved-from-wmux.json';

/** The config folder in the user's home. */
export const CONFIG_DIR = '.remotea';

export interface OldStateProbe {
  /** The parsed `settings.json`. */
  settings: Record<string, unknown>;
  home: string;
  /** Where `settings.json` and the move marker live. */
  appDataDir: string;
  exists: (p: string) => boolean;
}

export function oldStateNeedsMove(p: OldStateProbe): boolean {
  if (p.exists(path.join(p.appDataDir, MOVE_MARKER_FILE))) return false;
  if (Object.keys(p.settings).some((k) => k.startsWith(LEGACY_STORAGE_PREFIX))) return true;
  return p.exists(path.join(p.home, LEGACY_CONFIG_DIR)) && !p.exists(path.join(p.home, CONFIG_DIR));
}

/** The probe for this process: the real settings file, home and data folder. */
export function defaultOldStateProbe(settings: Record<string, unknown>, appDataDir: string): OldStateProbe {
  return { settings, home: os.homedir(), appDataDir, exists: (p) => fs.existsSync(p) };
}

/** New project file name for each old one. */
const PROJECT_RENAMES: Record<(typeof LEGACY_PROJECT_FILES)[number], string> = {
  '.wmux.json': '.remotea.json',
  'wmux.workspace.json': 'remotea.workspace.json',
  '.wmux/workspace.json': '.remotea/workspace.json',
};

/**
 * One line per project file in `dir` that exists only under its old name,
 * telling the user what to rename it to. Empty when there is nothing to say.
 */
export function oldProjectFileHints(dir: string, exists: (p: string) => boolean = fs.existsSync): string[] {
  if (!dir) return [];
  const hints: string[] = [];
  for (const old of LEGACY_PROJECT_FILES) {
    const next = PROJECT_RENAMES[old];
    if (exists(path.join(dir, old)) && !exists(path.join(dir, next))) {
      hints.push(`${old} is an old name that remotea no longer reads; rename it to ${next}`);
    }
  }
  return hints;
}

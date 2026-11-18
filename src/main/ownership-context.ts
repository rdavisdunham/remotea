/**
 * The folders that prove an old hook entry or block is this desktop
 * install's: its `resources/cli` (the hook helper) and its `cli-bin` (what
 * blocks name). A checkout of this repo is recognised by artifact-ownership
 * itself, through its package.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { OwnershipContext } from '../shared/artifact-ownership';
import { getCliBinPath } from './cli-paths';

function resourcesCliDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    if (app?.isPackaged) return path.join(process.resourcesPath, 'cli');
  } catch { /* not under Electron (tests) */ }
  return path.resolve(__dirname, '../../resources/cli');
}

export function desktopOwnershipContext(): OwnershipContext {
  return {
    knownDirs: [resourcesCliDir(), getCliBinPath()],
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

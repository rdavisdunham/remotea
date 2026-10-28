/** The repository a session ran in (collector.py `repo_of`), cached per folder for one scan. */
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { localPath } from './paths';

export type RepoLookup = (cwd: string, origin?: string) => string;

export function repoFromOrigin(origin: string): string {
  const last = origin.replace(/\/+$/, '').split('/').pop()!.split(':').pop()!;
  return last.replace(/\.git$/, '');
}

/** A fresh lookup with its own cache (the Python collector caches per process run). */
export function repoLookup(): RepoLookup {
  const cache = new Map<string, string>();
  return (cwd, origin = '') => {
    if (origin) return repoFromOrigin(origin);
    const p = localPath(cwd);
    if (!p) return '';
    try {
      if (!fs.statSync(p).isDirectory()) return '';
    } catch {
      return '';
    }
    let hit = cache.get(p);
    if (hit === undefined) {
      let top = '';
      try {
        top = execFileSync('git', ['-C', p, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch (err) {
        top = typeof (err as { stdout?: unknown }).stdout === 'string' ? String((err as { stdout: string }).stdout).trim() : '';
      }
      hit = top ? path.basename(top) : '';
      cache.set(p, hit);
    }
    return hit;
  };
}

/**
 * The desktop CLI's half of one `remotea` command (verbs.ts): a verb it does
 * not know goes to the next `remotea` on PATH, which in a WSL pane is the
 * host's admin CLI. This install's own shims are skipped, by folder and by
 * their marker line, so the CLI never hands a verb back to itself.
 *
 * Only on POSIX: a host CLI is a Linux program, and a Windows shell has none.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { FORWARDED_ENV, SHIM_MARKER } from './verbs';

export interface ForwardDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** This install's shim folders. */
  ownDirs: string[];
  isFile: (p: string) => boolean;
  /** The first few hundred bytes of a file, or '' when unreadable. */
  readHead: (p: string) => string;
  /** Runs `file` with `args` and inherited stdio, returning its exit code. */
  run: (file: string, args: string[], env: NodeJS.ProcessEnv) => number;
}

/** The next `remotea` on PATH that is not one of ours, or null. */
export function findNextRemotea(deps: Pick<ForwardDeps, 'env' | 'platform' | 'ownDirs' | 'isFile' | 'readHead'>): string | null {
  if (deps.platform === 'win32') return null;
  const own = new Set(deps.ownDirs.map((d) => path.resolve(d)));
  for (const dir of (deps.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || own.has(path.resolve(dir))) continue;
    const candidate = path.join(dir, 'remotea');
    if (!deps.isFile(candidate)) continue;
    if (deps.readHead(candidate).includes(SHIM_MARKER)) continue;
    return candidate;
  }
  return null;
}

/**
 * Hand `args` to the next `remotea`. Returns its exit code, or null when the
 * call was already handed over once or there is nowhere to send it.
 */
export function forwardUnknownVerb(args: string[], deps: ForwardDeps): number | null {
  if (deps.env[FORWARDED_ENV] === '1') return null;
  const next = findNextRemotea(deps);
  if (!next) return null;
  return deps.run(next, args, { ...deps.env, [FORWARDED_ENV]: '1' });
}

/** What the desktop CLI says about a verb neither program took. */
export function unknownVerbMessage(verb: string): string {
  return `Unknown command: ${verb}\n`
    + 'This is the desktop remotea, which drives the app from inside its terminals. '
    + 'Host commands (status, doctor, upgrade, hooks, …) belong to the host\'s remotea: '
    + 'run them on the host, where `remotea --help` lists them.';
}

/** The real deps, for a CLI file at `cliDir` (resources/cli or dist/cli). */
export function defaultForwardDeps(cliDir: string): ForwardDeps {
  return {
    env: process.env,
    platform: process.platform,
    ownDirs: [path.resolve(cliDir, '../cli-bin'), path.resolve(cliDir, '../../src/cli-bin')],
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    readHead: (p) => {
      try {
        const fd = fs.openSync(p, 'r');
        try {
          const buf = Buffer.alloc(512);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          return buf.subarray(0, n).toString('utf-8');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return '';
      }
    },
    run: (file, args, env) => {
      const r = spawnSync(file, args, { stdio: 'inherit', env });
      return r.status ?? 1;
    },
  };
}

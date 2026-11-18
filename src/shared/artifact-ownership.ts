/**
 * Proving that an old-named artifact (a hook entry, a managed block) is
 * remotea's, by the path it embeds.
 *
 * A real wmux on the same machine writes byte-identical names: its hook
 * commands also run `wmux-hook.js`, its blocks also open with
 * `<!-- wmux:start`. So a name never proves anything. An artifact is
 * remotea's only when a path inside it resolves into a known remotea
 * location:
 *   - a folder the caller names (the host's `~/.local/share/remotea/cli`,
 *     this install's `resources/cli` and `resources/cli-bin`), or
 *   - a checkout of this repo: a `resources/cli`, `resources/cli-bin` or
 *     `src/cli-bin` (what a source run renders into blocks) folder whose
 *     `package.json` two levels up says `"name": "remotea"`.
 *     A wmux checkout says `"name": "wmux"` there and is never proven.
 *
 * Pure apart from the injected `readFile`, so both the desktop and the host
 * use it, and tests run it against any layout.
 */

export interface OwnershipContext {
  /** Folders that belong to this remotea install or host. */
  knownDirs: readonly string[];
  /** Reads a file, or returns null when it is missing or unreadable. */
  readFile: (p: string) => string | null;
}

/** Forward slashes, no trailing slash, case folded for Windows paths. */
function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(s) || s.startsWith('//')) s = s.toLowerCase();
  return s;
}

function dirname(p: string): string {
  const s = norm(p);
  const i = s.lastIndexOf('/');
  return i <= 0 ? s : s.slice(0, i);
}

/** True when `p` is `dir` or inside it, after normalising both. */
function isInside(p: string, dir: string): boolean {
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(b + '/');
}

/** A `resources/cli`, `resources/cli-bin` or `src/cli-bin` folder of a remotea checkout. */
function isRemoteaCheckoutDir(dir: string, readFile: OwnershipContext['readFile']): boolean {
  const d = norm(dir);
  const m = /^(.*)\/(?:resources\/cli(?:-bin)?|src\/cli-bin)$/i.exec(d);
  if (!m) return false;
  const raw = readFile(`${m[1]}/package.json`);
  if (raw === null) return false;
  try {
    return (JSON.parse(raw) as { name?: unknown }).name === 'remotea';
  } catch {
    return false;
  }
}

/**
 * Whether a file path (a hook helper, a CLI entry) lives in a known remotea
 * folder or a remotea checkout's resources.
 */
export function isRemoteaFilePath(filePath: string, ctx: OwnershipContext): boolean {
  if (!filePath) return false;
  if (ctx.knownDirs.some((d) => d && isInside(filePath, d))) return true;
  return isRemoteaCheckoutDir(dirname(filePath), ctx.readFile);
}

/** Whether a folder path (the `cli-bin` a block names) is remotea's. */
export function isRemoteaDirPath(dirPath: string, ctx: OwnershipContext): boolean {
  if (!dirPath) return false;
  if (ctx.knownDirs.some((d) => d && isInside(dirPath, d))) return true;
  return isRemoteaCheckoutDir(dirPath, ctx.readFile);
}

/**
 * The script a hook command runs: the first argument after `node`, quoted or
 * bare. Null when the command has another shape.
 */
export function hookCommandScript(command: string): string | null {
  const m = /^\s*(?:"[^"]*node(?:\.exe)?"|\S*node(?:\.exe)?)\s+(?:"([^"]+)"|(\S+))/i.exec(command);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/** Whether a hook command runs a helper that is provably remotea's. */
export function isRemoteaHookCommand(command: unknown, ctx: OwnershipContext): boolean {
  if (typeof command !== 'string') return false;
  const script = hookCommandScript(command);
  return script !== null && isRemoteaFilePath(script, ctx);
}

/**
 * Absolute paths a managed block names. The block was rendered with the
 * install's `cli-bin` folder in place of a placeholder, so its commands read
 * `"<cli-bin>/wmux" identify`.
 */
export function blockEmbeddedDirs(block: string): string[] {
  const dirs = new Set<string>();
  const re = /"([^"\n]+)[\\/](?:wmux|remotea)(?:\.cmd|\.ps1)?"/g;
  for (let m = re.exec(block); m; m = re.exec(block)) dirs.add(m[1]);
  return [...dirs];
}

/**
 * Whether a managed block is remotea's: it names at least one folder, and
 * every folder it names is remotea's. A block with no path cannot be proven.
 */
export function isRemoteaBlock(block: string, ctx: OwnershipContext): boolean {
  const dirs = blockEmbeddedDirs(block);
  return dirs.length > 0 && dirs.every((d) => isRemoteaDirPath(d, ctx));
}

/** Path spellings, ported from collector.py (windows_path, wsl_folder, environment_of, local_path). */
import fs from 'fs';

/** Codex Desktop stores \\?\ extended paths; keep one ordinary spelling. */
export function windowsPath(value: string | null | undefined): string {
  let p = (value || '').replace(/\\/g, '/');
  if (p.startsWith('//?/UNC/')) p = '//' + p.slice(8);
  else if (p.startsWith('//?/')) p = p.slice(4);
  return p;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Codex Desktop's WSL threads can record /home/davin as C:\home\davin; return the Linux folder. */
export function wslFolder(p: string, isDirFn: (p: string) => boolean = isDir): string | null {
  const m = /^[A-Za-z]:(\/home(?:\/[\s\S]*)?)$/.exec(p);
  return m && isDirFn(m[1]) ? m[1] : null;
}

export function environmentOf(cwd: string | null | undefined, fallback: string): string {
  const p = windowsPath(cwd).toLowerCase();
  if (p.startsWith('//wsl.localhost/') || p.startsWith('//wsl$/')) return 'wsl';
  if (/^[a-z]:\//.test(p)) return 'windows';
  return fallback;
}

/** Where this WSL process can reach a session folder, if anywhere. */
export function localPath(cwd: string | null | undefined): string | null {
  const p = windowsPath(cwd);
  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/[\s\S]*)$/i.exec(p);
  if (unc) return unc[1];
  return p.startsWith('/') ? p : null;
}

/** shlex.quote, exactly (it differs from cli.ts's shellQuote in how it escapes a quote). */
export function shlexQuote(s: string): string {
  if (!s) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

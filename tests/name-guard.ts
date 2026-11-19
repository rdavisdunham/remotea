/**
 * The name guard: no tracked file says the old name (case-insensitive) except
 * where tests/name-guard-allowlist.json says why. Shared by the root suite and
 * the host-server suite, because the Linux CI job runs only the host tests.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const OLD_NAME = /wmux/i;
export const ALLOWLIST_PATH = 'tests/name-guard-allowlist.json';

export interface Allowlist {
  /** Paths or globs whose name and content may say the old name. */
  files: { path: string; reason: string }[];
  /** One line in one file, found by a piece of its text so it survives edits above it. */
  lines: { path: string; contains: string; reason: string }[];
  /** Text ignored anywhere it appears, such as the upstream repository's URL. */
  spans: { text: string; reason: string }[];
  /** A translation key whose line may say the old name, in the files the glob matches. */
  keys: { key: string; paths: string; reason: string }[];
}

export interface Violation {
  path: string;
  /** Absent when the file name itself is the problem. */
  line?: number;
  text: string;
}

export interface GuardResult {
  violations: Violation[];
  /** `lines` entries that no longer match any line, so the allowlist can shrink. */
  unusedLines: Allowlist['lines'];
}

export interface TrackedFile {
  path: string;
  read(): Buffer;
}

/** `*` stays inside one path segment, `**` crosses segments. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Git's own test: a NUL byte in the first 8000 bytes makes a file binary. */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

function withoutSpans(text: string, spans: RegExp[]): string {
  return spans.reduce((t, re) => t.replace(re, ''), text);
}

export function checkFiles(files: Iterable<TrackedFile>, allow: Allowlist): GuardResult {
  const wholeFiles = allow.files.map((f) => globToRegExp(f.path));
  const spans = allow.spans.map((s) => new RegExp(s.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  const keys = allow.keys.map((k) => ({ paths: globToRegExp(k.paths), key: k.key }));
  const usedLines = new Set<number>();
  const violations: Violation[] = [];

  for (const file of files) {
    if (wholeFiles.some((re) => re.test(file.path))) continue;
    if (OLD_NAME.test(withoutSpans(file.path, spans))) {
      violations.push({ path: file.path, text: file.path });
      continue;
    }
    const content = file.read();
    if (isBinary(content)) continue;
    const text = content.toString('utf8');
    if (!OLD_NAME.test(text)) continue;

    const lineEntries = allow.lines
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.path === file.path);
    const fileKeys = keys.filter((k) => k.paths.test(file.path)).map((k) => k.key);

    text.split('\n').forEach((line, i) => {
      if (!OLD_NAME.test(withoutSpans(line, spans))) return;
      if (fileKeys.some((key) => line.trimStart().startsWith(`"${key}"`) || line.trimStart().startsWith(`'${key}'`))) return;
      const allowed = lineEntries.filter(({ entry }) => line.includes(entry.contains));
      if (allowed.length) {
        for (const { index } of allowed) usedLines.add(index);
        return;
      }
      violations.push({ path: file.path, line: i + 1, text: line.trim() });
    });
  }

  return { violations, unusedLines: allow.lines.filter((_, i) => !usedLines.has(i)) };
}

export function repoRoot(from: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: from, encoding: 'utf8' }).trim();
}

export function trackedFiles(root: string): TrackedFile[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split('\0')
    .filter(Boolean)
    // A file deleted in the working tree but not yet staged is still listed.
    .filter((p) => fs.existsSync(path.join(root, p)))
    .map((p) => ({ path: p, read: () => fs.readFileSync(path.join(root, p)) }));
}

export function loadAllowlist(root: string): Allowlist {
  return JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST_PATH), 'utf8')) as Allowlist;
}

export function checkRepo(root: string): GuardResult {
  return checkFiles(trackedFiles(root), loadAllowlist(root));
}

export function formatResult(result: GuardResult): string {
  const lines = result.violations.map((v) =>
    v.line === undefined ? `${v.path}: the file name says wmux` : `${v.path}:${v.line}: ${v.text.slice(0, 160)}`,
  );
  for (const u of result.unusedLines) lines.push(`${ALLOWLIST_PATH}: unused entry for ${u.path} ("${u.contains}")`);
  if (result.violations.length) {
    lines.push(
      '',
      'Say remotea instead. If the old name is right here (upstream credit, a separate wmux install, a name the move',
      `command migrates), add an entry with a reason to ${ALLOWLIST_PATH}.`,
    );
  }
  if (result.unusedLines.length) lines.push('', `Remove unused entries from ${ALLOWLIST_PATH}.`);
  return lines.join('\n');
}

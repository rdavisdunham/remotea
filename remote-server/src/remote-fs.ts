/**
 * The file explorer, code viewer and markdown viewer for a remote pane: the
 * app's own operations (src/main/explorer-fs.ts, code-file.ts,
 * markdown-file.ts, diff-provider.ts — plain Node, no Electron), run here,
 * where the files are.
 *
 * The root is the session's directory as the server sees it (the /proc probe's
 * lastCwd), never a path from the app: like the local explorer, a request can
 * name a path only relative to the pane's folder, and resolveInRoot keeps it
 * inside (no `..`, no absolute path, no symlinked segment). Write-back is gated
 * a second time in the app (only files opened in that window) and here by the
 * mtime the file was read at.
 */
import fs from 'fs';
import { listDir, resolveInRoot } from '../../src/main/explorer-fs';
import { readCodeFile, writeCodeFile } from '../../src/main/code-file';
import { readMarkdownFile } from '../../src/main/markdown-file';
import { getChangedFilesWithBaseline } from '../../src/main/diff-provider';
import type { FsOp } from '../../src/shared/remote-host-protocol';

export interface FsRequest {
  op: FsOp;
  path?: string;
  showHidden?: boolean;
  content?: string;
  expectedMtimeMs?: number;
}

function realRoot(cwd: string): string | null {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return null;
  }
}

export async function runFsOp(cwd: string | undefined, req: FsRequest): Promise<unknown> {
  const root = cwd ? realRoot(cwd) : null;
  if (!root) return { error: 'No working directory reported for this pane', code: 'no_root' };
  const rel = req.path ?? '';
  switch (req.op) {
    case 'root':
      return { root };
    case 'list':
      return listDir(root, rel, { showHidden: !!req.showHidden });
    case 'readCode':
    case 'readMarkdown': {
      const resolved = await resolveInRoot(root, rel, 'file');
      if ('error' in resolved) return resolved;
      return req.op === 'readCode' ? readCodeFile(resolved.abs) : readMarkdownFile(resolved.abs);
    }
    case 'write': {
      const resolved = await resolveInRoot(root, rel, 'file');
      if ('error' in resolved) return resolved;
      return writeCodeFile(resolved.abs, req.content ?? '', req.expectedMtimeMs);
    }
    case 'diffStats':
      try {
        const { files, baseline } = await getChangedFilesWithBaseline(root);
        return { root, files, baseline };
      } catch {
        return { error: 'Failed to read changes', code: 'read_failed' };
      }
  }
}

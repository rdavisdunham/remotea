import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codexThreadFromFds, isCodexCli } from './agent-probe';
import { paneForegroundPid } from './proc';

const run = promisify(execFile);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const probe = new Map<string, boolean>();
export interface CodexPane { pid: number; executable: string; fileKey: string }

// Resolve an interactive pane to its own foreground native provider. A shell can
// regain its PTY at any time. This binding permits only addressed provider I/O.
export function codexPane(root: number, thread: string): CodexPane | null {
  if (!uuid.test(thread)) return null;
  try {
    const pid = paneForegroundPid(root);
    if (!pid || !isCodexCli(pid)) return null;
    const executable = fs.readlinkSync(`/proc/${pid}/exe`);
    const installed = process.env.REMOTEA_GLASSFACE_CODEX_BIN ?? path.join(os.homedir(), '.local/bin/codex');
    const olderRelease = path.relative(path.join(os.homedir(), '.codex/packages/standalone/releases'), executable);
    // A CLI update may move the "current" symlink while an existing pane keeps running.
    if (executable !== fs.realpathSync(installed) && !/^[\d.]+-[\w-]+\/bin\/codex$/.test(olderRelease)) return null;
    const actual = fs.statSync(executable);
    const running = fs.statSync(`/proc/${pid}/exe`);
    if (actual.ino !== running.ino || actual.dev !== running.dev || codexThreadFromFds(pid) !== thread) return null;
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (args.some(a => a === '--remote' || a.startsWith('--remote='))) return null;
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const agentHome = env.find(e => e.startsWith('CODEX_HOME='))?.slice('CODEX_HOME='.length) ||
      path.join(os.homedir(), '.codex');
    if (fs.realpathSync(agentHome) !== fs.realpathSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))) return null;
    return {pid, executable, fileKey: `${actual.dev}:${actual.ino}:${actual.ctimeMs}`};
  } catch { return null; }
}

/** Probe once per installed executable, off the host event loop. The next roster poll picks it up. */
export function supportsQueue(pane: CodexPane): boolean {
  if (!probe.has(pane.fileKey)) {
    probe.set(pane.fileKey, false);
    void run(pane.executable, ['queue', '--help'], {timeout: 3000, maxBuffer: 32 * 1024})
      .then(({stdout}) => { probe.set(pane.fileKey, stdout.includes('--thread <THREAD>') && stdout.includes('--message <TEXT>')); })
      .catch(() => {});
  }
  return probe.get(pane.fileKey) === true;
}

/** Returns only a provider's positive, thread-bound acceptance receipt. Never resume or launch a writer. */
export async function queuePaneMessage(pane: CodexPane, thread: string, message: string): Promise<string | null> {
  if (!supportsQueue(pane) || !uuid.test(thread)) return null;
  const {stdout} = await run(pane.executable, ['queue', '--thread', thread, '--message', message], {
    cwd: os.homedir(), timeout: 8000, maxBuffer: 32 * 1024,
  });
  const ack = /^Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)\.$/i.exec(stdout.trim());
  return ack && uuid.test(ack[1]) && ack[2] === thread ? ack[1] : null;
}

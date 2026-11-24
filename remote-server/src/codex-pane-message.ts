import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codexRootRollout, codexThreadFromFds, isCodexCli } from './agent-probe';
import { paneForegroundPid } from './proc';

const run = promisify(execFile);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const probe = new Map<string, boolean>();
export interface CodexPane { pid: number; executable: string; fileKey: string; resumeFile?: string }

export interface HostCodexResume {
  thread: string;
  revoked?: boolean;
  owner?: { pid: number; startTicks: string; file: string };
}

// Resolve an interactive pane to its own foreground native provider. A shell can
// regain its PTY at any time. This binding permits only addressed provider I/O.
export function codexPane(root: number, thread: string, restored?: HostCodexResume): CodexPane | null {
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
    if (actual.ino !== running.ino || actual.dev !== running.dev) return null;
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (args.some(a => a === '--remote' || a.startsWith('--remote='))) return null;
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const agentHome = env.find(e => e.startsWith('CODEX_HOME='))?.slice('CODEX_HOME='.length) ||
      path.join(os.homedir(), '.codex');
    if (fs.realpathSync(agentHome) !== fs.realpathSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))) return null;
    const open = codexThreadFromFds(pid);
    let resumeFile: string | undefined;
    if (open !== thread) {
      if (restored?.thread === thread && open !== undefined) restored.revoked = true;
      // Contradictory or ambiguous open files take precedence over startup evidence.
      if (open !== undefined || restored?.thread !== thread || restored.revoked || args.length !== 4 ||
          args[1] !== 'resume' || args[2] !== thread || args[3] !== '') return null;
      if (!fs.readdirSync(`/proc/${pid}/fd`).length ||
          fs.realpathSync(agentHome) !== fs.realpathSync(path.join(os.homedir(), '.codex'))) return null;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (!/^\d+$/.test(startTicks)) return null;
      if (!restored.owner) {
        const file = codexRootRollout(thread);
        if (!file) return null;
        restored.owner = {pid, startTicks, file};
      }
      if (restored.owner.pid !== pid || restored.owner.startTicks !== startTicks) {
        restored.revoked = true;
        return null;
      }
      resumeFile = restored.owner.file;
    }
    return {pid, executable, resumeFile, fileKey: `${actual.dev}:${actual.ino}:${actual.ctimeMs}`};
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

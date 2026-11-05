/**
 * `ci.status` (Eridani's "CI as the final verification", jarvis docs/AGENT_CONTROL.md): what GitHub CI says about
 * a run's pull request head, read with the `gh` this host is logged in to. Eridani holds no GitHub credential; it
 * asks the host while a run waits for CI and polls every 2 minutes.
 *
 * Read-only, in the run's worktree (or the target's repository when the worktree is gone), no shell:
 *   1. `gh pr view <branch> --json number,url,headRefOid,state`        → `pr` (null: no pull request)
 *   2. `gh pr checks <branch> --json name,state,bucket,link,workflow,startedAt,completedAt` → `checks`
 *      (exit 1 "a check failed" and 8 "some are pending" still print the JSON; "no checks reported" → [])
 *   3. for each failed check that is a GitHub Actions job (at most MAX_LOGS), when `log_lines` > 0:
 *      `gh run view <run-id> --job <job-id> --log-failed` → its last `log_lines` lines, secrets redacted
 *      (a job can be read as soon as it finished, while the rest of the run still goes: Eridani fails fast)
 *   4. `git rev-parse HEAD` in the worktree → `worktree_head` (Eridani compares it with the PR head)
 *
 * The result is `{pr, checks, failed_logs, worktree_head}`; a missing or logged-out `gh` is a failure with the
 * reason. Branch and ids are validated before they reach an argv, so nothing Eridani sends becomes an option.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { redact } from './collector/redact';
import { branchDir } from './worktrees';
import type { ExecutionTarget } from './eridani-targets';

export const MAX_LOGS = 3;
export const MAX_LOG_LINES = 200;
export const MAX_CHECKS = 50;
const LINE_CHARS = 300;
const GH_TIMEOUT_MS = 30_000;
const BRANCH_OK = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
const JOB_LINK = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d{1,20})\/job\/(\d{1,20})(?:[/?#]|$)/;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The program could not be started (ENOENT). */
  missing?: boolean;
}
export type Exec = (file: string, args: string[], cwd: string) => Promise<ExecResult>;

export interface CiCheck {
  name: string;
  state: string;
  bucket: string;
  link: string;
  workflow: string;
  startedAt?: string;
  completedAt?: string;
}
export interface CiStatusResult {
  pr: { number: number; url: string; head_sha: string; state: string } | null;
  checks: CiCheck[];
  failed_logs: Array<{ name: string; link: string; lines: string[] }>;
  worktree_head: string | null;
}

export class CiStatusError extends Error {}

/** The default runner: execFile, no shell, the server's own environment (gh reads its login from HOME). */
export const execGh: Exec = (file, args, cwd) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(e?.code === 'ENOENT' ? { missing: true } : {}) });
      });
  });

export function branchOk(branch: unknown): branch is string {
  return typeof branch === 'string' && BRANCH_OK.test(branch) && !branch.includes('..');
}

/**
 * Where to ask: the branch's managed worktree under a target's worktreeRoot (`<root>/<branchDir>`), else a
 * live folder the caller knows for the run, else null.
 */
export function ciFolder(targets: ExecutionTarget[], branch: string, runCwd?: string | null): string | null {
  for (const t of targets) {
    const dir = path.join(t.worktreeRoot, branchDir(branch));
    if (fs.existsSync(dir)) return dir;
  }
  return runCwd && fs.existsSync(runCwd) ? runCwd : null;
}

function firstLine(text: string): string {
  return redact(text.trim().split('\n')[0] ?? '').slice(0, 200);
}

function json<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The last `count` lines of a job log, ANSI codes and `gh`'s "<job>\t<step>\t<timestamp> " prefix stripped, redacted. */
export function logTail(text: string, count: number): string[] {
  const lines = text.split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/^[^\t\n]*\t[^\t\n]*\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?/, '').trimEnd())
    .filter((l) => l.trim());
  return lines.slice(-count).map((l) => {
    const r = redact(l);
    return r.length > LINE_CHARS ? `${r.slice(0, LINE_CHARS - 1)}…` : r;
  });
}

export function isFailed(c: Pick<CiCheck, 'bucket' | 'state'>): boolean {
  return c.bucket === 'fail' || (!c.bucket && ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(c.state));
}

export async function ciStatus(o: { cwd: string; branch: string; logLines: number; exec?: Exec; gh?: string }): Promise<CiStatusResult> {
  const exec = o.exec ?? execGh;
  const gh = o.gh ?? 'gh';
  if (!branchOk(o.branch)) throw new CiStatusError('bad branch');

  const view = await exec(gh, ['pr', 'view', o.branch, '--json', 'number,url,headRefOid,state'], o.cwd);
  if (view.missing) throw new CiStatusError('gh is not installed on this host (or not on the service PATH)');
  let pr: CiStatusResult['pr'] = null;
  if (view.code === 0) {
    const p = json<{ number?: number; url?: string; headRefOid?: string; state?: string }>(view.stdout);
    if (!p || typeof p.number !== 'number') throw new CiStatusError('gh pr view: unreadable output');
    pr = { number: p.number, url: String(p.url ?? ''), head_sha: String(p.headRefOid ?? ''), state: String(p.state ?? '') };
  } else if (!/no (?:open )?pull requests? found/i.test(view.stderr)) {
    throw new CiStatusError(`gh pr view: ${firstLine(view.stderr) || `exit ${view.code}`}`);
  }

  let checks: CiCheck[] = [];
  if (pr) {
    const res = await exec(gh, ['pr', 'checks', o.branch, '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'], o.cwd);
    // Exit 1 (a check failed) and 8 (some are pending) still print the JSON: read it whatever the exit code.
    const rows = res.stdout.trim() ? json<Array<Record<string, unknown>>>(res.stdout) : null;
    if (Array.isArray(rows)) {
      checks = rows.slice(0, MAX_CHECKS).filter((r) => typeof r.name === 'string').map((r) => ({
        name: String(r.name).slice(0, 120), state: String(r.state ?? ''), bucket: String(r.bucket ?? ''),
        link: String(r.link ?? '').slice(0, 500), workflow: String(r.workflow ?? '').slice(0, 120),
        ...(typeof r.startedAt === 'string' ? { startedAt: r.startedAt } : {}),
        ...(typeof r.completedAt === 'string' ? { completedAt: r.completedAt } : {}),
      }));
    } else if (res.code === 0 && !res.stdout.trim()) {
      checks = [];
    } else if (!/no checks reported/i.test(res.stderr)) {
      throw new CiStatusError(`gh pr checks: ${firstLine(res.stderr) || (res.code === 0 ? 'unreadable output' : `exit ${res.code}`)}`);
    }
  }

  const failedLogs: CiStatusResult['failed_logs'] = [];
  const count = Math.max(0, Math.min(MAX_LOG_LINES, Math.floor(o.logLines)));
  if (count) {
    for (const c of checks.filter(isFailed)) {
      if (failedLogs.length >= MAX_LOGS) break;
      const m = JOB_LINK.exec(c.link);
      if (!m) continue;
      const log = await exec(gh, ['run', 'view', m[1], '--job', m[2], '--log-failed'], o.cwd);
      // Not available yet (the job is still being archived) or gone: Eridani asks again on its next poll.
      if (log.code !== 0) continue;
      failedLogs.push({ name: c.name, link: c.link, lines: logTail(log.stdout, count) });
    }
  }

  const head = await exec('git', ['rev-parse', 'HEAD'], o.cwd);
  const sha = head.code === 0 ? head.stdout.trim() : '';
  return { pr, checks, failed_logs: failedLogs, worktree_head: /^[0-9a-f]{7,64}$/.test(sha) ? sha : null };
}

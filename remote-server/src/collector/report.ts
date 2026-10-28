/**
 * The SessionInput body and where to resume a session, ported from
 * collector.py (`payload`, `remotea_terminals`, `resume_in_remotea`). The
 * Python collector learns about remotea terminals by running `remotea status
 * --json`; the server reads its own registry instead (`statusFromRegistry`).
 */
import type { SessionReportInput } from '../../../src/shared/eridani-link-protocol';
import type { RegistryData } from '../registry';
import { clip } from './redact';
import { shlexQuote } from './paths';
import type { FoundSession } from './types';

export const LIMITS: Record<string, number> = { title: 500, first_prompt: 4000, last_prompt: 4000, excerpt: 8000, cwd: 1000, repo: 300, branch: 300 };
export const AGENTS: Record<string, string[]> = { claude: ['claude_code', 'claude_desktop'], codex: ['codex_cli'] };
export const RESUME: Record<string, string> = { claude_code: 'claude --resume', claude_desktop: 'claude --resume', codex_cli: 'codex resume' };

/** The slice of `remotea status --json` the collector reads (the same fields in v1 and v2). */
export interface StatusLike {
  version: number;
  server?: { hostname?: string | null } | null;
  sessions?: Array<{
    id?: string | null;
    groupName?: string | null;
    state?: string | null;
    lastActivityAt?: number | null;
    createdAt?: number | null;
    agent?: { provider?: string; sessionId?: string } | null;
  }> | null;
}

export interface LiveTerminal {
  provider: string;
  state: string;
  workspace: string;
  terminal: string;
  host: string;
}

export interface Terminals {
  installed: boolean;
  live: Record<string, LiveTerminal>;
  groups: Record<string, string>;
}

/** The registry as `remotea status --json` would show it (only the fields read here). */
export function statusFromRegistry(reg: Pick<RegistryData, 'groups' | 'sessions'>, hostname: string): StatusLike {
  const names = new Map(Object.values(reg.groups).map((g) => [g.id, g.name]));
  return {
    version: 1,
    server: { hostname },
    sessions: Object.values(reg.sessions)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({
        id: s.id,
        groupName: s.groupId ? names.get(s.groupId) ?? null : null,
        state: s.state,
        lastActivityAt: s.lastActivityAt ?? null,
        createdAt: s.createdAt,
        agent: s.agent ? { provider: s.agent.provider, sessionId: s.agent.sessionId } : null,
      })),
  };
}

/** Agent session id → the remotea terminal running it (live, or lost and waiting for an app to restore it). */
export function remoteaTerminals(status: StatusLike): { live: Record<string, LiveTerminal>; groups: Record<string, string> } {
  const live: Record<string, LiveTerminal> = {};
  const groups: Record<string, string> = {};
  const rank: Record<string, number> = { live: 2, lost: 1 };
  const sessions = [...(status.sessions ?? [])].sort((a, b) => (a.lastActivityAt || a.createdAt || 0) - (b.lastActivityAt || b.createdAt || 0));
  for (const s of sessions) {
    const agent = s.agent || {};
    const sid = agent.sessionId;
    if (!agent.provider || !(agent.provider in AGENTS) || typeof sid !== 'string') continue;
    groups[sid] = clip(s.groupName || '', 200);
    const state = s.state ?? '';
    if (state in rank && rank[state] >= (rank[live[sid]?.state ?? ''] ?? 0)) {
      live[sid] = {
        provider: agent.provider,
        state,
        workspace: groups[sid],
        terminal: clip(s.id || '', 100),
        host: clip(status.server?.hostname || '', 100),
      };
    }
  }
  return { live, groups };
}

/** A running session points at its terminal; a stopped WSL one reopens as a tab in its last workspace. */
export function resumeInRemotea(session: Pick<FoundSession, 'resume' | 'session_id' | 'tool' | 'cwd'>, terminals: Terminals): Record<string, unknown> {
  const resume: Record<string, unknown> = { ...session.resume };
  const sid = session.session_id;
  const tool = session.tool;
  const live = terminals.live[sid];
  if (live && (AGENTS[live.provider] ?? []).includes(tool)) {
    const state = live.state === 'live' ? 'Live' : 'Restoring';
    delete resume.cmd;
    const { provider: _p, ...rest } = live;
    resume.live = rest;
    resume.hint = clip(`${state} in remotea → ${live.workspace || 'Inbox'}`, 200);
  } else if (terminals.installed && tool in RESUME && resume.cmd && session.cwd) {
    const group = terminals.groups[sid] || 'Inbox';
    const cmd = `remotea open --group ${shlexQuote(group)} --cwd ${shlexQuote(session.cwd)} -- ${RESUME[tool]} ${shlexQuote(sid)}`;
    if (Array.from(cmd).length <= 500) resume.cmd = cmd;
  }
  return resume;
}

export function payload(session: FoundSession, machine: string): SessionReportInput {
  const t = session.transcript;
  const body: SessionReportInput = {
    machine: Array.from(machine).slice(0, 100).join(''),
    environment: session.environment,
    cwd: session.cwd,
    repo: session.repo,
    branch: session.branch,
    title: session.title,
    first_prompt: t.firstPrompt,
    last_prompt: t.recent.length ? t.recent[t.recent.length - 1] : '',
    excerpt: t.excerpt(),
    pr_urls: session.pr_urls,
    turn_count: t.turns,
    started_at: session.started_at,
    last_active_at: session.last_active_at,
    resume: session.resume,
  };
  const b = body as unknown as Record<string, unknown>;
  for (const [key, limit] of Object.entries(LIMITS)) b[key] = clip(b[key] as string, limit);
  return body;
}

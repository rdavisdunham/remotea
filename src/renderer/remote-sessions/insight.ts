import type { RemoteRegistryView } from '../../shared/remote-hosts-types';
import type { SessionRecord } from '../../shared/remote-host-protocol';

/**
 * What Tea last wrote about one terminal, as the sidebar readout and the pane
 * brief both show it. A summary written for an earlier conversation in the same
 * terminal is not shown; one that predates the latest exchanges is `stale`.
 */
export interface TerminalInsight {
  summary?: string;
  /** New exchanges have happened since the summary was written. */
  stale: boolean;
  generatedAt?: number;
}

export function terminalInsight(
  host: RemoteRegistryView | undefined,
  session: SessionRecord | undefined,
  fallbackCwd?: string,
): TerminalInsight {
  const insight = !session?.agent || session.tea?.source === `${session.agent.provider}:${session.agent.sessionId}` ? session?.tea : undefined;
  if (host?.tea?.config.summaries === false) return { stale: false };
  const shell = host?.tea?.config.enabled && !session?.agent
    ? `Shell in ${session?.lastCwd || session?.cwd || fallbackCwd || 'its current directory'}`
    : undefined;
  return {
    summary: insight?.summary || shell,
    stale: !!insight && insight.version !== session?.teaSourceVersion,
    generatedAt: insight?.generatedAt,
  };
}

/** "just now", "4 min ago", "3 h ago", then a date. */
export function insightAge(generatedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - generatedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(generatedAt).toLocaleDateString();
}

import type { Translator } from '../i18n/core';
/**
 * remotea: the host attention overview (Astra review A-Q2). One compact row
 * per remote host: its connection, how many Eridani runs on it are waiting
 * on the human (the agent asked a question or wants an approval: registry
 * `agentState` needs_you), how many terminals exited with a non-zero code,
 * and how many changes made here the host has not confirmed. Clicking the
 * row goes to the first tab that needs looking at.
 *
 * Pure, so it can be tested without a window. Reads only what the registry
 * mirror and HostStatus already carry.
 */
import type { SessionRecord } from '../../shared/remote-host-protocol';
import type { HostStatus, RemoteRegistryView } from '../../shared/remote-hosts-types';
import { connectionHealth, type ConnectionHealth, type HealthTone } from './host-health';

export interface AttentionTab {
  id: string;
  title: string;
  kind: 'needs_you' | 'exited';
  /** For needs_you: the agent's own reason, when it gave one. For exited: "exit 2". */
  detail?: string;
  /** This window shows the tab, so a click can go there. */
  here: boolean;
}

export interface HostAttention {
  hostId: string;
  hostName: string;
  connection: ConnectionHealth;
  /** Eridani-bound sessions waiting on the human, longest-waiting first. */
  needsYou: AttentionTab[];
  /** Terminals whose process exited non-zero, most recent first. */
  exitedNonZero: AttentionTab[];
  /** Changes made here not yet confirmed by the host (uncertain included). */
  unconfirmed: number;
  uncertain: number;
  /** The tab a click goes to: the first one above that this window shows. */
  first: string | null;
  /** The row's overall tone: error when a run needs you or the connection is broken. */
  tone: HealthTone;
  /** "2 need you · 1 exited non-zero · 3 unconfirmed", or "" when there is nothing. */
  summary: string;
}

function title(s: SessionRecord): string {
  return s.title || s.agent?.provider || s.cmd || 'shell';
}

/** True when the registry says this Eridani run is waiting on a human. */
export function runNeedsYou(s: SessionRecord): boolean {
  return !!s.eridani && s.state !== 'exited' && s.agentState?.state === 'needs_you';
}

export function exitedNonZero(s: SessionRecord): boolean {
  return s.state === 'exited' && typeof s.exitCode === 'number' && s.exitCode !== 0;
}

/**
 * The overview for every enabled host. `shownHere`: the remote tabs this
 * window shows (click-through only goes to those).
 */
export function hostAttention(
  hosts: Record<string, { id: string; name: string; enabled?: boolean }>,
  status: Record<string, HostStatus | undefined>,
  views: RemoteRegistryView[] | null | undefined,
  shownHere: ReadonlySet<string>,
  now: number,
  t?: Translator,
): HostAttention[] {
  const out: HostAttention[] = [];
  for (const host of Object.values(hosts)) {
    if (host.enabled === false) continue; // switched off in Settings: nothing to attend to
    const st = status[host.id];
    const connection = connectionHealth(st, now, t);
    const view = views?.find((v) => v.hostId === host.id);
    const closed = new Set(view?.closedIds ?? []);
    const visible = (view?.sessions ?? []).filter((s) => !closed.has(s.id) && !(s.hiddenBy as string[]).includes(view!.deviceId));

    const needsYou = visible
      .filter(runNeedsYou)
      .sort((a, b) => (a.agentState?.since ?? 0) - (b.agentState?.since ?? 0) || a.id.localeCompare(b.id))
      .map((s): AttentionTab => ({ id: s.id, title: title(s), kind: 'needs_you', detail: s.agentState?.reason, here: shownHere.has(s.id) }));
    const exited = visible
      .filter(exitedNonZero)
      .sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0) || a.id.localeCompare(b.id))
      .map((s): AttentionTab => ({ id: s.id, title: title(s), kind: 'exited', detail: `exit ${s.exitCode}`, here: shownHere.has(s.id) }));

    const unconfirmed = st?.outbox?.pending ?? 0;
    const uncertain = st?.outbox?.uncertain ?? 0;
    const first = [...needsYou, ...exited].find((t) => t.here)?.id ?? null;

    const parts: string[] = [];
    if (needsYou.length) parts.push(`${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you`);
    if (exited.length) parts.push(`${exited.length} exited non-zero`);
    if (unconfirmed) parts.push(`${unconfirmed} unconfirmed`);

    let tone: HealthTone;
    if (needsYou.length || connection.tone === 'error') tone = 'error';
    else if (exited.length || unconfirmed || connection.tone === 'pending') tone = 'pending';
    else tone = connection.tone;

    out.push({ hostId: host.id, hostName: host.name, connection, needsYou, exitedNonZero: exited, unconfirmed, uncertain, first, tone, summary: parts.join(' · ') });
  }
  return out.sort((a, b) => a.hostName.localeCompare(b.hostName) || a.hostId.localeCompare(b.hostId));
}

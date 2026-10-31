import { makeT, type Translator } from '../i18n/core';
/**
 * remotea: what ending a remote workspace (or tab) would actually stop, per
 * host — computed purely from the registry views, for the close dialog.
 *
 * Ending a workspace closes its server group, and a group close ends every
 * session in it on every device: the ones other devices show, the ones hidden
 * on this device, and Eridani runs (Eridani puts the runs it spawns in a
 * shared group, so one close can stop several agents). The dialog lists that
 * before anything is sent.
 */
import { INBOX_GROUP_ID, type SessionRecord } from '../../shared/remote-host-protocol';
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';
import type { WorkspaceInfo } from '../../shared/types';
import { remoteSurfacesOf, type RemoteCloseRequest } from '../store/remote-close';

export interface EridaniRunRef {
  sessionId: string;
  runId: string;
  taskId: string | null;
  generation: number;
}

export interface RemoteCloseHostSummary {
  hostId: string;
  hostName: string;
  /** A registry view for this host exists at all. False: every count is unknown. */
  known: boolean;
  /** The view is live. False: the counts are from the last time this device was connected. */
  connected: boolean;
  /** The group ended whole ('workspace' scope, never the shared inbox), else null. */
  groupId: string | null;
  groupName: string | null;
  /** Sessions that would end (anything not already exited); null when unknown. */
  active: number | null;
  /** Of those, how many this device has hidden; null when unknown. */
  hiddenHere: number | null;
  /** Of those, how many are tabs in this workspace on this device. */
  shownHere: number;
  /** Eridani runs among them (from the session records' binding); null when unknown. */
  eridani: EridaniRunRef[] | null;
}

export interface SummarizeInput {
  request: RemoteCloseRequest;
  workspace: Pick<WorkspaceInfo, 'splitTree' | 'shell' | 'remoteGroups'>;
  defaultShell?: string;
  views: RemoteRegistryView[] | null;
  hostNames?: Record<string, string>;
}

export function summarizeRemoteClose(input: SummarizeInput): RemoteCloseHostSummary[] {
  const { request, workspace } = input;
  const remote = remoteSurfacesOf(workspace, input.defaultShell);
  const targets = request.scope === 'surfaces' ? new Set(request.surfaceIds) : null;
  const shownByHost = new Map<string, Set<string>>();
  for (const [id, host] of remote) {
    if (targets && !targets.has(id)) continue;
    const set = shownByHost.get(host) ?? new Set<string>();
    set.add(id);
    shownByHost.set(host, set);
  }
  const hosts = new Set<string>(shownByHost.keys());
  if (request.scope === 'workspace') for (const h of Object.keys(workspace.remoteGroups ?? {})) hosts.add(h);

  return [...hosts].sort().map((hostId) => {
    const shown = shownByHost.get(hostId) ?? new Set<string>();
    const bound = request.scope === 'workspace' ? workspace.remoteGroups?.[hostId] ?? null : null;
    const groupId = bound && bound !== INBOX_GROUP_ID ? bound : null;
    const view = input.views?.find((v) => v.hostId === hostId);
    const hostName = input.hostNames?.[hostId] || hostId;
    const groupName = groupId ? view?.groups.find((g) => g.id === groupId)?.name ?? null : null;
    if (!view) {
      return { hostId, hostName, known: false, connected: false, groupId, groupName, active: null, hiddenHere: null, shownHere: shown.size, eridani: null };
    }
    const records = new Map<string, SessionRecord>();
    for (const s of view.sessions) {
      if ((groupId && s.groupId === groupId) || shown.has(s.id)) records.set(s.id, s);
    }
    const ending = [...records.values()].filter((s) => s.state !== 'exited');
    // A tab shown here with no record yet (just created, not echoed) still ends.
    const unrecorded = [...shown].filter((id) => !records.has(id) && !view.closedIds.includes(id)).length;
    const eridani: EridaniRunRef[] = ending
      .filter((s) => s.eridani)
      .map((s) => ({ sessionId: s.id, runId: s.eridani!.runId, taskId: s.eridani!.taskId ?? null, generation: s.eridani!.generation }));
    return {
      hostId,
      hostName,
      known: true,
      connected: view.connected,
      groupId,
      groupName,
      active: ending.length + unrecorded,
      hiddenHere: ending.filter((s) => s.hiddenBy.includes(view.deviceId)).length,
      shownHere: ending.filter((s) => shown.has(s.id)).length + unrecorded,
      eridani,
    };
  });
}

/**
 * True when every remote tab among `surfaceIds` is a session its live
 * registry already reports as exited — closing those stops nothing, so the
 * tab close needs no dialog. Anything unknown answers false.
 */
export function remoteTargetsAllExited(remote: Map<string, string>, surfaceIds: readonly string[], views: RemoteRegistryView[] | null): boolean {
  let any = false;
  for (const id of surfaceIds) {
    const host = remote.get(id);
    if (!host) continue;
    any = true;
    const view = views?.find((v) => v.hostId === host);
    if (!view?.connected) return false;
    const rec = view.sessions.find((s) => s.id === id);
    if (view.closedIds.includes(id)) continue;
    if (!rec || rec.state !== 'exited') return false;
  }
  return any;
}

/** The dialog's per-host lines, as plain text (also what the tests read). */
export function describeHostSummary(h: RemoteCloseHostSummary, t: Translator = makeT('en')): string[] {
  const lines: string[] = [];
  const where = h.groupName ? t('remote.close.summary.hostGroup').replace('{host}', h.hostName).replace('{group}', h.groupName) : t('remote.close.summary.host').replace('{host}', h.hostName);
  lines.push(where);
  if (!h.known) {
    lines.push(t('remote.close.summary.unknown').replace('{count}', String(h.shownHere)));
    lines.push(t('remote.close.summary.hiddenUnknown'));
    lines.push(t('remote.close.summary.runsUnknown'));
    lines.push(t('remote.close.summary.disconnected'));
    return lines;
  }
  lines.push(t('remote.close.summary.active').replace('{count}', String(h.active)));
  lines.push(t('remote.close.summary.hidden').replace('{count}', String(h.hiddenHere)));
  if (h.eridani && h.eridani.length) {
    lines.push(t('remote.close.summary.runs').replace('{count}', String(h.eridani.length)));
    for (const r of h.eridani) lines.push(t('remote.close.summary.run').replace('{task}', r.taskId ?? t('remote.close.summary.noTask')).replace('{run}', r.runId).replace('{generation}', String(r.generation)));
  } else {
    lines.push(t('remote.close.summary.noRuns'));
  }
  if (!h.connected) lines.push(t('remote.close.summary.stale'));
  return lines;
}

export function summaryHeadline(summary: RemoteCloseHostSummary[], scope: RemoteCloseRequest['scope'], t: Translator = makeT('en')): string {
  const known = summary.every((h) => h.known && h.active !== null);
  const total = summary.reduce((n, h) => n + (h.active ?? 0), 0);
  const count = known ? (total === 1 ? t('remote.close.summary.one') : t('remote.close.summary.many')).replace('{count}', String(total)) : t('remote.close.summary.its');
  return scope === 'workspace'
    ? t('remote.close.summary.endGroup').replace('{count}', count)
    : t('remote.close.summary.end').replace('{count}', count);
}

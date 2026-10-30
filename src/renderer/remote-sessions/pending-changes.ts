/**
 * remotea: the pending-changes summary (Astra review A-Q2). Registry changes
 * made on this device (close, hide, rename, move, workspace edits) wait in
 * main's durable outbox until the host acknowledges them; an `uncertain` one
 * was sent and not answered, so it may already be applied. This turns each
 * open outbox entry into a sentence saying what it would do, where it stands,
 * and what forgetting it means, using the registry mirror for names.
 *
 * Pure, so it can be tested without a window.
 */
import { INBOX_GROUP_ID, type SessionRecord } from '../../shared/remote-host-protocol';
import type { HostStatus, OutboxIntent, OutboxOpenItem, RemoteRegistryView } from '../../shared/remote-hosts-types';

export interface PendingChange {
  iid: string;
  hostId: string;
  state: OutboxOpenItem['state'];
  /** What it would do, verb first: `Close "build" on every device`. */
  action: string;
  /** Where it stands: waiting to be sent, sent and waiting, or unanswered. */
  status: string;
  /** What "Forget" does to this one. */
  forgetEffect: string;
  createdAt: number;
}

export interface HostPendingChanges {
  hostId: string;
  hostName: string;
  /** Open changes, oldest first. */
  items: PendingChange[];
  /** Open changes the host build did not itemise (an older main): count only. */
  unlisted: number;
  uncertain: number;
}

function sessionName(s: SessionRecord | undefined, id: string): string {
  return s?.title || s?.agent?.provider || s?.cmd || id;
}

function groupName(view: RemoteRegistryView | undefined, id: string | null | undefined): string {
  if (!id || id === INBOX_GROUP_ID) return 'Inbox';
  return view?.groups.find((g) => g.id === id)?.name ?? id;
}

/** One intent as a sentence, verb first, with the names the registry mirror has for its targets. */
export function describeIntent(intent: OutboxIntent, view: RemoteRegistryView | undefined): string {
  const session = view?.sessions.find((s) => s.id === intent.id);
  const name = `"${sessionName(session, intent.id)}"`;
  switch (intent.t) {
    case 'close':
      return `Close ${name} on every device (ends its process)`;
    case 'hide':
      return `Hide ${name} on this device`;
    case 'unhide':
      return `Show ${name} on this device again`;
    case 'groupClose':
      return `Close workspace "${groupName(view, intent.id)}" and every session in it`;
    case 'groupUpsert': {
      const existing = view?.groups.find((g) => g.id === intent.id);
      if (!existing) return `Create workspace "${intent.name}"`;
      if (existing.name !== intent.name) return `Rename workspace "${existing.name}" to "${intent.name}"`;
      return `Recolour workspace "${intent.name}"`;
    }
    case 'sessionUpdate': {
      const parts: string[] = [];
      if (intent.title !== undefined) parts.push(intent.title ? `rename ${name} to "${intent.title}"` : `clear the name of ${name}`);
      if (intent.groupId !== undefined || intent.group) {
        const target = intent.group?.name ?? groupName(view, intent.groupId);
        parts.push(`${parts.length ? 'move it' : `move ${name}`} to workspace "${target}"`);
      }
      if (!parts.length) return `Update ${name}`;
      const text = parts.join(' and ');
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
}

/** Where an open change stands. */
export function intentStatus(item: Pick<OutboxOpenItem, 'state' | 'attempts'>, connected: boolean): string {
  if (item.state === 'uncertain') return 'Sent, no answer: it may already be applied. Checked against the host before any resend.';
  if (item.attempts === 0) return connected ? 'Sending…' : 'Waiting to be sent: the host is not connected.';
  return connected ? 'Sent, waiting for the host to confirm.' : 'Sent before the connection dropped; resent when the host is back.';
}

/** What "Forget" does to one change. */
export function forgetEffect(intent: OutboxIntent, state: OutboxOpenItem['state']): string {
  const applied = state === 'uncertain'
    ? 'If the host already applied it, it stays applied there.'
    : 'If the host applied it before you forget it, it stays applied there.';
  if (intent.t === 'close' || intent.t === 'hide' || intent.t === 'groupClose') return `Not sent again, and the tab can come back here. ${applied}`;
  return `Not sent again. ${applied}`;
}

/**
 * Every host with changes not yet confirmed, each change described. Hosts
 * with nothing open are left out.
 */
export function pendingChanges(
  hosts: Record<string, { id: string; name: string }>,
  status: Record<string, HostStatus | undefined>,
  views: RemoteRegistryView[] | null | undefined,
): HostPendingChanges[] {
  const out: HostPendingChanges[] = [];
  for (const host of Object.values(hosts)) {
    const st = status[host.id];
    const outbox = st?.outbox;
    if (!outbox?.pending) continue;
    const view = views?.find((v) => v.hostId === host.id);
    const connected = st?.state === 'ready';
    const items = (outbox.open ?? []).map((o): PendingChange => ({
      iid: o.iid,
      hostId: host.id,
      state: o.state,
      action: describeIntent(o.intent, view),
      status: intentStatus(o, connected),
      forgetEffect: forgetEffect(o.intent, o.state),
      createdAt: o.createdAt,
    }));
    out.push({ hostId: host.id, hostName: host.name, items, unlisted: Math.max(0, outbox.pending - items.length), uncertain: outbox.uncertain ?? 0 });
  }
  return out;
}

type ForgetBridge = { forgetOutboxIntent?(hostId: string, iid: string): Promise<boolean> };

/** Forget one change (main drops it from the outbox and pushes a fresh status). */
export async function forgetPendingChange(hostId: string, iid: string): Promise<boolean> {
  const b = (globalThis as { window?: { wmux?: { remoteHosts?: ForgetBridge } } }).window?.wmux?.remoteHosts;
  if (!b?.forgetOutboxIntent) return false;
  try {
    return await b.forgetOutboxIntent(hostId, iid);
  } catch {
    return false;
  }
}

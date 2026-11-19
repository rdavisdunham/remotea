import { makeT, type Translator } from '../i18n/core';
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

function groupName(view: RemoteRegistryView | undefined, id: string | null | undefined, t: Translator): string {
  if (!id || id === INBOX_GROUP_ID) return t('pending.inbox');
  return view?.groups.find((g) => g.id === id)?.name ?? id;
}

/** One intent as a sentence, verb first, with the names the registry mirror has for its targets. */
export function describeIntent(intent: OutboxIntent, view: RemoteRegistryView | undefined, t: Translator = makeT('en')): string {
  const session = view?.sessions.find((s) => s.id === intent.id);
  const name = `"${sessionName(session, intent.id)}"`;
  switch (intent.t) {
    case 'close':
      return t('pending.intent.close').replace('{name}', name);
    case 'hide':
      return t('pending.intent.hide').replace('{name}', name);
    case 'unhide':
      return t('pending.intent.unhide').replace('{name}', name);
    case 'groupClose':
      return t('pending.intent.groupClose').replace('{group}', groupName(view, intent.id, t));
    case 'groupUpsert': {
      const existing = view?.groups.find((g) => g.id === intent.id);
      if (!existing) return t('pending.intent.create').replace('{name}', intent.name);
      if (existing.name !== intent.name) return t('pending.intent.renameGroup').replace('{from}', existing.name).replace('{to}', intent.name);
      return t('pending.intent.color').replace('{name}', intent.name);
    }
    case 'sessionUpdate': {
      const parts: string[] = [];
      if (intent.title !== undefined) parts.push(intent.title ? t('pending.intent.rename').replace('{name}', name).replace('{title}', intent.title) : t('pending.intent.clear').replace('{name}', name));
      if (intent.groupId !== undefined || intent.group) {
        const target = intent.group?.name ?? groupName(view, intent.groupId, t);
        parts.push(t('pending.intent.move').replace('{subject}', parts.length ? t('pending.intent.moveIt') : t('pending.intent.moveName').replace('{name}', name)).replace('{target}', target));
      }
      if (!parts.length) return t('pending.intent.update').replace('{name}', name);
      const text = parts.join(t('pending.intent.and'));
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
}

/** Where an open change stands. */
export function intentStatus(item: Pick<OutboxOpenItem, 'state' | 'attempts'>, connected: boolean, t: Translator = makeT('en')): string {
  if (item.state === 'uncertain') return t('pending.status.uncertain');
  if (item.attempts === 0) return connected ? t('pending.status.sending') : t('pending.status.waiting');
  return connected ? t('pending.status.sent') : t('pending.status.dropped');
}

/** What "Forget" does to one change. */
export function forgetEffect(intent: OutboxIntent, state: OutboxOpenItem['state'], t: Translator = makeT('en')): string {
  const applied = state === 'uncertain'
    ? t('pending.forget.alreadyApplied')
    : t('pending.forget.applied');
  if (intent.t === 'close' || intent.t === 'hide' || intent.t === 'groupClose') return t('pending.forget.tab').replace('{applied}', applied);
  return t('pending.forget.other').replace('{applied}', applied);
}

/**
 * Every host with changes not yet confirmed, each change described. Hosts
 * with nothing open are left out.
 */
export function pendingChanges(
  hosts: Record<string, { id: string; name: string }>,
  status: Record<string, HostStatus | undefined>,
  views: RemoteRegistryView[] | null | undefined,
  t: Translator = makeT('en'),
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
      action: describeIntent(o.intent, view, t),
      status: intentStatus(o, connected, t),
      forgetEffect: forgetEffect(o.intent, o.state, t),
      createdAt: o.createdAt,
    }));
    out.push({ hostId: host.id, hostName: host.name, items, unlisted: Math.max(0, outbox.pending - items.length), uncertain: outbox.uncertain ?? 0 });
  }
  return out;
}

type ForgetBridge = { forgetOutboxIntent?(hostId: string, iid: string): Promise<boolean> };

/** Forget one change (main drops it from the outbox and pushes a fresh status). */
export async function forgetPendingChange(hostId: string, iid: string): Promise<boolean> {
  const b = (globalThis as { window?: { remotea?: { remoteHosts?: ForgetBridge } } }).window?.remotea?.remoteHosts;
  if (!b?.forgetOutboxIntent) return false;
  try {
    return await b.forgetOutboxIntent(hostId, iid);
  } catch {
    return false;
  }
}

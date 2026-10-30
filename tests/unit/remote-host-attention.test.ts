// @vitest-environment jsdom
/**
 * Astra review A-Q2: the pending-changes summary (each unconfirmed change
 * with what it would do and a Forget action) and the host attention overview
 * (per host: runs that need the human, terminals that exited non-zero, the
 * connection, unconfirmed changes; click-through to the first such tab).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { describeIntent, forgetEffect, intentStatus, pendingChanges } from '../../src/renderer/remote-sessions/pending-changes';
import { hostAttention } from '../../src/renderer/remote-sessions/host-attention';
import RemotePendingChanges from '../../src/renderer/components/Settings/RemotePendingChanges';
import { HostAttentionRow } from '../../src/renderer/components/Sidebar/HostAttentionBar';
import { INBOX_GROUP_ID, type EridaniBinding, type SessionRecord } from '../../src/shared/remote-host-protocol';
import type { HostStatus, OutboxOpenItem, RemoteRegistryView } from '../../src/shared/remote-hosts-types';

const ME = 'dev-me000000';
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

function session(id: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: id as SessionRecord['id'], groupId: INBOX_GROUP_ID, cwd: '/home/u', createdBy: 'dev-other0000' as SessionRecord['createdBy'],
    createdAt: 1, bootId: 'boot-1', state: 'live', hiddenBy: [], ...patch,
  };
}

function binding(patch: Partial<EridaniBinding> = {}): EridaniBinding {
  return {
    runId: 'run-0123456789', generation: 1, attempt: 1, taskId: 'task-1', target: 'jarvis', harness: 'claude', model: 'm',
    worktree: '/w/jarvis/b', branch: 'eri/b', base: 'main', baseSha: null, spawnOp: 'op-1', ...patch,
  };
}

function view(sessions: SessionRecord[], patch: Partial<RemoteRegistryView> = {}): RemoteRegistryView {
  return {
    hostId: 'desk', deviceId: ME, connected: true, bootId: 'boot-1',
    groups: [{ id: 'grp-work', name: 'Work', createdBy: 'dev-other0000', createdAt: 1, updatedAt: 1 } as RemoteRegistryView['groups'][number]],
    sessions, closedIds: [], lost: {}, ...patch,
  };
}

const HOSTS = { desk: { id: 'desk', name: 'Desktop', enabled: true } };

function open(intent: OutboxOpenItem['intent'], patch: Partial<OutboxOpenItem> = {}): OutboxOpenItem {
  return { iid: `int-${intent.t}-${intent.id}`, state: 'pending', intent, createdAt: NOW - 1000, attempts: 1, ...patch };
}

describe('pending changes: what each would do', () => {
  const v = view([session('surf-a', { title: 'build' }), session('surf-b')]);

  it('describes every intent kind verb first, with registry names', () => {
    expect(describeIntent({ t: 'close', id: 'surf-a' }, v)).toBe('Close "build" on every device (ends its process)');
    expect(describeIntent({ t: 'hide', id: 'surf-a' }, v)).toBe('Hide "build" on this device');
    expect(describeIntent({ t: 'unhide', id: 'surf-a' }, v)).toBe('Show "build" on this device again');
    expect(describeIntent({ t: 'groupClose', id: 'grp-work' }, v)).toBe('Close workspace "Work" and every session in it');
    expect(describeIntent({ t: 'groupUpsert', id: 'grp-work', name: 'Work 2' }, v)).toBe('Rename workspace "Work" to "Work 2"');
    expect(describeIntent({ t: 'groupUpsert', id: 'grp-work', name: 'Work', color: 'red' }, v)).toBe('Recolour workspace "Work"');
    expect(describeIntent({ t: 'groupUpsert', id: 'grp-new', name: 'Fresh' }, v)).toBe('Create workspace "Fresh"');
    expect(describeIntent({ t: 'sessionUpdate', id: 'surf-a', title: 'deploy' }, v)).toBe('Rename "build" to "deploy"');
    expect(describeIntent({ t: 'sessionUpdate', id: 'surf-a', title: 'deploy', groupId: 'grp-work' }, v)).toBe('Rename "build" to "deploy" and move it to workspace "Work"');
    expect(describeIntent({ t: 'sessionUpdate', id: 'surf-a', groupId: null }, v)).toBe('Move "build" to workspace "Inbox"');
    // A session the mirror does not know (yet): its id, not a blank.
    expect(describeIntent({ t: 'hide', id: 'surf-zz' }, v)).toBe('Hide "surf-zz" on this device');
  });

  it('says where each stands, and what forgetting it means', () => {
    expect(intentStatus({ state: 'uncertain', attempts: 1 }, true)).toMatch(/may already be applied/);
    expect(intentStatus({ state: 'pending', attempts: 0 }, false)).toMatch(/not connected/);
    expect(intentStatus({ state: 'pending', attempts: 2 }, true)).toMatch(/waiting for the host/);
    expect(forgetEffect({ t: 'close', id: 'surf-a' }, 'pending')).toMatch(/tab can come back/);
    expect(forgetEffect({ t: 'groupUpsert', id: 'grp-work', name: 'x' }, 'uncertain')).toMatch(/already applied it, it stays applied/);
  });

  it('lists only hosts with something open; an older main that does not itemise still shows the count', () => {
    const status: Record<string, HostStatus> = {
      desk: { hostId: 'desk', state: 'ready', attempt: 0, outbox: { pending: 2, uncertain: 1, failed: [], open: [open({ t: 'close', id: 'surf-a' }), open({ t: 'hide', id: 'surf-b' }, { state: 'uncertain' })] } },
      lap: { hostId: 'lap', state: 'ready', attempt: 0, outbox: { pending: 3, failed: [] } },
      quiet: { hostId: 'quiet', state: 'ready', attempt: 0, outbox: { pending: 0, failed: [] } },
    };
    const hosts = { ...HOSTS, lap: { id: 'lap', name: 'Laptop' }, quiet: { id: 'quiet', name: 'Quiet' } };
    const rows = pendingChanges(hosts, status, [v]);
    expect(rows.map((r) => r.hostId)).toEqual(['desk', 'lap']);
    expect(rows[0].items.map((i) => [i.state, i.action])).toEqual([
      ['pending', 'Close "build" on every device (ends its process)'],
      ['uncertain', 'Hide "surf-b" on this device'],
    ]);
    expect(rows[1]).toMatchObject({ items: [], unlisted: 3 });

    const html = renderToStaticMarkup(createElement(RemotePendingChanges, { host: rows[0], onForget: () => {} }));
    expect(html).toContain('2 changes made here not yet confirmed by Desktop (1 unanswered)');
    expect(html).toContain('Close &quot;build&quot; on every device');
    expect(html.match(/>Forget</g)).toHaveLength(2);
    expect(html).toContain('data-state="uncertain"');
  });
});

describe('host attention overview', () => {
  const READY: HostStatus = { hostId: 'desk', state: 'ready', attempt: 0, connectedAt: NOW - 60_000 };

  it('counts runs that need you, non-zero exits and unconfirmed changes; clicks go to the longest-waiting tab shown here', () => {
    const v = view([
      session('surf-wait-new', { title: 'task B', eridani: binding(), agentState: { state: 'needs_you', since: 300, reason: 'approval: Bash' } }),
      session('surf-wait-old', { title: 'task A', eridani: binding(), agentState: { state: 'needs_you', since: 100 } }),
      // Not Eridani-bound: the agent roster covers it, not the host row.
      session('surf-manual', { agentState: { state: 'needs_you', since: 50 } }),
      session('surf-crash', { state: 'exited', exitCode: 2, exitedAt: 10 }),
      session('surf-ok', { state: 'exited', exitCode: 0, exitedAt: 20 }),
      session('surf-hidden', { state: 'exited', exitCode: 1, hiddenBy: [ME as SessionRecord['hiddenBy'][number]] }),
      session('surf-closed', { eridani: binding(), agentState: { state: 'needs_you', since: 1 } }),
    ], { closedIds: ['surf-closed'] });
    const status = { desk: { ...READY, outbox: { pending: 2, uncertain: 1, failed: [] } } };
    const [row] = hostAttention(HOSTS, status, [v], new Set(['surf-wait-new', 'surf-crash']), NOW);
    expect(row.needsYou.map((t) => t.id)).toEqual(['surf-wait-old', 'surf-wait-new']);
    expect(row.exitedNonZero.map((t) => t.id)).toEqual(['surf-crash']);
    expect(row.unconfirmed).toBe(2);
    // surf-wait-old is not in this window: the click goes to the next one that is.
    expect(row.first).toBe('surf-wait-new');
    expect(row.tone).toBe('error');
    expect(row.summary).toBe('2 need you · 1 exited non-zero · 2 unconfirmed');
  });

  it('a quiet connected host is one calm row; a broken connection is an error; disabled hosts are left out', () => {
    const quiet = hostAttention(HOSTS, { desk: READY }, [view([session('surf-a')])], new Set(), NOW)[0];
    expect(quiet).toMatchObject({ tone: 'ok', summary: '', first: null });
    const broken = hostAttention(HOSTS, { desk: { hostId: 'desk', state: 'auth-failed', attempt: 3 } }, [], new Set(), NOW)[0];
    expect(broken.tone).toBe('error');
    expect(broken.connection.label).toBe('Token rejected');
    expect(hostAttention({ desk: { ...HOSTS.desk, enabled: false } }, { desk: READY }, [], new Set(), NOW)).toEqual([]);
  });

  it('renders a compact row: counts, the connection when not ready, and an unconfirmed chip', () => {
    const v = view([session('surf-w', { title: 'task A', eridani: binding(), agentState: { state: 'needs_you', since: 1, reason: 'question' } })]);
    const [row] = hostAttention(HOSTS, { desk: { hostId: 'desk', state: 'reconnecting', attempt: 1, outbox: { pending: 1, failed: [] } } }, [v], new Set(['surf-w']), NOW);
    const html = renderToStaticMarkup(createElement(HostAttentionRow, { row, onFocus: () => {}, onOpenHosts: () => {} }));
    expect(html).toContain('Desktop');
    expect(html).toContain('Reconnecting…');
    expect(html).toContain('1 needs you');
    expect(html).toContain('1 unconfirmed');
    expect(html).toContain('title="Go to task A (needs you: question)"');
    expect(html).not.toContain('disabled');
  });
});

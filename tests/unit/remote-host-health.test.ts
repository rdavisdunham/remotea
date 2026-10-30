// @vitest-environment jsdom
/**
 * Astra review A-S2: the host status UI keeps the host connection, each
 * tab's terminal process and the Eridani run apart. A connected host with an
 * exited terminal, or a live terminal whose run needs the user, must never
 * read as one green "Connected".
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RemoteHostHealth from '../../src/renderer/components/Settings/RemoteHostHealth';
import { connectionHealth, processHealth, runHealth, tabsHealth } from '../../src/renderer/remote-sessions/host-health';
import { INBOX_GROUP_ID, type EridaniBinding, type SessionRecord } from '../../src/shared/remote-host-protocol';
import type { HostStatus, RemoteRegistryView } from '../../src/shared/remote-hosts-types';

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
    runId: 'run-0123456789', generation: 3, attempt: 1, taskId: null, target: 'wsl', harness: 'claude', model: 'm',
    worktree: '/w', branch: 'b', base: 'main', baseSha: null, spawnOp: 'op-1', ...patch,
  };
}

function view(sessions: SessionRecord[], patch: Partial<RemoteRegistryView> = {}): RemoteRegistryView {
  return { hostId: 'desk', deviceId: ME, connected: true, bootId: 'boot-1', groups: [], sessions, closedIds: [], lost: {}, ...patch };
}

const READY: HostStatus = { hostId: 'desk', state: 'ready', attempt: 0, connectedAt: NOW - 3_600_000, lastSeenAt: NOW - 1000 };

describe('host connection', () => {
  it('connected: says since when, nothing about terminals', () => {
    const c = connectionHealth(READY, NOW);
    expect(c).toMatchObject({ state: 'ready', label: 'Connected', tone: 'ok' });
    expect(c.detail).toMatch(/^since \d\d:\d\d$/);
  });

  it('dropped: says when the host was last heard from', () => {
    const c = connectionHealth({ hostId: 'desk', state: 'reconnecting', attempt: 2, lastSeenAt: NOW - 5 * 60_000 }, NOW);
    expect(c).toMatchObject({ label: 'Reconnecting…', tone: 'pending', detail: 'last seen 5 min ago' });
    expect(connectionHealth({ hostId: 'desk', state: 'auth-failed', attempt: 1 }, NOW).detail).toBe('never connected');
  });
});

describe('terminal process per tab', () => {
  it('live, exited, and restoring (server respawn, or re-open not confirmed yet)', () => {
    const v = view([], { restoring: ['surf-r'] });
    expect(processHealth(session('surf-l'), v)).toMatchObject({ state: 'live', label: 'Live', stale: false });
    expect(processHealth(session('surf-x', { state: 'exited', exitCode: 2 }), v)).toMatchObject({ state: 'exited', label: 'Exited (2)' });
    expect(processHealth(session('surf-lost', { state: 'lost' }), v).state).toBe('restoring');
    expect(processHealth(session('surf-r'), v)).toMatchObject({ state: 'restoring', label: 'Restoring…' });
  });

  it('host disconnected: the last known state, marked so, never a live green', () => {
    const p = processHealth(session('surf-l'), view([], { connected: false, restoring: ['surf-l'] }));
    expect(p).toMatchObject({ state: 'live', stale: true, label: 'Live (last known)', tone: 'neutral' });
  });
});

describe('Eridani run state', () => {
  it('none without a binding', () => {
    expect(runHealth(session('surf-a'))).toBeNull();
  });

  it('from the registry: agentState, stop requests, exit, verify', () => {
    const working = session('surf-a', { eridani: binding(), agentState: { state: 'working', since: 1 } });
    expect(runHealth(working)).toMatchObject({ runId: 'run-0123456789', generation: 3, state: 'working', label: 'Working' });
    expect(runHealth({ ...working, agentState: { state: 'needs_you', since: 1 } })).toMatchObject({ state: 'needs_you', tone: 'error' });
    expect(runHealth({ ...working, agentState: { state: 'idle', since: 1 } })?.state).toBe('idle');
    expect(runHealth({ ...working, eridani: binding({ stopRequested: { at: 1, mode: 'interrupt', op: null } }) })?.state).toBe('stopping');
    expect(runHealth({ ...working, state: 'exited' })?.state).toBe('ended');
    expect(runHealth({ ...working, agentState: undefined })?.state).toBe('unknown');
    const verified = {
      ...working,
      verify: { attemptId: 'a', state: 'timed_out' as const, startedAt: 1, runId: 'run-0123456789', generation: 3, turnSeq: 1, planRevision: 1, verifyId: 'v', initiator: 'eridani' as const },
    };
    expect(runHealth(verified)?.verify).toBe('verify timed out');
  });
});

describe('tabsHealth', () => {
  it('lists the tabs this device shows: not hidden here, not closed', () => {
    const tabs = tabsHealth(view([
      session('surf-b', { title: 'beta' }),
      session('surf-a', { title: 'alpha' }),
      session('surf-h', { title: 'hidden', hiddenBy: [ME as SessionRecord['createdBy']] }),
      session('surf-c', { title: 'closed' }),
    ], { closedIds: ['surf-c'] }));
    expect(tabs.map((t) => t.title)).toEqual(['alpha', 'beta']);
  });
});

describe('RemoteHostHealth (render)', () => {
  function render(status: HostStatus | undefined, v: RemoteRegistryView | undefined): HTMLElement {
    const html = renderToStaticMarkup(createElement(RemoteHostHealth, { status, view: v, now: NOW }));
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }
  const chips = (el: HTMLElement, kind: string) => [...el.querySelectorAll(`[data-kind="${kind}"]`)];

  it('a connected host, an exited terminal and a run that needs you each get their own label', () => {
    const el = render(READY, view([
      session('surf-x', { title: 'build', state: 'exited', exitCode: 1 }),
      session('surf-r', { title: 'agent', eridani: binding(), agentState: { state: 'needs_you', since: 1 } }),
    ]));
    const [conn] = chips(el, 'connection');
    expect(conn.textContent).toBe('Connected');
    expect(conn.className).toContain('remote-host-chip--ok');
    const rows = [...el.querySelectorAll('tr[data-surface]')];
    const byId = (id: string) => rows.find((r) => r.getAttribute('data-surface') === id)!;
    const exitedProc = byId('surf-x').querySelector('[data-kind="process"]')!;
    expect(exitedProc.textContent).toBe('Exited (1)');
    expect(exitedProc.className).not.toContain('--ok');
    expect(byId('surf-x').textContent).toContain('none');
    expect(byId('surf-r').querySelector('[data-kind="process"]')!.textContent).toBe('Live');
    const run = byId('surf-r').querySelector('[data-kind="run"]')!;
    expect(run.textContent).toBe('Needs you');
    expect(run.className).toContain('remote-host-chip--error');
    expect(byId('surf-r').textContent).toContain('run run-0123 · gen 3');
    // Three separate kinds of label, never one badge.
    expect(el.textContent).toContain('Host connection');
    expect(el.textContent).toContain('Terminal process');
    expect(el.textContent).toContain('Eridani run');
  });

  it('a dropped host keeps its tabs as last known, and shows when it was last seen', () => {
    const el = render(
      { hostId: 'desk', state: 'reconnecting', attempt: 1, lastSeenAt: NOW - 42_000 },
      view([session('surf-a', { title: 'shell' })], { connected: false }),
    );
    expect(chips(el, 'connection')[0].textContent).toBe('Reconnecting…');
    expect(el.textContent).toContain('last seen 42 s ago');
    const proc = chips(el, 'process')[0];
    expect(proc.textContent).toBe('Live (last known)');
    expect(proc.className).toContain('remote-host-chip--neutral');
    // No run column when no tab carries a run.
    expect(el.textContent).not.toContain('Eridani run');
  });

  it('no tabs: just the connection', () => {
    const el = render(READY, view([]));
    expect(el.querySelector('table')).toBeNull();
    expect(chips(el, 'connection')).toHaveLength(1);
  });
});

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatStatus from '../../src/renderer/components/Terminal/ChatStatus';
import ChatReminderDialog from '../../src/renderer/components/Terminal/ChatReminderDialog';
import { useStore } from '../../src/renderer/store';
import { setLatestRemoteViews } from '../../src/renderer/remote-sessions/registry-cache';
import { actOnChat, useLocalChatAttention } from '../../src/renderer/remote-sessions/chat-attention';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const id = 'surf-status-test';
let root: Root, container: HTMLDivElement;
const chatAttention = vi.fn();
const read = () => container.querySelector('.chat-status__label')!.textContent;
const click = async (text: string, where: ParentNode = document) => {
  const button = [...where.querySelectorAll('button')].find(b => b.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
};
function view(patch: Partial<SessionRecord> = {}, connected = true): RemoteRegistryView[] {
  return [{ hostId: 'desk', deviceId: 'device-a', connected, bootId: 'b', groups: [], closedIds: [], lost: {}, sessions: [{ id, groupId: null, cwd: '/tmp', createdBy: 'device-a', createdAt: 1, bootId: 'b', state: 'live', hiddenBy: [], agentState: { state: 'working', since: 1 }, ...patch }] }];
}
const finish = (revision = 1) => ({ agentState: { state: 'idle', since: Date.now() }, chatAttention: { revision, at: Date.now(), kind: 'finished', seenBy: {} } } as const);
const render = async (active = true) => act(async () => root.render(createElement(ChatStatus, { surfaceId: id, active })));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  chatAttention.mockReset().mockResolvedValue({ ok: true });
  window.wmux = { remoteSessions: { chatAttention } } as unknown as typeof window.wmux;
  useStore.setState({ agentStates: {}, agentDetections: {} });
  useLocalChatAttention.setState({ entries: {} });
  setLatestRemoteViews(view());
  container = document.createElement('div'); container.className = 'terminal-pane'; document.body.append(container);
  const target = document.createElement('textarea'); target.className = 'xterm-helper-textarea'; container.append(target);
  const mount = document.createElement('div'); container.append(mount); root = createRoot(mount);
});
afterEach(() => { act(() => root.unmount()); container.remove(); setLatestRemoteViews(null); vi.useRealTimers(); });

describe('chat status and reminders', () => {
  it('shows green completion, then orange unread, without auto-reading a reply in the focused pane', async () => {
    await render(); expect(read()).toBe('Working on it…');
    await act(async () => setLatestRemoteViews(view(finish())));
    expect(container.querySelector('.chat-status')?.getAttribute('data-tone')).toBe('ready');
    expect(chatAttention).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(4001));
    expect(read()).toBe('Unread · check this chat');
    expect(container.querySelector('.chat-status')?.getAttribute('data-tone')).toBe('attention');
    await act(async () => container.querySelector('textarea')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(chatAttention).toHaveBeenCalledExactlyOnceWith('desk', id, { action: 'read', revision: 1 });
    // The UI waits for registry confirmation, not just an RPC response.
    expect(read()).toBe('Unread · check this chat');
    await act(async () => setLatestRemoteViews(view({ ...finish(), chatAttention: { ...finish().chatAttention, seenBy: { 'device-a': 1 } } })));
    expect(read()).toBe('Finished');
  });

  it('does not clear hidden sibling chats and acknowledges on actual focus transition', async () => {
    await render(false);
    await act(async () => setLatestRemoteViews(view(finish())));
    expect(chatAttention).not.toHaveBeenCalled();
    await render(true);
    expect(chatAttention).toHaveBeenCalledWith('desk', id, { action: 'read', revision: 1 });
  });

  it('marks unread without typing or clearing a needs-you state', async () => {
    await act(async () => setLatestRemoteViews(view({ agentState: { state: 'needs_you', since: 1 }, chatAttention: { revision: 1, at: 1, kind: 'needs_you', seenBy: { 'device-a': 1 } } })));
    await render(); expect(read()).toBe('Needs you');
    await click('Mark unread');
    expect(chatAttention).toHaveBeenCalledExactlyOnceWith('desk', id, { action: 'unread' });
    expect(read()).toBe('Needs you');
  });

  it('keeps a current native screen question visible when the server reports an ended turn', async () => {
    setLatestRemoteViews(view(finish()));
    useStore.setState({ agentStates: { [id]: { surfaceId: id as never, state: 'idle', idleSince: 1 } }, agentDetections: { [id]: { agent: 'codex', state: 'question', observedAt: Date.now(), sessionId: null } } as never });
    await render();
    expect(read()).toBe('Needs you');
    // Managed chats use the provider's structured server status instead.
    await act(async () => setLatestRemoteViews(view({ ...finish(), eridani: { execution: 'managed' } as never })));
    expect(read()).not.toBe('Needs you');
  });

  it('keeps local unread state independent of remote sessions', async () => {
    setLatestRemoteViews(null); await render();
    await click('Mark unread');
    expect(read()).toBe('Unread · check this chat');
    expect(chatAttention).not.toHaveBeenCalled();
    await click('Mark read'); expect(useLocalChatAttention.getState().entries[id].seenBy.local).toBe(1);
  });

  it('saves a server reminder with notes and displays failures without closing the form', async () => {
    await render(); await click('Remind me…');
    const note = document.querySelector<HTMLTextAreaElement>('.chat-reminder-dialog textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Review the plan');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    chatAttention.mockResolvedValueOnce({ ok: false, error: 'Disk unavailable' });
    await click('In 30 minutes');
    expect(chatAttention).toHaveBeenLastCalledWith('desk', id, { action: 'remind', dueAt: Date.now() + 1800000, note: 'Review the plan' });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Disk unavailable');
    await click('Save reminder'); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('removes reminders, shows uncertainty and refuses disconnected changes', async () => {
    setLatestRemoteViews(view({ chatReminder: { dueAt: Date.now() + 60000, createdBy: 'device-a' } }));
    await render(); await click('Edit reminder'); await click('Remove reminder');
    expect(chatAttention).toHaveBeenLastCalledWith('desk', id, { action: 'cancelReminder' });
    chatAttention.mockResolvedValueOnce({ ok: false, uncertain: true });
    await click('Mark unread'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('not confirmed');
    setLatestRemoteViews(view({}, false));
    const result = await actOnChat(id, { action: 'unread' }); expect(result.error).toContain('Reconnect');
  });

  it('contains keyboard focus in the reminder dialog and restores it on close', async () => {
    const trigger = document.createElement('button'); container.append(trigger); trigger.focus();
    await act(async () => root.render(createElement(ChatReminderDialog, { surfaceId: id, onClose: () => root.render(null) })));
    const buttons = document.querySelectorAll<HTMLButtonElement>('.chat-reminder-dialog button');
    const first = buttons[0], last = buttons[buttons.length - 1];
    expect(document.activeElement).toBe(first);
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);
    await click('Close'); expect(document.activeElement).toBe(trigger);
  });
});

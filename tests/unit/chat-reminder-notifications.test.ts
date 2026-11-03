import { describe, expect, it, vi } from 'vitest';
import { createChatReminderNotifier } from '../../src/renderer/remote-sessions/chat-reminder-notifications';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';

function views(): RemoteRegistryView[] {
  return [{ hostId: 'desk', deviceId: 'device-a', connected: true, bootId: 'b', groups: [], closedIds: [], lost: {}, sessions: [{
    id: 'surf-chat', groupId: null, cwd: '/', createdBy: 'device-a', createdAt: 1, bootId: 'b', state: 'live', hiddenBy: [],
    chatReminder: { dueAt: 100, firedAt: 101, createdBy: 'device-a', note: 'Check results' },
    chatAttention: { revision: 1, at: 101, kind: 'reminder', seenBy: {} },
  }] }];
}
describe('server reminder delivery', () => {
  it('delivers once, survives app restart, and delivers a replacement reminder', () => {
    let saved: string | null = null; const fire = vi.fn();
    const deps = { read: () => saved, write: (value: string) => { saved = value; }, fire };
    const notify = createChatReminderNotifier(deps); const view = views();
    notify(view); notify(view); createChatReminderNotifier(deps)(view);
    expect(fire).toHaveBeenCalledExactlyOnceWith({ surfaceId: 'surf-chat', text: 'Check results', title: 'Remotea reminder' });
    view[0].sessions[0].chatReminder!.firedAt = 200;
    createChatReminderNotifier(deps)(view); expect(fire).toHaveBeenCalledTimes(2);
  });
  it('waits for reconnect and excludes hidden, read and closed chats', () => {
    const fire = vi.fn(); const notify = createChatReminderNotifier({ read: () => null, write: () => {}, fire });
    const view = views(); const session = view[0].sessions[0];
    view[0].connected = false; notify(view);
    view[0].connected = true; session.hiddenBy = ['device-a']; notify(view);
    session.hiddenBy = []; view[0].closedIds = [session.id]; notify(view);
    view[0].closedIds = []; session.chatAttention!.seenBy['device-a'] = 1; notify(view);
    expect(fire).not.toHaveBeenCalled();
    session.chatAttention!.seenBy = {}; notify(view); expect(fire).toHaveBeenCalledOnce();
  });
  it('retries a failed notification and deduplicates when storage is unavailable', () => {
    const fire = vi.fn().mockImplementationOnce(() => { throw new Error('unavailable'); });
    const notify = createChatReminderNotifier({ read: () => { throw new Error('no storage'); }, write: () => { throw new Error('no storage'); }, fire });
    notify(views()); notify(views()); notify(views()); expect(fire).toHaveBeenCalledTimes(2);
  });
});

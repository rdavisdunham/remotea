import type { RemoteRegistryView } from '../../shared/remote-hosts-types';
import { chatIsUnread } from '../../shared/chat-attention';

const KEY = 'remotea-chat-reminder-deliveries-v1';

/** Called only by the device's designated placement window: one OS notice per reminder. */
export function createChatReminderNotifier(deps: {
  read: () => string | null;
  write: (value: string) => void;
  fire: (data: { surfaceId: string; text: string; title: string }) => void;
}): (views: RemoteRegistryView[]) => void {
  const delivered = new Map<string, string>();
  try {
    const saved: unknown = JSON.parse(deps.read() ?? '[]');
    if (Array.isArray(saved)) for (const entry of saved.slice(-512)) {
      if (Array.isArray(entry) && entry.length === 2 && entry.every(v => typeof v === 'string')) delivered.set(entry[0], entry[1]);
    }
  } catch { /* first launch or unavailable storage */ }
  return views => {
    for (const view of views) {
      if (!view.connected) continue;
      for (const session of view.sessions) {
        const reminder = session.chatReminder;
        if (!reminder?.firedAt || session.hiddenBy.includes(view.deviceId) || view.closedIds.includes(session.id)
          || !chatIsUnread(session.chatAttention, view.deviceId)) continue;
        const key = `${view.hostId}|${session.id}`;
        const version = `${reminder.dueAt}|${reminder.firedAt}`;
        if (delivered.get(key) === version) continue;
        try { deps.fire({ surfaceId: session.id, title: 'Remotea reminder', text: reminder.note || session.title || 'Check this chat' }); }
        catch { continue; }
        delivered.delete(key); delivered.set(key, version);
        if (delivered.size > 512) delivered.delete(delivered.keys().next().value!);
        try { deps.write(JSON.stringify([...delivered])); } catch { /* in-memory deduplication still applies */ }
      }
    }
  };
}

let notify: ReturnType<typeof createChatReminderNotifier> | undefined;
export function notifyChatReminders(views: RemoteRegistryView[]): void {
  notify ??= createChatReminderNotifier({
    read: () => localStorage.getItem(KEY),
    write: value => localStorage.setItem(KEY, value),
    fire: data => { if (!window.remotea?.notification?.fire) throw new Error('Notification bridge unavailable'); window.remotea.notification.fire(data); },
  });
  notify(views);
}

import { useEffect, useRef, useState } from 'react';
import { actOnChat, markChatRead, useChatAttention } from '../../remote-sessions/chat-attention';
import ChatReminderDialog from './ChatReminderDialog';

export default function ChatStatus({ surfaceId, active }: { surfaceId: string; active: boolean }) {
  const { host, session, attention, unread, status } = useChatAttention(surfaceId);
  const root = useRef<HTMLDivElement>(null);
  const [remind, setRemind] = useState(false);
  const [error, setError] = useState('');
  // A new reply remains unread even in the focused pane until real interaction.
  // Focus switches acknowledge the newly visited chat, not its hidden siblings.
  useEffect(() => { if (active) markChatRead(surfaceId); }, [active, surfaceId]);
  useEffect(() => {
    if (!active) return;
    const pane = root.current?.closest('.terminal-pane');
    const interact = (e: Event) => {
      if ((e.target as Element)?.closest?.('.chat-status, .confirm-dialog')) return;
      if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes((e as KeyboardEvent).key)) return;
      markChatRead(surfaceId);
    };
    pane?.addEventListener('pointerdown', interact, true);
    pane?.addEventListener('keydown', interact, true);
    return () => { pane?.removeEventListener('pointerdown', interact, true); pane?.removeEventListener('keydown', interact, true); };
  }, [active, surfaceId]);
  const change = async () => {
    try {
      const result = await actOnChat(surfaceId, unread ? { action: 'read', revision: attention!.revision } : { action: 'unread' });
      setError(result.ok ? '' : result.error ?? 'Could not update chat.');
    } catch { setError('Could not reach the server.'); }
  };
  return <div ref={root} className="chat-status" data-tone={status.tone}>
    <span className="chat-status__label" role="status" title={session?.agentState?.reason}>{status.label}{host && !host.connected ? ' · offline' : ''}</span>
    {session?.chatReminder && (!session.chatReminder.firedAt || unread) && <span title={session.chatReminder.note}>{session.chatReminder.firedAt ? 'Reminder due' : `Reminder ${new Date(session.chatReminder.dueAt).toLocaleString()}`}</span>}
    <button type="button" onClick={() => void change()}>{unread ? 'Mark read' : 'Mark unread'}</button>
    {host && <button type="button" onClick={() => setRemind(true)}>{session?.chatReminder ? 'Edit reminder' : 'Remind me…'}</button>}
    {error && <span role="alert">{error}</span>}
    {remind && <ChatReminderDialog surfaceId={surfaceId} onClose={() => setRemind(false)} />}
  </div>;
}

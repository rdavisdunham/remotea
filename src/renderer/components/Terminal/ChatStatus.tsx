import { useEffect, useRef, useState } from 'react';
import { actOnChat, markChatRead, useChatAttention } from '../../remote-sessions/chat-attention';
import { insightAge, terminalInsight } from '../../remote-sessions/insight';
import ChatReminderDialog from './ChatReminderDialog';

/**
 * The pane brief: one strip across the top of a terminal that says what state
 * the conversation is in and, when Tea has written one, what the terminal is
 * working on. A plain shell with nothing to report shows no strip at all; its
 * read state and reminders stay reachable from the tab's context menu.
 */
export default function ChatStatus({ surfaceId, active }: { surfaceId: string; active: boolean }) {
  const { host, session, attention, unread, status, hasHarness } = useChatAttention(surfaceId);
  const { summary, stale, generatedAt } = terminalInsight(host, session);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!generatedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [generatedAt]);
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
  const reminder = session?.chatReminder && (!session.chatReminder.firedAt || unread) ? session.chatReminder : undefined;
  const quiet = !hasHarness && !summary && !unread && !reminder && !error && session?.state !== 'lost';
  const freshness = !generatedAt ? '' : stale ? 'New activity since this summary' : `Summarized ${insightAge(generatedAt, now)}`;
  return <div ref={root} className="chat-status" data-tone={status.tone} data-quiet={quiet ? 'true' : undefined} data-expanded={expanded ? 'true' : undefined}>
    {/* A plain shell has no agent state to report; its summary stands alone. */}
    <span className="chat-status__label" role="status" data-plain={!hasHarness && status.tone === 'idle' && session?.state !== 'lost' && !(host && !host.connected) ? 'true' : undefined} title={session?.agentState?.reason}>{status.label}{host && !host.connected ? ' · offline' : ''}</span>
    {summary
      ? <button
          type="button"
          className="chat-status__summary"
          aria-expanded={expanded}
          title={[expanded ? 'Collapse the summary' : 'Show the whole summary', freshness].filter(Boolean).join(' · ')}
          onClick={() => setExpanded(open => !open)}
        >{summary}</button>
      : <span className="chat-status__spacer" />}
    {summary && generatedAt && <span className="chat-status__age" data-stale={stale ? 'true' : undefined}>{stale ? 'new activity' : insightAge(generatedAt, now)}</span>}
    {reminder && <span className="chat-status__reminder" title={reminder.note}>{reminder.firedAt ? 'Reminder due' : `Reminder ${new Date(reminder.dueAt).toLocaleString()}`}</span>}
    <span className="chat-status__actions">
      <button type="button" onClick={() => void change()}>{unread ? 'Mark read' : 'Mark unread'}</button>
      {host && <button type="button" onClick={() => setRemind(true)}>{session?.chatReminder ? 'Edit reminder' : 'Remind me…'}</button>}
    </span>
    {error && <span role="alert">{error}</span>}
    {remind && <ChatReminderDialog surfaceId={surfaceId} onClose={() => setRemind(false)} />}
  </div>;
}

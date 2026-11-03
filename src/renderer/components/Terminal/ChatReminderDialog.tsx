import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { actOnChat, useChatAttention } from '../../remote-sessions/chat-attention';

function localDate(value: number): string {
  const d = new Date(value);
  return new Date(value - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function ChatReminderDialog({ surfaceId, onClose }: { surfaceId: string; onClose: () => void }) {
  const { session, host } = useChatAttention(surfaceId);
  const reminder = session?.chatReminder;
  const [date, setDate] = useState(() => localDate(reminder && !reminder.firedAt ? reminder.dueAt : Date.now() + 30 * 60000));
  const [note, setNote] = useState(reminder?.note ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (prior?.isConnected) prior.focus(); };
  }, []);
  const apply = async (cancel = false, minutes?: number) => {
    if (inFlight.current) return;
    const dueAt = minutes ? Date.now() + minutes * 60000 : new Date(date).getTime();
    if (!cancel && (!Number.isFinite(dueAt) || dueAt <= Date.now())) { setError('Choose a future time.'); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      const result = await actOnChat(surfaceId, cancel ? { action: 'cancelReminder' } : { action: 'remind', dueAt, note });
      if (result.ok) onClose(); else setError(result.error ?? 'Could not save reminder.');
    } catch { setError('Could not reach the server.'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return createPortal(<div className="confirm-dialog__overlay" onClick={() => !busy && onClose()}>
    <div ref={root} className="confirm-dialog chat-reminder-dialog" role="dialog" aria-modal="true" aria-label="Chat reminder"
      onClick={e => e.stopPropagation()} onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape' && !busy) onClose();
        if (e.key === 'Tab') {
          const items = Array.from(root.current!.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button,input,textarea'));
          const enabled = items.filter(item => !item.disabled);
          const first = enabled[0], last = enabled.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="confirm-dialog__title">Remind me about this chat</div>
      <p className="confirm-dialog__message">Runs locally on the session server. If the app is closed, the reminder stays unread until you return. If the server is off, it fires when the server starts again.</p>
      <div className="chat-reminder-dialog__presets">{[10, 30, 60].map(minutes => <button key={minutes} className="confirm-dialog__btn" disabled={busy || !host?.connected} onClick={() => void apply(false, minutes)}>In {minutes} minutes</button>)}</div>
      <label>Reminder time <input type="datetime-local" value={date} onChange={e => setDate(e.target.value)} disabled={busy} /></label>
      <label>Notes (optional) <textarea maxLength={300} value={note} onChange={e => setNote(e.target.value)} disabled={busy} rows={2} /></label>
      {reminder && <p>{reminder.firedAt ? 'Reminder due' : 'Current reminder'}: {new Date(reminder.dueAt).toLocaleString()}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="confirm-dialog__actions">
        {reminder && <button className="confirm-dialog__btn" disabled={busy || !host?.connected} onClick={() => void apply(true)}>Remove reminder</button>}
        <button className="confirm-dialog__btn" disabled={busy} onClick={onClose}>Close</button>
        <button className="confirm-dialog__btn confirm-dialog__btn--primary" disabled={busy || !host?.connected} onClick={() => void apply()}>Save reminder</button>
      </div>
    </div>
  </div>, document.body);
}

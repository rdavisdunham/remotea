/** Local server service. No agent input or Eridani dependency; registry pushes are its delivery mechanism. */
import type { ChatAttentionAction, RemoteSurfaceId, SessionRecord, AgentStateInfo } from '../../src/shared/remote-host-protocol';
import type { Registry } from './registry';

export class ChatAttentionService {
  constructor(private registry: Registry, private publish: (session: SessionRecord) => void, private now = Date.now, private log: (message: string) => void = () => {}) {}

  private raise(rec: SessionRecord, kind: NonNullable<SessionRecord['chatAttention']>['kind']): void {
    rec.chatAttention = { revision: (rec.chatAttention?.revision ?? 0) + 1, at: this.now(), kind, seenBy: {} };
  }

  stateChanged(rec: SessionRecord, next: AgentStateInfo): void {
    const prev = rec.agentState?.state;
    if (next.state === 'needs_you' && prev !== 'needs_you') this.raise(rec, 'needs_you');
    else if ((next.state === 'idle' || next.state === 'exited') && (prev === 'working' || (prev === 'needs_you' && next.state === 'exited'))) this.raise(rec, 'finished');
  }

  apply(id: RemoteSurfaceId, device: string, action: ChatAttentionAction): { ok: boolean; error?: string } {
    const rec = this.registry.session(id);
    if (!rec || rec.hiddenBy.includes(device)) return { ok: false, error: 'Session is unavailable.' };
    const previousAttention = structuredClone(rec.chatAttention);
    const previousReminder = structuredClone(rec.chatReminder);
    const now = this.now();
    switch (action.action) {
      case 'read':
        // A late click must never acknowledge an answer that arrived after it.
        if (rec.chatAttention?.revision !== action.revision) return { ok: true };
        rec.chatAttention.seenBy[device] = action.revision;
        break;
      case 'unread':
        if (!rec.chatAttention) this.raise(rec, 'unread');
        delete rec.chatAttention!.seenBy[device];
        break;
      case 'remind':
        if (action.dueAt <= now || action.dueAt > now + 366 * 86400000) return { ok: false, error: 'Choose a reminder within the next year.' };
        rec.chatReminder = { dueAt: action.dueAt, createdBy: device, ...(action.note?.trim() ? { note: action.note.trim() } : {}) };
        break;
      case 'cancelReminder': rec.chatReminder = null; break;
    }
    // Persist before confirming. Requests are explicit and never blindly retried.
    try { this.registry.saveNow(); } catch {
      rec.chatAttention = previousAttention; rec.chatReminder = previousReminder;
      return { ok: false, error: 'Could not save chat attention on the server.' };
    }
    this.publish(rec);
    return { ok: true };
  }

  /** Also called at startup: overdue reminders survive an app disconnect or server restart. */
  tick(): void {
    for (const rec of this.registry.sessions()) {
      if (!rec.chatReminder || rec.chatReminder.firedAt || rec.chatReminder.dueAt > this.now()) continue;
      const previousAttention = rec.chatAttention;
      rec.chatReminder.firedAt = this.now();
      this.raise(rec, 'reminder');
      try { this.registry.saveNow(); } catch {
        delete rec.chatReminder.firedAt; rec.chatAttention = previousAttention;
        this.log('Could not persist a chat reminder; will retry.');
        continue;
      }
      this.publish(rec);
    }
  }
}

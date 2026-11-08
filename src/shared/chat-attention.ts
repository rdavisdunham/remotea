import type { ChatAttention, AgentStateName } from './remote-host-protocol';

export function chatIsUnread(attention: ChatAttention | undefined, device: string): boolean {
  return !!attention && attention.seenBy[device] !== attention.revision;
}

/** Colour and words come from the same decision, with unread kept independent of activity. */
export function chatStatus(state: AgentStateName | 'unknown' | undefined, unread: boolean, kind?: ChatAttention['kind'], justFinished = false, hasHarness = false): { tone: string; label: string } {
  if (state === 'needs_you') return { tone: 'waiting', label: 'Needs you' };
  if (kind === 'reminder' && unread) return { tone: 'attention', label: 'Reminder due' };
  if (state === 'working') return { tone: 'working', label: 'Working on it…' };
  if (justFinished && kind === 'finished') return { tone: 'ready', label: unread ? 'Finished · unread' : 'Finished' };
  if (unread) return { tone: 'attention', label: kind === 'finished' ? 'Finished · unread' : 'Unread · check this chat' };
  if (state === 'exited') return { tone: 'idle', label: 'Session ended' };
  if (state === 'idle') return { tone: 'ready', label: 'Idle · ready for you' };
  return { tone: 'idle', label: hasHarness ? 'Waiting for harness status' : 'No harness detected' };
}

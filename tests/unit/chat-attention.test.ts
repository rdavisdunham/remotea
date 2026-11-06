import { describe, expect, it } from 'vitest';
import { chatIsUnread, chatStatus } from '../../src/shared/chat-attention';

describe('chat attention presentation', () => {
  it('keeps working, finished, unseen and waiting states distinct', () => {
    expect(chatStatus('working', false)).toEqual({ tone: 'working', label: 'Working on it…' });
    expect(chatStatus('idle', true, 'finished', true)).toEqual({ tone: 'ready', label: 'Finished · unread' });
    expect(chatStatus('idle', true, 'finished', false).tone).toBe('attention');
    expect(chatStatus('idle', false, 'finished', false).tone).toBe('ready');
    expect(chatStatus('needs_you', false).label).toBe('Needs you');
    expect(chatStatus('working', true, 'reminder').label).toBe('Reminder due');
    expect(chatStatus(undefined, false).label).toBe('No harness detected');
    expect(chatStatus('unknown', false, undefined, false, true).label).toBe('Waiting for harness status');
  });
  it('does not let acknowledgements for older replies clear a new reply', () => {
    expect(chatIsUnread({ revision: 2, at: 1, kind: 'finished', seenBy: { a: 1, b: 2 } }, 'a')).toBe(true);
    expect(chatIsUnread({ revision: 2, at: 1, kind: 'finished', seenBy: { a: 1, b: 2 } }, 'b')).toBe(false);
    expect(chatIsUnread(undefined, 'a')).toBe(false);
  });
});

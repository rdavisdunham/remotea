import { create } from 'zustand';
import { useEffect } from 'react';
import { useStore } from '../store';
import { surfaceAgentState } from '../store/agent-rollup';
import { useRemoteRegistry } from './registry-cache';
import { chatIsUnread } from '../../shared/chat-attention';
import type { AgentStateName, ChatAttention, ChatAttentionAction } from '../../shared/remote-host-protocol';

const KEY = 'remotea-chat-attention-v1';
function load(): Record<string, ChatAttention> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, ChatAttention] => {
      const a = entry[1];
      return a && typeof a === 'object' && Number.isSafeInteger(a.revision) && a.revision > 0
        && Number.isFinite(a.at) && ['finished', 'needs_you', 'unread', 'reminder'].includes(a.kind)
        && a.seenBy && typeof a.seenBy === 'object';
    }).slice(0, 512));
  } catch { return {}; }
}
/** Fallback for local panes; remote sessions always use their server's durable record. */
export const useLocalChatAttention = create<{ entries: Record<string, ChatAttention> }>(() => ({ entries: load() }));
function save(id: string, value: ChatAttention): void {
  const entries = { ...useLocalChatAttention.getState().entries, [id]: value };
  const bounded = Object.fromEntries(Object.entries(entries).sort((a, b) => b[1].at - a[1].at).slice(0, 512));
  useLocalChatAttention.setState({ entries: bounded });
  try { localStorage.setItem(KEY, JSON.stringify(bounded)); } catch { /* live state still works */ }
}
const observed = new Map<string, AgentStateName | 'unknown' | undefined>();
export function observeLocalChat(id: string, state: AgentStateName | 'unknown' | undefined): void {
  const prev = observed.get(id);
  if (prev === state) return;
  observed.set(id, state);
  // Bound transient observations, just like persisted entries.
  if (observed.size > 1024) observed.delete(observed.keys().next().value!);
  const kind = state === 'needs_you' ? 'needs_you' : state === 'idle' && prev === 'working' ? 'finished' : null;
  if (!kind) return;
  const old = useLocalChatAttention.getState().entries[id];
  save(id, { revision: (old?.revision ?? 0) + 1, at: Date.now(), kind, seenBy: {} });
}

export function useChatAttention(surfaceId: string) {
  const views = useRemoteRegistry(s => s.views);
  const host = views?.find(v => v.sessions.some(s => s.id === surfaceId));
  const session = host?.sessions.find(s => s.id === surfaceId);
  const declared = useStore(s => s.agentStates?.[surfaceId]);
  const detected = useStore(s => s.agentDetections?.[surfaceId]);
  const fallback = surfaceAgentState(declared, detected)?.state;
  const state: AgentStateName | 'unknown' | undefined = session?.state === 'exited' ? 'exited' : session?.state === 'lost' ? 'unknown' : session?.agentState?.state ?? (fallback === 'blocked' || fallback === 'question' ? 'needs_you' : fallback);
  const local = useLocalChatAttention(s => s.entries[surfaceId]);
  useEffect(() => { if (!session) observeLocalChat(surfaceId, state); }, [surfaceId, state, !!session]);
  const attention = session ? session.chatAttention : local;
  const device = host?.deviceId ?? 'local';
  return { host, session, state, attention, unread: chatIsUnread(attention, device) };
}

export async function actOnChat(surfaceId: string, action: ChatAttentionAction): Promise<{ ok: boolean; error?: string }> {
  const host = useRemoteRegistry.getState().views?.find(v => v.sessions.some(s => s.id === surfaceId));
  if (host) {
    if (!host.connected) return { ok: false, error: 'Reconnect to this server to change attention or reminders.' };
    const result = await window.wmux.remoteSessions.chatAttention(host.hostId, surfaceId, action);
    return result.uncertain ? { ok: false, error: 'The server has not confirmed this change. Check the status before retrying.' } : result;
  }
  const old = useLocalChatAttention.getState().entries[surfaceId];
  if (action.action === 'read') {
    if (old?.revision === action.revision) save(surfaceId, { ...old, seenBy: { local: old.revision } });
  } else if (action.action === 'unread') {
    save(surfaceId, { revision: old?.revision ?? 1, at: old?.at ?? Date.now(), kind: old?.kind ?? 'unread', seenBy: {} });
  } else return { ok: false, error: 'Server reminders require a remote session.' };
  return { ok: true };
}

const reading = new Map<string, number>();
export function markChatRead(surfaceId: string): void {
  const host = useRemoteRegistry.getState().views?.find(v => v.sessions.some(s => s.id === surfaceId));
  const attention = host ? host.sessions.find(s => s.id === surfaceId)?.chatAttention : useLocalChatAttention.getState().entries[surfaceId];
  if (!chatIsUnread(attention, host?.deviceId ?? 'local') || reading.get(surfaceId) === attention!.revision) return;
  const revision = attention!.revision;
  reading.set(surfaceId, revision);
  void actOnChat(surfaceId, { action: 'read', revision }).catch(() => { /* explicit Mark read remains available */ }).finally(() => { if (reading.get(surfaceId) === revision) reading.delete(surfaceId); });
}

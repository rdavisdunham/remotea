/**
 * remotea: what "connected" means, split into its three separate facts
 * (Astra review A-S2). A green host says nothing about a terminal, and a live
 * terminal says nothing about the Eridani run in it:
 *
 *   host connection   the socket to the server (HostStatus), with when it
 *                     was last heard from;
 *   process           each tab's terminal process: live, exited, or
 *                     restoring (re-attaching, or respawning after a server
 *                     restart), from the registry's `state` and this app's
 *                     open confirmations;
 *   run               for a session that carries an Eridani binding, the run
 *                     state the server registry reports (`eridani`,
 *                     `agentState`, `verify`).
 *
 * Pure, so it can be tested without a window. Uses only fields the server
 * already sends.
 */
import type { SessionRecord } from '../../shared/remote-host-protocol';
import type { HostConnState, HostStatus, RemoteRegistryView } from '../../shared/remote-hosts-types';

export type HealthTone = 'ok' | 'pending' | 'error' | 'off' | 'neutral';

export interface ConnectionHealth {
  state: HostConnState;
  label: string;
  tone: HealthTone;
  /** "since 10:42", "last seen 5 min ago", "never connected". */
  detail: string;
}

export type ProcessState = 'live' | 'exited' | 'restoring';

export interface ProcessHealth {
  state: ProcessState;
  label: string;
  tone: HealthTone;
  /** The host is not connected: this is the last state the registry reported, not a current one. */
  stale: boolean;
}

export type RunState = 'working' | 'needs_you' | 'idle' | 'stopping' | 'ended' | 'unknown';

export interface RunHealth {
  runId: string;
  generation: number;
  state: RunState;
  label: string;
  tone: HealthTone;
  /** The latest verification attempt, when the registry has one. */
  verify?: string;
}

export interface TabHealth {
  id: string;
  title: string;
  process: ProcessHealth;
  run: RunHealth | null;
}

const CONN: Record<HostConnState, { label: string; tone: HealthTone }> = {
  disabled: { label: 'Off', tone: 'off' },
  connecting: { label: 'Connecting…', tone: 'pending' },
  ready: { label: 'Connected', tone: 'ok' },
  reconnecting: { label: 'Reconnecting…', tone: 'pending' },
  'auth-failed': { label: 'Token rejected', tone: 'error' },
  'wrong-server': { label: 'Different server', tone: 'error' },
  incompatible: { label: 'Incompatible', tone: 'error' },
  suspended: { label: 'Paused (sleep)', tone: 'pending' },
};

/** "just now", "42 s ago", "5 min ago", "3 h ago", or a date. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString();
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The transport to the host, and when it was last heard from. Says nothing about terminals. */
export function connectionHealth(status: HostStatus | undefined, now: number): ConnectionHealth {
  const state = status?.state ?? 'disabled';
  const { label, tone } = CONN[state];
  let detail: string;
  if (state === 'ready') detail = status?.connectedAt ? `since ${clock(status.connectedAt)}` : 'just connected';
  else if (status?.lastSeenAt) detail = `last seen ${ago(status.lastSeenAt, now)}`;
  else detail = 'never connected';
  return { state, label, tone, detail };
}

/** A tab's terminal process, as the registry and this app's open confirmations report it. */
export function processHealth(s: SessionRecord, view: Pick<RemoteRegistryView, 'connected' | 'restoring'>): ProcessHealth {
  const stale = !view.connected;
  let state: ProcessState;
  if (s.state === 'exited') state = 'exited';
  // `lost`: the server restarted and respawns it on the next open.
  else if (s.state === 'lost') state = 'restoring';
  else if (!stale && view.restoring?.includes(s.id)) state = 'restoring';
  else state = 'live';
  const base = state === 'live' ? 'Live' : state === 'exited' ? `Exited${s.exitCode !== undefined ? ` (${s.exitCode})` : ''}` : 'Restoring…';
  const tone: HealthTone = stale ? 'neutral' : state === 'live' ? 'ok' : state === 'exited' ? 'off' : 'pending';
  return { state, label: stale ? `${base} (last known)` : base, tone, stale };
}

const RUN_LABEL: Record<RunState, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  idle: 'Idle',
  stopping: 'Stopping',
  ended: 'Agent ended',
  unknown: 'No report yet',
};

const RUN_TONE: Record<RunState, HealthTone> = {
  working: 'ok',
  needs_you: 'error',
  idle: 'neutral',
  stopping: 'pending',
  ended: 'off',
  unknown: 'neutral',
};

/** The Eridani run in this session, as the server registry reports it; null when there is none. */
export function runHealth(s: SessionRecord): RunHealth | null {
  const b = s.eridani;
  if (!b) return null;
  let state: RunState;
  if (s.state === 'exited' || s.agentState?.state === 'exited') state = 'ended';
  else if (b.stopRequested) state = 'stopping';
  else if (s.agentState?.state === 'working' || s.agentState?.state === 'needs_you' || s.agentState?.state === 'idle') state = s.agentState.state;
  else state = 'unknown';
  const verify = s.verify && s.verify.runId === b.runId ? `verify ${s.verify.state.replace('_', ' ')}` : undefined;
  return { runId: b.runId, generation: b.generation, state, label: RUN_LABEL[state], tone: RUN_TONE[state], verify };
}

/** Every tab this device shows from `view`: not hidden here, not closed. */
export function tabsHealth(view: RemoteRegistryView | undefined): TabHealth[] {
  if (!view) return [];
  const closed = new Set(view.closedIds);
  return view.sessions
    .filter((s) => !closed.has(s.id) && !(s.hiddenBy as string[]).includes(view.deviceId))
    .map((s) => ({
      id: s.id,
      title: s.title || s.agent?.provider || s.cmd || 'shell',
      process: processHealth(s, view),
      run: runHealth(s),
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

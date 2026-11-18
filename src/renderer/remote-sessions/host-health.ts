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
import { makeT, type Translator, type TranslationKey } from '../i18n/core';
import type { SessionRecord } from '../../shared/remote-host-protocol';
import type { HostConnState, HostStatus, RemoteRegistryView } from '../../shared/remote-hosts-types';

export type HealthTone = 'ok' | 'pending' | 'error' | 'off' | 'neutral';

export interface ConnectionHealth {
  state: HostConnState | 'unknown';
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
  stale?: boolean;
}

export interface TabHealth {
  id: string;
  title: string;
  process: ProcessHealth;
  run: RunHealth | null;
}

const CONN: Record<HostConnState, { key: TranslationKey; tone: HealthTone }> = {
  disabled: { key: 'health.connection.disabled', tone: 'off' },
  connecting: { key: 'health.connection.connecting', tone: 'pending' },
  ready: { key: 'health.connection.ready', tone: 'ok' },
  reconnecting: { key: 'health.connection.reconnecting', tone: 'pending' },
  'auth-failed': { key: 'health.connection.auth-failed', tone: 'error' },
  'wrong-server': { key: 'health.connection.wrong-server', tone: 'error' },
  incompatible: { key: 'health.connection.incompatible', tone: 'error' },
  suspended: { key: 'health.connection.suspended', tone: 'pending' },
};

/** "just now", "42 s ago", "5 min ago", "3 h ago", or a date. */
export function ago(at: number, now: number, t: Translator = makeT('en')): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return t('health.justNow');
  if (s < 60) return t('health.secondsAgo').replace('{n}', String(s));
  const m = Math.floor(s / 60);
  if (m < 60) return t('health.minutesAgo').replace('{n}', String(m));
  const h = Math.floor(m / 60);
  if (h < 24) return t('health.hoursAgo').replace('{n}', String(h));
  return new Date(at).toLocaleDateString();
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The transport to the host, and when it was last heard from. Says nothing about terminals. */
export function connectionHealth(status: HostStatus | undefined, now: number, t: Translator = makeT('en')): ConnectionHealth {
  if (!status) return { state: 'unknown', label: t('health.connection.unknown'), tone: 'neutral', detail: t('health.awaitingStatus') };
  const state = status.state;
  const { key, tone } = CONN[state];
  const label = t(key);
  let detail: string;
  if (state === 'ready') detail = status?.connectedAt ? t('health.since').replace('{time}', clock(status.connectedAt)) : t('health.justConnected');
  else if (status?.lastSeenAt) detail = t('health.lastSeen').replace('{time}', ago(status.lastSeenAt, now, t));
  else detail = t('health.neverConnected');
  return { state, label, tone, detail };
}

export interface ServerNotice {
  label: string;
  tone: HealthTone;
  detail: string;
}

/**
 * A connected host whose session server predates the rename (its welcome
 * lacks `remoteaNames`): it works, but its agents won't report status until
 * it is upgraded. Null when there is nothing to say. Never blocks anything.
 */
export function serverNotice(status: HostStatus | undefined, hostName: string | undefined, t: Translator = makeT('en')): ServerNotice | null {
  if (!status?.serverPredatesRename) return null;
  const host = hostName || status.serverHostname || status.hostId;
  return { label: t('health.serverUpdate'), tone: 'pending', detail: t('health.serverPredatesRename').replace('{host}', host) };
}

/** A tab's terminal process, as the registry and this app's open confirmations report it. */
export function processHealth(s: SessionRecord, view: Pick<RemoteRegistryView, 'connected' | 'restoring'>, t: Translator = makeT('en')): ProcessHealth {
  const stale = !view.connected;
  let state: ProcessState;
  if (s.state === 'exited') state = 'exited';
  // `lost`: the server restarted and respawns it on the next open.
  else if (s.state === 'lost') state = 'restoring';
  else if (!stale && view.restoring?.includes(s.id)) state = 'restoring';
  else state = 'live';
  const base = state === 'exited' && s.exitCode !== undefined
    ? `${t('health.process.exited')} (${s.exitCode})`
    : t(`health.process.${state}`);
  const tone: HealthTone = stale ? 'neutral' : state === 'live' ? 'ok' : state === 'exited' ? 'off' : 'pending';
  return { state, label: stale ? t('health.lastKnown').replace('{state}', base) : base, tone, stale };
}

const RUN_LABEL: Record<RunState, TranslationKey> = {
  working: 'health.run.working',
  needs_you: 'health.run.needs_you',
  idle: 'health.run.idle',
  stopping: 'health.run.stopping',
  ended: 'health.run.ended',
  unknown: 'health.run.unknown',
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
export function runHealth(s: SessionRecord, connected = true, t: Translator = makeT('en')): RunHealth | null {
  const b = s.eridani;
  if (!b) return null;
  let state: RunState;
  if (s.state === 'exited' || s.agentState?.state === 'exited') state = 'ended';
  else if (b.stopRequested) state = 'stopping';
  else if (s.agentState?.state === 'working' || s.agentState?.state === 'needs_you' || s.agentState?.state === 'idle') state = s.agentState.state;
  else state = 'unknown';
  const reportedVerify = s.verify && s.verify.runId === b.runId && s.verify.generation === b.generation
    ? t('health.verify').replace('{state}', t(`health.verification.${s.verify.state}`))
    : undefined;
  const label = t(RUN_LABEL[state]);
  return {
    runId: b.runId,
    generation: b.generation,
    state,
    label: connected ? label : t('health.lastKnown').replace('{state}', label),
    tone: connected ? RUN_TONE[state] : 'neutral',
    verify: !connected && reportedVerify
      ? t('health.lastKnown').replace('{state}', reportedVerify)
      : reportedVerify,
    stale: !connected,
  };
}

/** Every tab this device shows from `view`: not hidden here, not closed. */
export function tabsHealth(view: RemoteRegistryView | undefined, t: Translator = makeT('en')): TabHealth[] {
  if (!view) return [];
  const closed = new Set(view.closedIds);
  return view.sessions
    .filter((s) => !closed.has(s.id) && !(s.hiddenBy as string[]).includes(view.deviceId))
    .map((s) => ({
      id: s.id,
      title: s.title || s.tea?.title || s.agent?.provider || s.cmd || (s.lastCwd || s.cwd ? `shell in ${s.lastCwd || s.cwd}` : 'shell'),
      process: processHealth(s, view, t),
      run: runHealth(s, view.connected, t),
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

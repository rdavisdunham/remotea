/**
 * Connection lifecycle for one remote host, as a pure reducer so every edge
 * (sleep, Wi-Fi loss, wrong token, server restart) is testable on a fake clock.
 *
 *   disabled ─start→ connecting ─opened→ handshaking ─welcome→ ready
 *                       ↑   │                 │                  │ closed / dead heartbeat
 *                       │   └──── closed ─────┴──→ reconnecting(n) ←┘
 *                       └──── retry timer (250 ms · 2ⁿ, ≤ 15 s, ±20 %) ┘
 *   401 → auth-failed (retried every 5 min, or at once when the token changes)
 *   protocol mismatch → incompatible (no retry)
 *   suspend (any state) → suspended; resume / unlock / window focus → connecting now
 */
import { TIMING } from '../../shared/remote-host-protocol';
import type { HostConnState } from '../../shared/remote-hosts-types';

export const AUTH_RETRY_MS = 5 * 60 * 1000;

export type FsmState = Exclude<HostConnState, 'ready'> | 'handshaking' | 'ready';

export interface Fsm {
  state: FsmState;
  /** Consecutive failed attempts (reset on ready). */
  attempt: number;
  error?: string;
}

export type FsmEvent =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'opened' }
  | { type: 'welcome' }
  | { type: 'closed'; error?: string }
  | { type: 'auth-failed' }
  | { type: 'wrong-server' }
  | { type: 'incompatible'; error?: string }
  | { type: 'retry' }
  | { type: 'suspend' }
  | { type: 'wake' };

export type FsmEffect =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'schedule-retry'; ms: number }
  | { type: 'cancel-retry' }
  | { type: 'ready' }
  | { type: 'down' };

export function initialFsm(): Fsm {
  return { state: 'disabled', attempt: 0 };
}

export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(TIMING.backoffMaxMs, TIMING.backoffMinMs * 2 ** Math.min(attempt, 16));
  return Math.round(base * (0.8 + rand() * 0.4));
}

const LIVE = new Set<FsmState>(['connecting', 'handshaking', 'ready']);

export function step(fsm: Fsm, ev: FsmEvent, rand: () => number = Math.random): { fsm: Fsm; effects: FsmEffect[] } {
  const wasReady = fsm.state === 'ready';
  const down: FsmEffect[] = wasReady ? [{ type: 'down' }] : [];
  switch (ev.type) {
    case 'start':
      if (LIVE.has(fsm.state)) return { fsm, effects: [] };
      return { fsm: { state: 'connecting', attempt: fsm.attempt }, effects: [{ type: 'cancel-retry' }, { type: 'connect' }] };
    case 'stop':
      return { fsm: { state: 'disabled', attempt: 0 }, effects: [{ type: 'cancel-retry' }, { type: 'disconnect' }, ...down] };
    case 'opened':
      return fsm.state === 'connecting' ? { fsm: { ...fsm, state: 'handshaking' }, effects: [] } : { fsm, effects: [] };
    case 'welcome':
      return fsm.state === 'handshaking' ? { fsm: { state: 'ready', attempt: 0 }, effects: [{ type: 'ready' }] } : { fsm, effects: [] };
    case 'closed': {
      if (!LIVE.has(fsm.state)) return { fsm, effects: [] };
      const attempt = wasReady ? 0 : fsm.attempt + 1;
      return {
        fsm: { state: 'reconnecting', attempt, error: ev.error },
        effects: [...down, { type: 'schedule-retry', ms: backoffDelay(attempt, rand) }],
      };
    }
    case 'auth-failed':
      return {
        fsm: { state: 'auth-failed', attempt: fsm.attempt + 1, error: 'The server rejected the token' },
        effects: [{ type: 'disconnect' }, ...down, { type: 'schedule-retry', ms: AUTH_RETRY_MS }],
      };
    case 'wrong-server':
      return {
        fsm: { state: 'wrong-server', attempt: fsm.attempt + 1, error: 'This URL now reaches a different remotea server' },
        effects: [{ type: 'disconnect' }, ...down, { type: 'schedule-retry', ms: AUTH_RETRY_MS }],
      };
    case 'incompatible':
      return { fsm: { state: 'incompatible', attempt: 0, error: ev.error }, effects: [{ type: 'cancel-retry' }, { type: 'disconnect' }, ...down] };
    case 'retry':
      if (fsm.state !== 'reconnecting' && fsm.state !== 'auth-failed' && fsm.state !== 'wrong-server') return { fsm, effects: [] };
      return { fsm: { ...fsm, state: 'connecting' }, effects: [{ type: 'connect' }] };
    case 'suspend':
      if (fsm.state === 'disabled' || fsm.state === 'incompatible') return { fsm, effects: [] };
      return { fsm: { state: 'suspended', attempt: 0 }, effects: [{ type: 'cancel-retry' }, { type: 'disconnect' }, ...down] };
    case 'wake':
      // Sleep, resume, unlock, focus: try right away instead of waiting out a backoff.
      if (fsm.state === 'suspended' || fsm.state === 'reconnecting') {
        return { fsm: { state: 'connecting', attempt: 0 }, effects: [{ type: 'cancel-retry' }, { type: 'connect' }] };
      }
      return { fsm, effects: [] };
  }
}

/** The state shown to the user (handshaking is just connecting). */
export function publicState(state: FsmState): HostConnState {
  return state === 'handshaking' ? 'connecting' : state;
}

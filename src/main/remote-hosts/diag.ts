/**
 * App diagnostics for the remote host's log (`remotea logs` on the server).
 *
 * Anything worth knowing when a remote pane misbehaves — connection state,
 * how each pane reattached, resyncs, seq gaps, agent-state verdicts, errors —
 * is recorded here and shipped to a host that announced 'diag' in its welcome
 * (RemoteHosts.flushDiag). Never terminal content, keystrokes or prompts: every
 * field is a short scalar, and callers pass ids and states, not text.
 *
 * Held in memory while no host is connected (bounded), so what happened during
 * a disconnect still arrives once the connection is back.
 */
import type { DiagEvent } from '../../shared/remote-host-protocol';

const MAX_QUEUED = 2000;
const MAX_FIELDS = 16;
const MAX_STRING = 300;

const queue: DiagEvent[] = [];
let dropped = 0;

type Scalar = string | number | boolean | null;

function clamp(data: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(data).slice(0, MAX_FIELDS)) {
    if (v === undefined) continue;
    if (v === null || typeof v === 'boolean') out[k.slice(0, 64)] = v;
    else if (typeof v === 'number') out[k.slice(0, 64)] = Number.isFinite(v) ? v : String(v);
    else out[k.slice(0, 64)] = String(v).slice(0, MAX_STRING);
  }
  return out;
}

export function diag(kind: string, data?: Record<string, unknown>, surf?: string, src: DiagEvent['src'] = 'main'): void {
  const event: DiagEvent = { at: Date.now(), src, kind: kind.slice(0, 64) };
  if (surf) event.surf = surf.slice(0, 128);
  if (data) event.data = clamp(data);
  queue.push(event);
  if (queue.length > MAX_QUEUED) {
    dropped += queue.length - MAX_QUEUED;
    queue.splice(0, queue.length - MAX_QUEUED);
  }
}

/** Up to `max` queued events, oldest first, removed from the queue. */
export function takeDiag(max: number): DiagEvent[] {
  if (dropped) {
    queue.unshift({ at: Date.now(), src: 'main', kind: 'diag.dropped', data: { count: dropped } });
    dropped = 0;
  }
  return queue.splice(0, max);
}

/** Put events back at the front (a send that could not happen). */
export function requeueDiag(events: DiagEvent[]): void {
  queue.unshift(...events);
  if (queue.length > MAX_QUEUED) queue.length = MAX_QUEUED;
}

export function diagQueued(): number {
  return queue.length;
}

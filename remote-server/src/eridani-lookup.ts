/**
 * The host assistant's read-only view of Eridani: runs, one run, tasks and
 * the Needs you list, asked over the existing link (`lookup.request` →
 * `lookup.response`). No new key and no MCP client: the link is already
 * authenticated. Ephemeral like context.request: never spooled, never
 * resent, and a late answer is dropped by the link.
 */
import crypto from 'crypto';
import {
  ERIDANI_TIMING,
  type LookupRequestBody,
} from '../../src/shared/eridani-link-protocol';

export type LookupQuery =
  | { what: 'runs'; active: boolean }
  | { what: 'run'; runId: string }
  | { what: 'tasks'; query: string | null; status: 'open' | 'done' | 'all' }
  | { what: 'needs_you' };

/** What the assistant is told; never a throw. */
export type LookupOutcome =
  | { status: 'ok'; data: unknown }
  | { status: 'error'; error: string }
  | { status: 'not_linked' }
  | { status: 'unsupported' }
  | { status: 'timeout' };

/** The part of EridaniLink a lookup needs. */
export interface LookupLink {
  readonly ready: boolean;
  peerHas(cap: string): boolean;
  request(
    body: Record<string, unknown> & { t: string; req_id: string },
    ms: number,
  ): Promise<Record<string, unknown> | null>;
}

/** How many runs or tasks one lookup asks for (Eridani accepts 1..25). */
export const LOOKUP_LIMIT = 10;
/** The JSON handed to the model, in characters. */
export const LOOKUP_DATA_CHARS = 16_000;

export function lookupBody(query: LookupQuery, reqId: string): LookupRequestBody {
  const base = { t: 'lookup.request' as const, req_id: reqId };
  switch (query.what) {
    case 'runs':
      return { ...base, what: 'runs', active: query.active, limit: LOOKUP_LIMIT };
    case 'run':
      return { ...base, what: 'run', run_id: query.runId };
    case 'tasks':
      return {
        ...base,
        what: 'tasks',
        ...(query.query ? { query: query.query.slice(0, 200) } : {}),
        status: query.status,
        limit: LOOKUP_LIMIT,
      };
    case 'needs_you':
      return { ...base, what: 'needs_you' };
  }
}

export async function lookup(
  link: LookupLink | null,
  query: LookupQuery,
  ms: number = ERIDANI_TIMING.lookupMs,
): Promise<LookupOutcome> {
  if (!link || !link.ready) return { status: 'not_linked' };
  if (!link.peerHas('lookup')) return { status: 'unsupported' };
  const res = await link.request(
    lookupBody(query, crypto.randomUUID()) as unknown as Record<string, unknown> & { t: string; req_id: string },
    ms,
  );
  if (!res) return { status: 'timeout' };
  if (res.ok !== true)
    return {
      status: 'error',
      error:
        typeof res.error === 'string' && res.error.trim()
          ? res.error.trim().slice(0, 300)
          : 'Eridani could not answer this lookup.',
    };
  return { status: 'ok', data: res.data ?? null };
}

/**
 * Keep the JSON the model sees within `max` characters. A top-level list
 * (runs, tasks, items) loses its last entries first, so what remains is still
 * whole JSON; only when that is not enough does it become a cut string.
 */
export function capLookupData(
  data: unknown,
  max = LOOKUP_DATA_CHARS,
): { data: unknown; truncated: boolean } {
  const size = (value: unknown) => (JSON.stringify(value) ?? 'null').length;
  if (size(data) <= max) return { data: data ?? null, truncated: false };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const copy: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    const lists = Object.keys(copy).filter((key) => Array.isArray(copy[key]));
    for (const key of lists) copy[key] = [...(copy[key] as unknown[])];
    while (size(copy) > max) {
      const longest = lists
        .filter((key) => (copy[key] as unknown[]).length > 0)
        .sort((a, b) => size(copy[b]) - size(copy[a]))[0];
      if (!longest) break;
      (copy[longest] as unknown[]).pop();
    }
    if (size(copy) <= max) return { data: copy, truncated: true };
  }
  return { data: (JSON.stringify(data) ?? '').slice(0, max), truncated: true };
}

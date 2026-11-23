import type { SharedTerminal } from '../../shared/remote-console-protocol';
import { SURFACE_ID_RE } from '../../shared/remote-console-protocol';
import { capText, sanitizeComposerText } from '../../shared/remote-input';

type Observed = Pick<SharedTerminal, 'terminalIdentity' | 'source' | 'readable' | 'lastInteractedAt'>
  & Partial<Pick<SharedTerminal, 'state' | 'kind' | 'summary' | 'attention'>>;

function label(s: unknown, max = 200): string {
  return typeof s === 'string' ? capText(sanitizeComposerText(s).replace(/\s+/g, ' ').trim(), max) : '';
}

function attentionOf(value: unknown): SharedTerminal['attention'] {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  return (a.kind === 'needs_you' || a.kind === 'finished') && typeof a.at === 'number' && a.at > 0 &&
    Number.isSafeInteger(a.at) && typeof a.revision === 'number' && Number.isSafeInteger(a.revision) && a.revision > 0
    ? { kind: a.kind, revision: a.revision, at: a.at } : null;
}

/** Renderer data supplies presentation only. Process identity, availability,
 * upstream identity and visit time come from the authenticated main process. */
export function buildSharedTerminals(windows: ReadonlyArray<readonly unknown[]>, observe: (s: string) => Observed | null): SharedTerminal[] {
  const rows = new Map<string, SharedTerminal>();
  for (const list of windows) for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.s !== 'string' || !SURFACE_ID_RE.test(r.s) || rows.has(r.s) ||
        !label(r.workspaceId) || !label(r.workspaceTitle)) continue;
    const info = observe(r.s);
    if (!info) continue;
    const attention = info.attention === undefined ? attentionOf(r.attention) : info.attention;
    const state = info.state ?? (r.state === 'question' || r.state === 'blocked' ? 'needs_you'
      : r.state === 'working' ? 'working' : r.state === 'idle' ? 'idle' : 'unknown');
    rows.set(r.s, { s: r.s, label: label(r.label) || 'Terminal', workspaceId: label(r.workspaceId),
      workspaceTitle: label(r.workspaceTitle), kind: label(info.kind ?? r.kind, 64) || null,
      state: state === 'idle' && attention?.kind === 'finished' ? 'finished' : state,
      summary: label(info.summary, 700) || null, attention,
      lastInteractedAt: info.lastInteractedAt, terminalIdentity: info.terminalIdentity,
      source: info.source, readable: info.readable, writable: false });
  }
  return [...rows.values()].sort((a, b) =>
    (b.lastInteractedAt ?? 0) - (a.lastInteractedAt ?? 0) ||
    a.workspaceTitle.localeCompare(b.workspaceTitle) || a.label.localeCompare(b.label) || a.s.localeCompare(b.s));
}

/**
 * remotea → Eridani: the link from a run's terminal tab back to the run in
 * Eridani's web app ("Open in Eridani", "Copy run link").
 *
 * The server records Eridani's web URL on the session's binding
 * (`SessionRecord.eridani.webUrl`, remote-server dispatch.ts); the run opens
 * at `<webUrl>/?view=remotea&run=<runId>`, the same deep link Eridani's push
 * notifications use. Only an http(s) URL is ever built: the result goes to
 * `shell.openExternal`, where any other scheme could launch a local program.
 *
 * Pure: no Node, DOM or Electron imports.
 */
import type { EridaniBinding, SessionRecord } from './remote-host-protocol';

/** What the tab shows and links to; null for a session Eridani did not start. */
export interface EridaniTabLink {
  /** `<webUrl>/?view=remotea&run=<runId>` */
  url: string;
  runId: string;
  taskId: string | null;
  taskTitle: string | null;
  generation: number;
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The run's page in Eridani, or null when the web URL is missing or not
 * http(s) (or carries credentials), or the run id is not a plain id.
 */
export function eridaniRunUrl(webUrl: unknown, runId: unknown): string | null {
  if (typeof webUrl !== 'string' || typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
  let u: URL;
  try {
    u = new URL(webUrl);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return `${base}/?view=remotea&run=${encodeURIComponent(runId)}`;
}

/** The link for a session record's Eridani binding, or null. */
export function eridaniTabLink(rec: Pick<SessionRecord, 'eridani'> | null | undefined): EridaniTabLink | null {
  const b: EridaniBinding | undefined = rec?.eridani;
  if (!b) return null;
  const url = eridaniRunUrl(b.webUrl, b.runId);
  if (!url) return null;
  return {
    url,
    runId: b.runId,
    taskId: b.taskId ?? null,
    taskTitle: typeof b.taskTitle === 'string' && b.taskTitle ? b.taskTitle : null,
    generation: b.generation,
  };
}

/** The tooltip for the tab's link button. */
export function eridaniTabTitle(link: EridaniTabLink): string {
  return link.taskTitle ? `Open in Eridani: ${link.taskTitle}` : 'Open this run in Eridani';
}

/** The link for surface `id` among registry views, or null. */
export function eridaniLinkForSurface(
  views: ReadonlyArray<{ sessions: ReadonlyArray<Pick<SessionRecord, 'id' | 'eridani'>> }> | null | undefined,
  id: string,
): EridaniTabLink | null {
  for (const v of views ?? []) {
    const rec = v.sessions.find((s) => s.id === id);
    if (rec) return eridaniTabLink(rec);
  }
  return null;
}

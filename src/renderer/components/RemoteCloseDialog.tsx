import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { getStoredWorkspaceLabel } from './SplitPane/use-osc-title';
import { useRemoteHosts } from '../remote-sessions/status';
import { latestRemoteViews } from '../remote-sessions/registry-cache';
import { describeHostSummary, summarizeRemoteClose, summaryHeadline } from '../remote-sessions/close-summary';
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';

/**
 * remotea: the one place a user close gesture can end sessions on a remote
 * host (A-N2). Every close of a workspace or tab holding remote sessions —
 * sidebar ×, context menu, Ctrl+Shift+W, tab ×, Ctrl+W, pane × — is parked in
 * `pendingRemoteClose` by the store and lands here, whatever the
 * `confirmWorkspaceClose` preference says. Two distinct answers:
 *  - Hide on this device: device-local; nothing is sent to the server but a hide.
 *  - End sessions on this host: closes them (a workspace: its whole server
 *    group) on every device, hidden ones and Eridani runs included.
 * The body lists, per host, what ending would stop. CLI/agent closes never
 * come here. Quitting the app only detaches and never asks.
 */
export default function RemoteCloseDialog() {
  const head = useStore((s) => s.pendingRemoteClose[0]);
  const queued = useStore((s) => s.pendingRemoteClose.length);
  const workspace = useStore((s) => (head ? s.workspaces.find((w) => w.id === head.workspaceId) : undefined));
  const defaultShell = useStore((s) => s.workspacePrefs.defaultShell);
  const resolve = useStore((s) => s.resolveRemoteClose);
  const hosts = useRemoteHosts((s) => s.hosts);
  const [views, setViews] = useState<RemoteRegistryView[] | null>(() => latestRemoteViews());
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = !!head;

  // Fresh registry on open: the counts must describe what End would stop now.
  useEffect(() => {
    if (!open) return;
    setViews(latestRemoteViews());
    let alive = true;
    const bridge = (window as { wmux?: { remoteSessions?: { views?: () => Promise<RemoteRegistryView[]> } } }).wmux?.remoteSessions;
    bridge?.views?.().then((v) => { if (alive) setViews(v); }).catch(() => {});
    return () => { alive = false; };
  }, [open, head]);

  // Cancel is the safe default: a stray Enter must not end anything.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open, head]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        resolve('cancel');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, resolve]);

  // The workspace vanished while queued (closed elsewhere): drop the request.
  useEffect(() => {
    if (head && !workspace) resolve('cancel');
  }, [head, workspace, resolve]);

  if (!head || !workspace) return null;

  const hostNames: Record<string, string> = {};
  for (const [id, h] of Object.entries(hosts)) hostNames[id] = h.name;
  const summary = summarizeRemoteClose({ request: head, workspace, defaultShell, views, hostNames });
  const name = getStoredWorkspaceLabel(workspace) || 'this workspace';
  const isWorkspace = head.scope === 'workspace';
  const single = !isWorkspace && head.surfaceIds.length === 1;
  const title = isWorkspace
    ? `Close "${name}"?`
    : single ? 'Close this remote tab?' : `Close ${head.surfaceIds.length} tabs?`;
  const endLabel = isWorkspace ? 'End sessions on this host' : single ? 'End session on this host' : 'End sessions on this host';

  return (
    <div className="confirm-dialog__overlay" onClick={() => resolve('cancel')}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid="remote-close-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog__title">{title}</div>
        <div className="confirm-dialog__message">
          <p>{summaryHeadline(summary, head.scope)}</p>
          {summary.map((h) => (
            <div key={h.hostId} className="remote-close__host" style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>
              {describeHostSummary(h).map((line, i) => (
                <div key={i} style={i === 0 ? { fontWeight: 600 } : undefined}>{line}</div>
              ))}
            </div>
          ))}
          <p>
            <strong>Hide on this device</strong> removes {isWorkspace ? 'it' : single ? 'the tab' : 'the tabs'} from this
            device only: the sessions keep running and stay on your other devices (Settings → Remote hosts lists
            hidden sessions to bring back).
          </p>
          <p>
            <strong>{endLabel}</strong> stops {isWorkspace ? 'every session in this workspace' : single ? 'the session' : 'the sessions'} on
            every device{isWorkspace ? ', including the ones hidden here and agent runs' : ''}.
          </p>
          {queued > 1 && <p>{queued - 1} more to decide after this one.</p>}
        </div>
        <div className="confirm-dialog__actions">
          <button ref={cancelRef} className="confirm-dialog__btn" onClick={() => resolve('cancel')}>
            Cancel
          </button>
          <button className="confirm-dialog__btn" onClick={() => resolve('hide')}>
            Hide on this device
          </button>
          <button className="confirm-dialog__btn confirm-dialog__btn--danger" onClick={() => resolve('end')}>
            {endLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

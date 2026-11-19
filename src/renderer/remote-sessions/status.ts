/**
 * remotea: connection status of every remote host, for the pane overlay, the
 * sidebar badge and Settings. Its own tiny store: it changes with the network,
 * not with the layout, and nothing about it is persisted.
 */
import { create } from 'zustand';
import type { HostDTO, HostStatus } from '../../shared/remote-hosts-types';

interface RemoteHostsState {
  /** False until the first list() answer, so "unknown host" is not claimed too early. */
  loaded: boolean;
  /** A failed list is unknown configuration, not evidence that a saved host was removed. */
  loadError?: boolean;
  hosts: Record<string, Pick<HostDTO, 'id' | 'name' | 'url' | 'enabled' | 'hasToken' | 'unencryptedAcknowledged'>>;
  status: Record<string, HostStatus>;
}

export const useRemoteHosts = create<RemoteHostsState>(() => ({ loaded: false, hosts: {}, status: {} }));

type Bridge = {
  list(): Promise<HostDTO[]>;
  onStatus(cb: (s: HostStatus) => void): () => void;
  reconnect(): void;
};

function bridge(): Bridge | null {
  return (globalThis as { window?: { remotea?: { remoteHosts?: Bridge } } }).window?.remotea?.remoteHosts ?? null;
}

let started = false;

/** Idempotent: subscribe to status pushes and load the host list once per window. */
export function startRemoteHostStatus(): void {
  const b = bridge();
  if (started || !b) return;
  started = true;
  b.onStatus((s) => useRemoteHosts.setState((st) => ({ status: { ...st.status, [s.hostId]: s } })));
  void refreshRemoteHosts();
}

export async function refreshRemoteHosts(): Promise<void> {
  const b = bridge();
  if (!b) return;
  try {
    const list = await b.list();
    const hosts: RemoteHostsState['hosts'] = {};
    const status: RemoteHostsState['status'] = {};
    for (const h of list) {
      hosts[h.id] = { id: h.id, name: h.name, url: h.url, enabled: h.enabled, hasToken: h.hasToken, unencryptedAcknowledged: h.unencryptedAcknowledged };
      status[h.id] = h.status;
    }
    useRemoteHosts.setState({ loaded: true, loadError: false, hosts, status });
  } catch {
    useRemoteHosts.setState({ loaded: true, loadError: true });
  }
}

/**
 * Remote panes this device is only VIEWING: another device sets the terminal's
 * size (the last one focused or typed in), so the pane shows it at that size,
 * scaled down to fit (useTerminal's fit()), with a badge saying so.
 */
export interface RemoteView {
  cols: number;
  rows: number;
  ownerName?: string;
}

export const useRemoteViews = create<{ views: Record<string, RemoteView> }>(() => ({ views: {} }));

export function setRemoteView(surfaceId: string, view: RemoteView | null): void {
  useRemoteViews.setState((st) => {
    const cur = st.views[surfaceId];
    if (!view) {
      if (!cur) return st;
      const { [surfaceId]: _gone, ...rest } = st.views;
      return { views: rest };
    }
    if (cur && cur.cols === view.cols && cur.rows === view.rows && cur.ownerName === view.ownerName) return st;
    return { views: { ...st.views, [surfaceId]: view } };
  });
}

export function reconnectRemoteHosts(): void {
  bridge()?.reconnect();
}

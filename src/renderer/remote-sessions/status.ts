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
  hosts: Record<string, Pick<HostDTO, 'id' | 'name' | 'url' | 'enabled' | 'hasToken'>>;
  status: Record<string, HostStatus>;
}

export const useRemoteHosts = create<RemoteHostsState>(() => ({ loaded: false, hosts: {}, status: {} }));

type Bridge = {
  list(): Promise<HostDTO[]>;
  onStatus(cb: (s: HostStatus) => void): () => void;
  reconnect(): void;
};

function bridge(): Bridge | null {
  return (globalThis as { window?: { wmux?: { remoteHosts?: Bridge } } }).window?.wmux?.remoteHosts ?? null;
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
      hosts[h.id] = { id: h.id, name: h.name, url: h.url, enabled: h.enabled, hasToken: h.hasToken };
      status[h.id] = h.status;
    }
    useRemoteHosts.setState({ loaded: true, hosts, status });
  } catch {
    useRemoteHosts.setState({ loaded: true });
  }
}

export function reconnectRemoteHosts(): void {
  bridge()?.reconnect();
}

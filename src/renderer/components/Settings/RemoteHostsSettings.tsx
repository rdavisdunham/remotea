import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { refreshRemoteHosts, startRemoteHostStatus, useRemoteHosts } from '../../remote-sessions/status';
import { parseRemoteShellSpec, remoteShellSpec } from '../../../shared/remote-shell-spec';
import type { HostConnState, HostDTO, HostSaveRequest, HostTestResult, RemoteRegistryView } from '../../../shared/remote-hosts-types';
import { closeRemoteSession, unhideRemoteSession } from '../../remote-sessions/sync';
import '../../styles/remote-hosts.css';

/**
 * Settings → Remote hosts (remotea): the remotea servers this app keeps
 * terminals on. The token is write-only from here — main encrypts it and
 * never sends it back, so the field shows only whether one is stored.
 */

type Bridge = {
  save(req: HostSaveRequest): Promise<{ ok: boolean; host?: HostDTO; error?: string }>;
  remove(id: string): Promise<boolean>;
  test(req: { url: string; token?: string; id?: string }): Promise<HostTestResult>;
};

const bridge = (): Bridge | null => (window as unknown as { wmux?: { remoteHosts?: Bridge } }).wmux?.remoteHosts ?? null;

const STATE_LABEL: Record<HostConnState, string> = {
  disabled: 'Off',
  connecting: 'Connecting…',
  ready: 'Connected',
  reconnecting: 'Reconnecting…',
  'auth-failed': 'Token rejected',
  'wrong-server': 'Different server',
  incompatible: 'Incompatible',
  suspended: 'Paused (sleep)',
};

interface Draft {
  id?: string;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
}

const EMPTY: Draft = { name: '', url: 'ws://', token: '', enabled: true };

function HostEditor({ initial, hasToken, onDone }: { initial: Draft; hasToken: boolean; onDone: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const b = bridge();

  const test = async () => {
    if (!b) return;
    setBusy(true);
    setMessage(null);
    const res = await b.test({ url: draft.url, token: draft.token || undefined, id: draft.id });
    setBusy(false);
    setMessage(res.ok
      ? { ok: true, text: `Connected to ${res.serverHostname ?? 'the server'}: ${res.sessions ?? 0} session(s) running.` }
      : { ok: false, text: res.error ?? 'Failed' });
  };

  const save = async () => {
    if (!b) return;
    setBusy(true);
    setMessage(null);
    const res = await b.save({ id: draft.id, name: draft.name, url: draft.url, enabled: draft.enabled, token: draft.token ? draft.token : undefined });
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: res.error ?? 'Could not save' });
      return;
    }
    await refreshRemoteHosts();
    onDone();
  };

  return (
    <div className="remote-host-card">
      <div className="settings-row">
        <label className="settings-label">Name</label>
        <input className="settings-input" value={draft.name} placeholder="Desktop" spellCheck={false}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </div>
      <div className="settings-row">
        <label className="settings-label">URL</label>
        <input className="settings-input" value={draft.url} placeholder="ws://my-desktop:7717" spellCheck={false}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
      </div>
      <div className="settings-row">
        <label className="settings-label">Token</label>
        <input className="settings-input" type="password" value={draft.token} autoComplete="off" spellCheck={false}
          placeholder={hasToken ? '•••••••• stored (leave empty to keep)' : 'paste the output of `remotea token`'}
          onChange={(e) => setDraft({ ...draft, token: e.target.value })} />
      </div>
      <div className="settings-row">
        <label className="settings-label">Enabled</label>
        <input type="checkbox" className="settings-toggle" checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
      </div>
      <div className="remote-host-actions">
        <button className="settings-button" disabled={busy || !draft.url} onClick={test}>Test</button>
        <button className="settings-button" disabled={busy || !draft.name.trim() || !draft.url} onClick={save}>Save</button>
        <button className="settings-button" disabled={busy} onClick={onDone}>Cancel</button>
      </div>
      {message && <div className={`remote-host-message remote-host-message--${message.ok ? 'ok' : 'error'}`}>{message.text}</div>}
    </div>
  );
}

/** Sessions this device chose to hide: still running, still on other devices. */
function HiddenSessions() {
  const [views, setViews] = useState<RemoteRegistryView[]>([]);
  const load = async () => {
    const api = (window as unknown as { wmux?: { remoteSessions?: { views(): Promise<RemoteRegistryView[]> } } }).wmux?.remoteSessions;
    if (api) setViews(await api.views());
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, []);
  const rows = views.flatMap((v) => v.sessions
    .filter((s) => s.hiddenBy.includes(v.deviceId))
    .map((s) => ({ hostId: v.hostId, session: s, group: v.groups.find((g) => g.id === s.groupId)?.name })));
  if (!rows.length) return null;
  return (
    <>
      <div className="settings-divider" />
      <h3 className="settings-section-title">Hidden on this device</h3>
      <p className="settings-hint">Still running, and still open on your other devices.</p>
      {rows.map(({ hostId, session, group }) => (
        <div key={session.id} className="settings-row">
          <label className="settings-label">
            {session.title || session.agent?.provider || session.cmd || 'shell'}
            <span className="remote-host-card__url"> · {group ?? 'Inbox'} · {session.lastCwd ?? session.cwd}</span>
          </label>
          <button className="settings-button" onClick={() => { unhideRemoteSession(hostId, session.id); setTimeout(() => void load(), 400); }}>Show here</button>
          <button className="settings-button" onClick={() => {
            if (!window.confirm('Close this session on every device? Its process ends.')) return;
            closeRemoteSession(hostId, session.id);
            setTimeout(() => void load(), 400);
          }}>Close everywhere</button>
        </div>
      ))}
    </>
  );
}

export default function RemoteHostsSettings() {
  useEffect(() => {
    startRemoteHostStatus();
    void refreshRemoteHosts();
  }, []);
  const hosts = useRemoteHosts((s) => s.hosts);
  const status = useRemoteHosts((s) => s.status);
  const workspacePrefs = useStore((s) => s.workspacePrefs);
  const setWorkspacePrefs = useStore((s) => s.setWorkspacePrefs);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const list = Object.values(hosts);
  const defaultHost = parseRemoteShellSpec(workspacePrefs.defaultShell)?.hostId;

  const remove = async (id: string) => {
    if (!window.confirm('Remove this host? Its sessions keep running on the server; open tabs here stop updating.')) return;
    await bridge()?.remove(id);
    if (defaultHost === id) setWorkspacePrefs({ defaultShell: '' });
    await refreshRemoteHosts();
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Remote hosts</h3>
      <p className="settings-hint">
        Terminals on a remote host run on that machine&apos;s remotea server, so they keep running while this computer
        sleeps, loses Wi-Fi or quits. Every device connected to the same server sees the same sessions;
        each device keeps its own layout.
      </p>
      <p className="settings-hint">
        Server setup (in WSL on the host): <span className="remote-host-code">remote-server/scripts/install.sh</span>,
        then copy the URL and the output of <span className="remote-host-code">remotea token</span> here.
      </p>

      {list.map((h) => {
        const st = status[h.id]?.state ?? 'disabled';
        if (editing === h.id) {
          return (
            <HostEditor key={h.id} hasToken={h.hasToken}
              initial={{ id: h.id, name: h.name, url: h.url, token: '', enabled: h.enabled }}
              onDone={() => setEditing(null)} />
          );
        }
        return (
          <div key={h.id} className="remote-host-card">
            <div className="remote-host-card__head">
              <span className="remote-host-card__name">{h.name}</span>
              <span className="remote-host-card__url">{h.url}</span>
              <span className={`remote-host-status remote-host-status--${st}`}>
                <span className="remote-host-status__dot" />
                {STATE_LABEL[st]}
              </span>
            </div>
            {status[h.id]?.error && st !== 'ready' && (
              <div className="remote-host-message remote-host-message--error">{status[h.id]?.error}</div>
            )}
            <div className="settings-row">
              <label className="settings-label">New terminals open here by default</label>
              <input type="checkbox" className="settings-toggle" checked={defaultHost === h.id}
                onChange={(e) => setWorkspacePrefs({ defaultShell: e.target.checked ? remoteShellSpec(h.id) : '' })} />
            </div>
            <div className="remote-host-actions">
              <button className="settings-button" onClick={() => setEditing(h.id)}>Edit</button>
              <button className="settings-button" onClick={() => void remove(h.id)}>Remove</button>
            </div>
            <p className="settings-hint">
              Shell spec for profiles and workspaces: <span className="remote-host-code">{remoteShellSpec(h.id)}</span>
              {' '}or <span className="remote-host-code">{remoteShellSpec(h.id, 'claude')}</span>
            </p>
          </div>
        );
      })}

      {editing === 'new'
        ? <HostEditor initial={EMPTY} hasToken={false} onDone={() => setEditing(null)} />
        : <button className="settings-button" onClick={() => setEditing('new')}>Add remote host</button>}
      <HiddenSessions />
    </div>
  );
}

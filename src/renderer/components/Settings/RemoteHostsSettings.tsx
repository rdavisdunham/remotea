import { useT } from '../../i18n';
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { refreshRemoteHosts, startRemoteHostStatus, useRemoteHosts } from '../../remote-sessions/status';
import { parseRemoteShellSpec, remoteShellSpec } from '../../../shared/remote-shell-spec';
import type { HostDTO, HostSaveRequest, HostStatus, HostTestRequest, HostTestResult, RemoteRegistryView } from '../../../shared/remote-hosts-types';
import { classifyHostUrl } from '../../../shared/host-url';
import { closeRemoteSession, unhideRemoteSession } from '../../remote-sessions/sync';
import RemoteHostHealth from './RemoteHostHealth';
import TeaSettings from './TeaSettings';
import RemotePendingChanges from './RemotePendingChanges';
import { forgetPendingChange, pendingChanges } from '../../remote-sessions/pending-changes';
import '../../styles/remote-hosts.css';

/**
 * Settings → Remote hosts (remotea): the remotea servers this app keeps
 * terminals on. The token is write-only from here — main encrypts it and
 * never sends it back, so the field shows only whether one is stored.
 */

type Bridge = {
  save(req: HostSaveRequest): Promise<{ ok: boolean; host?: HostDTO; error?: string }>;
  remove(id: string): Promise<boolean>;
  test(req: HostTestRequest): Promise<HostTestResult>;
  dismissOutboxFailures?(hostId: string): void;
};

const bridge = (): Bridge | null => (window as unknown as { remotea?: { remoteHosts?: Bridge } }).remotea?.remoteHosts ?? null;

/** The registry views, refreshed while Settings is open (for each host's per-tab health). */
function useRegistryViews(): RemoteRegistryView[] {
  const [views, setViews] = useState<RemoteRegistryView[]>([]);
  useEffect(() => {
    const api = (window as unknown as { remotea?: { remoteSessions?: { views(): Promise<RemoteRegistryView[]> } } }).remotea?.remoteSessions;
    if (!api) return;
    let live = true;
    const load = () => void api.views().then((v) => { if (live) setViews(v); }, () => {});
    load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return views;
}

/** Ticks every few seconds so "last seen 5 min ago" stays true. */
function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const OUTBOX_LABEL: Record<NonNullable<HostStatus['outbox']>['failed'][number]['t'], string> = {
  close: 'close',
  groupClose: 'close workspace',
  hide: 'hide',
  unhide: 'unhide',
  sessionUpdate: 'rename/move',
  groupUpsert: 'workspace edit',
};

interface Draft {
  id?: string;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
  /** "I understand this connection is unencrypted on this network" (plain ws:// off loopback and Tailscale). */
  ackUnencrypted: boolean;
}

const EMPTY: Draft = { name: '', url: 'ws://', token: '', enabled: true, ackUnencrypted: false };

/**
 * Where the URL leads, under the URL field. A plain ws:// to a non-loopback,
 * non-Tailscale address adds the acknowledgement checkbox; Save and Test stay
 * disabled until it is ticked (main enforces the same).
 */
export function HostUrlGuidance({ url, acknowledged, onAcknowledge }: { url: string; acknowledged: boolean; onAcknowledge: (v: boolean) => void }) {
  const t = useT();
  const c = classifyHostUrl(url);
  if (!c) return <p className="remote-host-url-hint">{t('remote.host.urlExpected')}</p>;
  const hint = c.kind === 'loopback' ? t('remote.host.urlLoopback') : c.kind === 'tailscale' ? t('remote.host.urlTailscale') : c.kind === 'tls' ? t('remote.host.urlTls') : t('remote.host.urlPlain').replace('{host}', c.host);
  if (!c.needsAck) return <p className="remote-host-url-hint">{hint}</p>;
  return (
    <div className="remote-host-warning" role="alert">
      {hint}
      <label>
        <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
        {t('remote.host.urlAck')}
      </label>
    </div>
  );
}

function HostEditor({ initial, hasToken, onDone }: { initial: Draft; hasToken: boolean; onDone: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const b = bridge();
  // An acknowledgement is for one URL: editing the URL asks again.
  const ackMissing = !!classifyHostUrl(draft.url)?.needsAck && !draft.ackUnencrypted;

  const test = async () => {
    if (!b) return;
    setBusy(true);
    setMessage(null);
    const res = await b.test({ url: draft.url, token: draft.token || undefined, id: draft.id, acknowledgeUnencrypted: draft.ackUnencrypted || undefined });
    setBusy(false);
    setMessage(res.ok
      ? { ok: true, text: t('remote.host.testSuccess').replace('{host}', res.serverHostname ?? draft.url).replace('{count}', String(res.sessions ?? 0)) }
      : { ok: false, text: res.error ?? t('remote.host.testFailed') });
  };

  const save = async () => {
    if (!b) return;
    setBusy(true);
    setMessage(null);
    const res = await b.save({
      id: draft.id, name: draft.name, url: draft.url, enabled: draft.enabled, token: draft.token ? draft.token : undefined,
      acknowledgeUnencrypted: draft.ackUnencrypted || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: res.error ?? t('remote.host.saveFailed') });
      return;
    }
    await refreshRemoteHosts();
    onDone();
  };

  return (
    <div className="remote-host-card">
      <div className="settings-row">
        <label className="settings-label">{t('remote.host.name')}</label>
        <input className="settings-input" value={draft.name} placeholder={t('remote.host.namePlaceholder')} spellCheck={false}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </div>
      <div className="settings-row">
        <label className="settings-label">{t('remote.host.url')}</label>
        <input className="settings-input" value={draft.url} placeholder="ws://my-desktop.tailnet-name.ts.net:7717" spellCheck={false}
          onChange={(e) => setDraft({ ...draft, url: e.target.value, ackUnencrypted: e.target.value === initial.url ? initial.ackUnencrypted : false })} />
      </div>
      <HostUrlGuidance url={draft.url} acknowledged={draft.ackUnencrypted}
        onAcknowledge={(v) => setDraft({ ...draft, ackUnencrypted: v })} />
      <div className="settings-row">
        <label className="settings-label">{t('remote.host.token')}</label>
        <input className="settings-input" type="password" value={draft.token} autoComplete="off" spellCheck={false}
          placeholder={hasToken ? t('remote.host.storedToken') : t('remote.host.pasteToken')}
          onChange={(e) => setDraft({ ...draft, token: e.target.value })} />
      </div>
      <div className="settings-row">
        <label className="settings-label">{t('remote.host.enabled')}</label>
        <input type="checkbox" className="settings-toggle" checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
      </div>
      <div className="remote-host-actions">
        <button className="settings-button" disabled={busy || !draft.url || ackMissing} onClick={test}>{t('remote.host.test')}</button>
        <button className="settings-button" disabled={busy || !draft.name.trim() || !draft.url || ackMissing} onClick={save}>{t('remote.host.save')}</button>
        <button className="settings-button" disabled={busy} onClick={onDone}>{t('remote.host.cancel')}</button>
      </div>
      {message && <div className={`remote-host-message remote-host-message--${message.ok ? 'ok' : 'error'}`}>{message.text}</div>}
    </div>
  );
}

/** Host records hidden on this device; records can be exited or stale while offline. */
function HiddenSessions() {
  const t = useT();
  const [views, setViews] = useState<RemoteRegistryView[]>([]);
  const load = async () => {
    const api = (window as unknown as { remotea?: { remoteSessions?: { views(): Promise<RemoteRegistryView[]> } } }).remotea?.remoteSessions;
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
      <h3 className="settings-section-title">{t('remote.host.hidden')}</h3>
      <p className="settings-hint">{t('remote.host.hiddenHint')}</p>
      {rows.map(({ hostId, session, group }) => (
        <div key={session.id} className="settings-row">
          <label className="settings-label">
            {session.title || session.agent?.provider || session.cmd || 'shell'}
            <span className="remote-host-card__url"> · {group ?? t('remote.host.inbox')} · {session.lastCwd ?? session.cwd}</span>
          </label>
          <button className="settings-button" onClick={() => { unhideRemoteSession(hostId, session.id); setTimeout(() => void load(), 400); }}>{t('remote.host.show')}</button>
          <button className="settings-button" onClick={() => {
            if (!window.confirm(t('remote.host.endConfirm'))) return;
            closeRemoteSession(hostId, session.id);
            setTimeout(() => void load(), 400);
          }}>{t('remote.host.end')}</button>
        </div>
      ))}
    </>
  );
}

export default function RemoteHostsSettings() {
  const t = useT();
  useEffect(() => {
    startRemoteHostStatus();
    void refreshRemoteHosts();
  }, []);
  const hosts = useRemoteHosts((s) => s.hosts);
  const status = useRemoteHosts((s) => s.status);
  const workspacePrefs = useStore((s) => s.workspacePrefs);
  const setWorkspacePrefs = useStore((s) => s.setWorkspacePrefs);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const views = useRegistryViews();
  const now = useNow();
  const list = Object.values(hosts);
  const pending = pendingChanges(hosts, status, views, t);
  const defaultHost = parseRemoteShellSpec(workspacePrefs.defaultShell)?.hostId;

  const remove = async (id: string) => {
    if (!window.confirm(t('remote.host.removeConfirm'))) return;
    await bridge()?.remove(id);
    if (defaultHost === id) setWorkspacePrefs({ defaultShell: '' });
    await refreshRemoteHosts();
  };

  const setup = (
    <ol className="remote-host-steps">
      <li>{t('remote.host.step.install')} <span className="remote-host-code">remote-server/scripts/install.sh</span></li>
      <li>{t('remote.host.step.url')}</li>
      <li>{t('remote.host.step.token')} <span className="remote-host-code">remotea token</span></li>
    </ol>
  );

  return (
    <div className="settings-section remote-hosts">
      <h3 className="settings-section-title">{t('settings.tab.hosts')}</h3>
      <p className="settings-hint settings-hint--lead">{t('remote.host.intro')}</p>

      {list.length === 0 && editing !== 'new' && (
        <div className="remote-host-empty">
          <div className="remote-host-empty__title">{t('remote.host.emptyTitle')}</div>
          {setup}
          <p className="settings-hint">{t('remote.host.tokenNote')}</p>
          <button className="settings-button settings-button--primary" onClick={() => setEditing('new')}>{t('remote.host.add')}</button>
        </div>
      )}

      {list.map((h) => {
        const hostStatus = status[h.id];
        const st = hostStatus?.state ?? 'disabled';
        if (editing === h.id) {
          return (
            <HostEditor key={h.id} hasToken={h.hasToken}
              initial={{ id: h.id, name: h.name, url: h.url, token: '', enabled: h.enabled, ackUnencrypted: !!h.unencryptedAcknowledged }}
              onDone={() => setEditing(null)} />
          );
        }
        const hostPending = pending.find((p) => p.hostId === h.id);
        return (
          <div key={h.id} className="remote-host-card" data-state={st}>
            <div className="remote-host-card__head">
              <div className="remote-host-card__identity">
                <span className="remote-host-card__name">{h.name}</span>
                <span className="remote-host-card__url">{h.url}</span>
              </div>
              <div className="remote-host-card__head-actions">
                <button className="settings-button" onClick={() => setEditing(h.id)}>{t('remote.host.edit')}</button>
                <button className="settings-button settings-button--danger" onClick={() => void remove(h.id)}>{t('remote.host.remove')}</button>
              </div>
            </div>
            <RemoteHostHealth status={hostStatus} view={views.find((v) => v.hostId === h.id)} now={now} hostName={h.name} />
            {hostStatus?.error && st !== 'ready' && (
              <div className="remote-host-message remote-host-message--error">{hostStatus.error}</div>
            )}
            {hostPending && <RemotePendingChanges host={hostPending} onForget={forgetPendingChange} />}
            {!!hostStatus?.outbox?.failed.length && (
              <div className="remote-host-message remote-host-message--error">
                {t('remote.host.notApplied')}{' '}
                {hostStatus.outbox.failed.map((f) => `${OUTBOX_LABEL[f.t]} ${f.id} (${f.state === 'expired' ? 'gave up' : f.error ?? 'refused'})`).join('; ')}
                {' '}
                <button className="settings-button" onClick={() => bridge()?.dismissOutboxFailures?.(h.id)}>{t('remote.host.dismiss')}</button>
              </div>
            )}
            <div className="remote-host-card__section">
              <div className="settings-row">
                <label className="settings-label" htmlFor={`remote-default-${h.id}`}>
                  {t('remote.host.default')}
                  <span className="settings-hint">
                    {t('remote.host.shellSpec')}{' '}<span className="remote-host-code">{remoteShellSpec(h.id)}</span>
                    {' '}{t('remote.host.or')}{' '}<span className="remote-host-code">{remoteShellSpec(h.id, 'claude')}</span>
                  </span>
                </label>
                <input id={`remote-default-${h.id}`} type="checkbox" className="settings-toggle" checked={defaultHost === h.id}
                  onChange={(e) => setWorkspacePrefs({ defaultShell: e.target.checked ? remoteShellSpec(h.id) : '' })} />
              </div>
            </div>
            <div className="remote-host-card__section">
              <TeaSettings hostId={h.id} connected={st === 'ready'}/>
            </div>
          </div>
        );
      })}

      {editing === 'new'
        ? <HostEditor initial={EMPTY} hasToken={false} onDone={() => setEditing(null)} />
        : list.length > 0 && <button className="settings-button" onClick={() => setEditing('new')}>{t('remote.host.add')}</button>}

      <details className="remote-host-about">
        <summary>{t('remote.host.aboutTitle')}</summary>
        <p className="settings-hint">{t('remote.host.lifetime')}</p>
        {list.length > 0 && <>
          <p className="settings-hint remote-host-about__sub">{t('remote.host.setupTitle')}</p>
          {setup}
        </>}
        <p className="settings-hint">{t('remote.host.tokenNote')}</p>
      </details>
      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('remote.host.eridani')}</h3>
      <div className="settings-row">
        <label className="settings-label" htmlFor="remote-group-eridani">
          {t('remote.host.group')}
          <span className="settings-hint">{t('remote.host.groupHint')}</span>
        </label>
        <input id="remote-group-eridani" type="checkbox" className="settings-toggle" checked={workspacePrefs.groupEridaniRuns !== false}
          onChange={(e) => setWorkspacePrefs({ groupEridaniRuns: e.target.checked })} />
      </div>
      <div className="settings-row">
        <label className="settings-label" htmlFor="remote-recovery-skip-clean">
          {t('remote.host.skipRecovery')}
          <span className="settings-hint">{t('remote.host.skipRecoveryHint')}</span>
        </label>
        <input id="remote-recovery-skip-clean" type="checkbox" className="settings-toggle" checked={workspacePrefs.recoverySkipClean !== false}
          onChange={(e) => setWorkspacePrefs({ recoverySkipClean: e.target.checked })} />
      </div>
      <HiddenSessions />
    </div>
  );
}

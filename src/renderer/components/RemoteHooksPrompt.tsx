import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { startRemoteHostStatus, useRemoteHosts } from '../remote-sessions/status';

/**
 * remotea: after connecting to a host whose agents (Claude Code, Codex) do not
 * report their status yet, offer to install the status hooks there — the
 * server runs `remotea hooks install` (src/main/remote-hosts, hub.ts). Shown
 * while the host's status says `hooks.prompt`; installing, "Not now" (this
 * run) and "Don't ask again" (this host) all clear that in every window.
 */
const AGENT_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

type Bridge = {
  installHooks(hostId: string): Promise<{ ok: boolean; error?: string }>;
  dismissHooksPrompt(hostId: string, forever: boolean): void;
};

function bridge(): Bridge | null {
  return (window as unknown as { wmux?: { remoteHosts?: Bridge } }).wmux?.remoteHosts ?? null;
}

function listLabels(names: string[], and: string): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

export default function RemoteHooksPrompt() {
  const t = useT();
  const hosts = useRemoteHosts((s) => s.hosts);
  const status = useRemoteHosts((s) => s.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => startRemoteHostStatus(), []);

  const hostId = Object.keys(status).find((id) => status[id].state === 'ready' && status[id].hooks?.prompt);
  if (!hostId) return null;
  const st = status[hostId];
  const missing = (st.hooks?.agents ?? []).filter((a) => a.present && !a.installed).map((a) => AGENT_LABELS[a.agent] ?? a.agent);
  const where = hosts[hostId]?.name ?? st.serverHostname ?? hostId;

  const install = async () => {
    const b = bridge();
    if (!b) return;
    setBusy(true);
    setError(null);
    const res = await b.installHooks(hostId).catch((err: unknown) => ({ ok: false, error: String(err) }));
    setBusy(false);
    // Success needs nothing here: the server's new hook status clears the prompt everywhere.
    if (!res.ok) setError(res.error ?? t('remoteHooks.failed', 'The server could not install them.'));
  };
  const dismiss = (forever: boolean) => {
    setError(null);
    bridge()?.dismissHooksPrompt(hostId, forever);
  };

  const title = t('remoteHooks.title', 'Agent status on {host}').replace('{host}', where);
  return (
    <div className="confirm-dialog__overlay" onClick={() => !busy && dismiss(false)}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog__title">{title}</div>
        <div className="confirm-dialog__message">
          {t(
            'remoteHooks.message',
            '{agents} on {server} cannot report their status to remotea yet. Install the status hooks there? Panes will then show when an agent is working, waiting on you or done, and which conversation to resume after a restart. Other hooks in those settings are kept.',
          )
            .replace('{agents}', listLabels(missing, t('remoteHooks.and', 'and')))
            .replace('{server}', st.serverHostname ?? where)}
        </div>
        {error && <div className="confirm-dialog__message confirm-dialog__error">{error}</div>}
        <div className="confirm-dialog__actions">
          <button className="confirm-dialog__btn" disabled={busy} onClick={() => dismiss(true)}>
            {t('remoteHooks.never', "Don't ask again")}
          </button>
          <button className="confirm-dialog__btn" disabled={busy} onClick={() => dismiss(false)}>
            {t('remoteHooks.later', 'Not now')}
          </button>
          <button className="confirm-dialog__btn confirm-dialog__btn--primary" disabled={busy} onClick={() => void install()}>
            {busy ? t('remoteHooks.installing', 'Installing…') : t('remoteHooks.install', 'Install')}
          </button>
        </div>
      </div>
    </div>
  );
}

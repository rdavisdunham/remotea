import { useT } from '../i18n';
import type { TranslationKey } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { useRemoteHosts } from '../remote-sessions/status';
import { RECOVERY_CHOICE_KEY, recoveryDetail, type RecoveryChoice, type RecoveryItem } from '../remote-sessions/recovery';
import { applyRecoveryChoice, dismissRecovery, settleRecoveryItem, useRecovery } from '../remote-sessions/recovery-runtime';
import '../styles/remote-hosts.css';

/**
 * remotea: the recovery inventory (task 2eeb1e23). After a start or a
 * reconnect, everything that happened on a host while this device was away
 * and needs a decision, one row each with its choices: Reopen, Keep closed,
 * Open worktree in a new terminal, Copy branch name (see
 * remote-sessions/recovery.ts). Nothing is restored or dropped behind the
 * user's back: "Done" leaves every remaining item at its first choice, which
 * never acts. Settings → Remote hosts can skip the dialog when everything
 * restores cleanly.
 */

const KIND_LABEL: Record<RecoveryItem['kind'], TranslationKey> = {
  exited: 'remote.recovery.kind.exited',
  closed: 'remote.recovery.kind.closed',
  restored: 'remote.recovery.kind.restored',
  worktree: 'remote.recovery.kind.worktree',
};

export function RecoveryItemRow({ item, hostName, onChoose, busy }: {
  item: RecoveryItem;
  hostName: string;
  onChoose: (item: RecoveryItem, choice: RecoveryChoice) => void;
  busy?: boolean;
}) {
  const t = useT();
  return (
    <div className="recovery__item" data-kind={item.kind} data-key={item.key}>
      <div className="recovery__head">
        <span className="recovery__kind">{t(KIND_LABEL[item.kind])}</span>
        <span className="recovery__title">{item.title}</span>
        <span className="recovery__host">{hostName}</span>
      </div>
      <div className="recovery__detail">{recoveryDetail(item, t)}</div>
      {item.branch && <div className="recovery__branch remote-host-code">{item.branch}</div>}
      <div className="recovery__choices">
        {item.choices.map((c, i) => (
          <button
            key={c}
            className={`confirm-dialog__btn${i === 0 ? ' recovery__default' : ''}`}
            data-choice={c}
            disabled={busy}
            onClick={() => onChoose(item, c)}
          >
            {t(RECOVERY_CHOICE_KEY[c])}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function RecoveryDialog() {
  const t = useT();
  const items = useRecovery((s) => s.items);
  const hosts = useRemoteHosts((s) => s.hosts);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const open = items.length > 0;

  useEffect(() => {
    if (open) doneRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismissRecovery();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;

  const choose = async (item: RecoveryItem, choice: RecoveryChoice) => {
    setBusy(item.key);
    try {
      const settled = await applyRecoveryChoice(item, choice);
      if (settled) settleRecoveryItem(item.key);
      else if (choice === 'copy-branch') setCopied(item.branch ?? null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="confirm-dialog__overlay" onClick={() => dismissRecovery()}>
      <div
        className="confirm-dialog recovery"
        role="dialog"
        aria-modal="true"
        aria-label={t('remote.recovery.title')}
        data-testid="recovery-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog__title">{t('remote.recovery.title')}</div>
        <div className="confirm-dialog__message">
          <p>
            {t('remote.recovery.hint').replace('{count}', String(items.length))}
          </p>
          {items.map((item) => (
            <RecoveryItemRow key={item.key} item={item} hostName={hosts[item.hostId]?.name ?? item.hostId} onChoose={choose} busy={busy === item.key} />
          ))}
          {copied && <p className="recovery__copied">{t('remote.recovery.copied').replace('{branch}', copied)}</p>}
        </div>
        <div className="confirm-dialog__actions">
          <button ref={doneRef} className="confirm-dialog__btn" onClick={() => dismissRecovery()}>
            {t('remote.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

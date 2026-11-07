import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SurfaceId } from '../../../shared/types';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import { useRemoteHosts } from '../../remote-sessions/status';
import { requestTea } from '../../remote-sessions/tea';
import { useStore } from '../../store';
import { findSurfaceOwner } from '../../store/split-utils';
import { requestFocusSurface } from '../Git/open-git';
import '../../styles/tea.css';

export default function TeaPanel({
  onClose,
  onSettings,
}: {
  onClose(): void;
  onSettings?(): void;
}) {
  const hosts = useRemoteHosts((state) => state.hosts);
  const views = useRemoteRegistry((state) => state.views);
  const [hostId, setHostId] = useState(Object.keys(hosts)[0] || '');
  const view = views?.find((item) => item.hostId === hostId);
  const tea = view?.tea;
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ id: string; text: string } | undefined>(undefined);
  const messages = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  useEffect(() => {
    if (view?.connected && view.teaAvailable && !tea)
      void requestTea(hostId, { action: 'state' });
  }, [hostId, view?.connected, view?.teaAvailable, !!tea]);
  useEffect(() => {
    if (messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [tea?.messages.length, hostId]);
  const command = async (action: Parameters<typeof requestTea>[1]) => {
    setBusy(true);
    try {
      const reply = await requestTea(hostId, action);
      setError(reply.error || '');
      return reply;
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    const input =
      pending.current?.text === text
        ? pending.current
        : { id: crypto.randomUUID(), text };
    pending.current = input;
    const reply = await command({ action: 'send', ...input });
    if (reply.ok) {
      setText('');
      pending.current = undefined;
    }
  };
  const focus = (id: string) => {
    const owner = findSurfaceOwner(
      useStore.getState().workspaces,
      id as SurfaceId,
    );
    if (owner) requestFocusSurface(owner.workspaceId, id as SurfaceId);
    else
      setError(
        'This terminal is not placed in this window. Open it through Host activity.',
      );
  };
  const active = tea?.turns.find((turn) => turn.state === 'working');
  const queued =
    tea?.turns.filter((turn) => turn.state === 'queued').length || 0;
  const recovery =
    tea?.turns.filter(
      (turn) => turn.state === 'interrupted' || turn.state === 'failed',
    ) ?? [];
  return createPortal(
    <section className="tea-panel" role="dialog" aria-label="Tea assistant">
      <header>
        <strong>Tea</strong>
        <button type="button" aria-label="Close Tea" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="tea-panel__toolbar">
        <label>
          Host
          <select
            aria-label="Tea host"
            disabled={busy}
            value={hostId}
            onChange={(event) => {
              setHostId(event.target.value);
              setError('');
              setText('');
              pending.current = undefined;
            }}
          >
            <option value="">Choose host</option>
            {Object.values(hosts).map((host) => (
              <option value={host.id} key={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            onClose();
            onSettings?.();
          }}
        >
          Configure Tea
        </button>
      </div>
      <div className="tea-panel__messages" ref={messages}>
        {!tea?.config.enabled && (
          <p>
            Enable Tea and configure its provider models in Settings → Remote
            hosts.
          </p>
        )}
        {tea?.config.enabled && !tea.modelChecks.chat && (
          <p>
            Test Tea’s conversational model in Settings → Remote hosts before
            sending messages.
          </p>
        )}
        {tea?.config.enabled &&
          tea.modelChecks.chat &&
          !tea.messages.length && (
            <p>
              Ask me where you were working, which terminals need attention, or
              to rename a terminal and set a reminder.
            </p>
          )}
        {tea?.messages.map((message) => {
          if (message.role === 'tool')
            return (
              <details
                className="tea-message tea-message--tool"
                key={message.id}
              >
                <summary>Host action</summary>
                <pre>{message.text}</pre>
              </details>
            );
          const ids = [
            ...new Set(message.text.match(/surf-[A-Za-z0-9_-]{1,96}/g) || []),
          ].filter((id) => view?.sessions.some((session) => session.id === id));
          return (
            <article
              className={`tea-message tea-message--${message.role}`}
              key={message.id}
            >
              <strong>{message.role === 'user' ? 'You' : 'Tea'}</strong>
              <p>{message.text}</p>
              {message.role === 'user' &&
                tea.turns.some(
                  (turn) => turn.id === message.id && turn.state === 'queued',
                ) && (
                  <button
                    type="button"
                    disabled={busy || !view?.connected}
                    onClick={() =>
                      void command({ action: 'cancel', id: message.id })
                    }
                  >
                    Cancel queued message
                  </button>
                )}
              {message.role === 'assistant' &&
                ids.map((id) => (
                  <button type="button" key={id} onClick={() => focus(id)}>
                    Open{' '}
                    {view?.sessions.find((session) => session.id === id)
                      ?.title ||
                      view?.sessions.find((session) => session.id === id)?.tea
                        ?.title ||
                      'terminal'}
                  </button>
                ))}
            </article>
          );
        })}
      </div>
      <div className="tea-panel__status" role="status">
        {!view?.connected
          ? 'Host disconnected'
          : !tea?.config.enabled
            ? 'Tea disabled'
            : active
              ? `Tea · ${active.phase || 'Working'}`
              : recovery.length
                ? 'Needs you · continue or cancel a saved turn'
                : queued
                  ? `${queued} message${queued === 1 ? '' : 's'} queued`
                  : 'Ready'}
        {!!tea?.backgroundPending && (
          <span>
            {' '}
            · {tea.backgroundPending} summary job
            {tea.backgroundPending === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="tea-panel__notices">
        {recovery.map((turn) => (
          <div className="tea-panel__notice" key={turn.id}>
            <span>{turn.error || 'This turn needs recovery.'}</span>
            <button
              type="button"
              disabled={busy || !view?.connected}
              onClick={() => void command({ action: 'retry', id: turn.id })}
            >
              Continue saved turn
            </button>
            <button
              type="button"
              disabled={busy || !view?.connected}
              onClick={() => void command({ action: 'cancel', id: turn.id })}
            >
              Cancel turn
            </button>
          </div>
        ))}
        {error && (
          <p className="tea-panel__notice" role="alert">
            {error}
          </p>
        )}
        {tea?.backgroundError && (
          <div className="tea-panel__notice">
            <span>{tea.backgroundError}</span>
            <button
              type="button"
              disabled={busy || !view?.connected}
              onClick={() => void command({ action: 'refresh' })}
            >
              Retry summaries
            </button>
          </div>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="tea-message">Message Tea</label>
        <textarea
          id="tea-message"
          value={text}
          maxLength={8000}
          onChange={(event) => setText(event.target.value)}
          placeholder="Where was I fixing the login settings?"
          disabled={busy || !view?.connected || !tea?.config.enabled}
        />
        <div className="tea-actions">
          <button
            type="submit"
            disabled={
              busy ||
              !text.trim() ||
              !view?.connected ||
              !tea?.config.enabled ||
              !tea?.modelChecks.chat
            }
          >
            Send
          </button>
          <button
            type="button"
            disabled={busy || !view?.connected}
            onClick={() => void command({ action: 'state' })}
          >
            Refresh
          </button>
          {active && (
            <button
              type="button"
              disabled={busy || !view?.connected}
              onClick={() => void command({ action: 'cancel', id: active.id })}
            >
              Stop turn
            </button>
          )}
        </div>
      </form>
    </section>,
    document.body,
  );
}

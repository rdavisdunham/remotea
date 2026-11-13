import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SurfaceId } from '../../../shared/types';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import { useRemoteHosts } from '../../remote-sessions/status';
import { requestTea } from '../../remote-sessions/tea';
import { useStore } from '../../store';
import { findSurfaceOwner } from '../../store/split-utils';
import { requestFocusSurface } from '../Git/open-git';
import { highlightTerminal } from '../../utils/terminal-highlight';
import '../../styles/tea.css';

const SUGGESTIONS = [
  'Which terminals need me?',
  'Where was I working last?',
  'Name each terminal after what it is doing',
];

export default function TeaPanel({
  onClose,
  onSettings,
}: {
  onClose(): void;
  onSettings?(hostId?: string): void;
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
  const composer = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);
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
    following.current = true;
  }, [hostId]);
  // Opening the panel is asking to type; the field is disabled until Tea is ready.
  const usable = !!(view?.connected && tea?.config.enabled);
  useEffect(() => {
    if (usable) composer.current?.focus();
  }, [usable, hostId]);
  useEffect(() => {
    if (messages.current && following.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [tea?.messages, tea?.turns, hostId]);
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
  const canSend = !!(
    text.trim() &&
    !busy &&
    view?.connected &&
    tea?.config.enabled &&
    tea.modelChecks.chat
  );
  const send = async () => {
    if (!canSend) return;
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
    if (owner) {
      requestFocusSurface(owner.workspaceId, id as SurfaceId);
      highlightTerminal(id);
    } else
      setError(
        'This terminal is not placed in this window. Open it through Host activity.',
      );
  };
  const active = tea?.turns.find((turn) => turn.state === 'working');
  const responding = tea?.messages.some(
    (message) => message.delivery === 'streaming' && !!message.text,
  );
  const queued =
    tea?.turns.filter((turn) => turn.state === 'queued').length || 0;
  const recovery =
    tea?.turns.filter(
      (turn) => turn.state === 'interrupted' || turn.state === 'failed',
    ) ?? [];
  const hostList = Object.values(hosts);
  const ready = !!(view?.connected && tea?.config.enabled && tea.modelChecks.chat);
  const tone = !view?.connected || !tea?.config.enabled
    ? 'off'
    : active
      ? 'working'
      : recovery.length
        ? 'attention'
        : 'ready';
  const suggest = (value: string) => {
    setText(value);
    composer.current?.focus();
  };
  return createPortal(
    <section className="tea-panel" role="dialog" aria-label="Tea assistant">
      <header>
        <strong>Tea</strong>
        {hostList.length > 1 ? (
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
            {hostList.map((host) => (
              <option value={host.id} key={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        ) : (
          hostList[0] && <span className="tea-panel__host">on {hostList[0].name}</span>
        )}
        <span className="tea-panel__spacer" />
        <button
          type="button"
          className="tea-panel__icon"
          title="Refresh"
          disabled={busy || !view?.connected}
          onClick={() => void command({ action: 'state' })}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M13.5 2.5v3h-3" />
          </svg>
          <span className="tea-panel__sr">Refresh</span>
        </button>
        <button
          type="button"
          className="tea-panel__icon"
          title="Configure Tea"
          onClick={() => {
            onClose();
            onSettings?.(hostId);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" />
            <circle cx="11" cy="4.5" r="1.5" />
            <circle cx="5" cy="11.5" r="1.5" />
          </svg>
          <span className="tea-panel__sr">Configure Tea</span>
        </button>
        <button
          type="button"
          className="tea-panel__icon"
          aria-label="Close Tea"
          title="Close (Esc)"
          onClick={onClose}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div
        className="tea-panel__messages"
        ref={messages}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            64;
        }}
      >
        {!hostList.length && (
          <div className="tea-panel__empty">
            <h3>Tea runs on a host</h3>
            <p>Add a host in Settings → Remote hosts, then set Tea up there.</p>
          </div>
        )}
        {!!hostList.length && !tea?.config.enabled && (
          <div className="tea-panel__empty">
            <h3>Tea is off on this host</h3>
            <p>Enable Tea and configure its provider models in Settings → Tea.</p>
            <button
              type="button"
              onClick={() => {
                onClose();
                onSettings?.(hostId);
              }}
            >
              Open Tea settings
            </button>
          </div>
        )}
        {tea?.config.enabled && !tea.modelChecks.chat && (
          <div className="tea-panel__empty">
            <h3>One more step</h3>
            <p>
              Test Tea’s conversational model in Settings → Tea before sending
              messages.
            </p>
            <button
              type="button"
              onClick={() => {
                onClose();
                onSettings?.(hostId);
              }}
            >
              Open Tea settings
            </button>
          </div>
        )}
        {tea?.config.enabled &&
          tea.modelChecks.chat &&
          !tea.messages.length && (
            <div className="tea-panel__empty">
              <h3>Ask about your terminals</h3>
              <p>
                Tea can find where you were working, say which terminals need
                you, rename a terminal or set a reminder.
              </p>
              <div className="tea-panel__suggestions">
                {SUGGESTIONS.map((value) => (
                  <button type="button" key={value} onClick={() => suggest(value)}>
                    {value}
                  </button>
                ))}
              </div>
            </div>
          )}
        {tea?.messages.map((message) => {
          if (message.delivery === 'streaming' && !message.text) return null;
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
          // Tea refers to terminals by ID; people know them by name.
          const shown =
            message.role === 'assistant'
              ? ids.reduce((value, id) => {
                  const session = view?.sessions.find((item) => item.id === id);
                  return value.replaceAll(
                    id,
                    session?.title || session?.tea?.title || 'this terminal',
                  );
                }, message.text)
              : message.text;
          const queuedTurn =
            message.role === 'user' &&
            tea.turns.some(
              (turn) => turn.id === message.id && turn.state === 'queued',
            );
          return (
            <article
              className={`tea-message tea-message--${message.role}`}
              key={message.id}
            >
              <strong className="tea-panel__sr">
                {message.role === 'user' ? 'You' : 'Tea'}
              </strong>
              {message.delivery === 'interrupted' && (
                <span className="tea-message__partial">
                  Partial reply · interrupted
                </span>
              )}
              <p>
                {shown}
                {message.delivery === 'streaming' && (
                  <span className="tea-message__cursor" aria-hidden="true">
                    ▍
                  </span>
                )}
              </p>
              {queuedTurn && (
                <div className="tea-message__actions">
                  <span className="tea-message__partial">Queued</span>
                  <button
                    type="button"
                    disabled={busy || !view?.connected}
                    onClick={() =>
                      void command({ action: 'cancel', id: message.id })
                    }
                  >
                    Cancel queued message
                  </button>
                </div>
              )}
              {message.role === 'assistant' &&
                !message.delivery &&
                !!ids.length && (
                  <div className="tea-message__actions">
                    {ids.map((id) => {
                      const session = view?.sessions.find(
                        (item) => item.id === id,
                      );
                      return (
                        <button
                          type="button"
                          className="tea-message__open"
                          key={id}
                          onClick={() => focus(id)}
                        >
                          Open{' '}
                          {session?.title || session?.tea?.title || 'terminal'}
                        </button>
                      );
                    })}
                  </div>
                )}
            </article>
          );
        })}
        {view?.connected && active?.phase === 'Thinking' && (
          <div
            className="tea-thinking"
            role="status"
            aria-label={responding ? 'Tea is responding' : 'Tea is thinking'}
          >
            <span className="tea-thinking__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>{responding ? 'Responding' : 'Thinking'}</span>
          </div>
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
        <div className="tea-composer">
          <label htmlFor="tea-message" className="tea-panel__sr">
            Message Tea
          </label>
          <textarea
            id="tea-message"
            ref={composer}
            value={text}
            maxLength={8000}
            rows={2}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                void send();
              }
            }}
            aria-describedby="tea-message-hint"
            placeholder={
              ready ? 'Where was I fixing the login settings?' : 'Tea is not ready on this host'
            }
            disabled={busy || !view?.connected || !tea?.config.enabled}
          />
          <div className="tea-actions">
            {active && (
              <button
                type="button"
                disabled={busy || !view?.connected}
                onClick={() => void command({ action: 'cancel', id: active.id })}
              >
                Stop turn
              </button>
            )}
            <button type="submit" className="tea-actions__send" disabled={!canSend}>
              Send
            </button>
          </div>
        </div>
        <div className="tea-panel__foot">
          <div className="tea-panel__status" role="status" data-tone={tone}>
            {!hostList.length
              ? 'No host'
              : !view?.connected
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
          <p id="tea-message-hint" className="tea-panel__hint">
            Enter to send · Shift+Enter for a new line
          </p>
        </div>
      </form>
    </section>,
    document.body,
  );
}

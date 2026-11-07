import { useEffect, useState } from 'react';
import {
  TEA_ENDPOINTS,
  type TeaConfigurationInput,
  type TeaConnectionInput,
  type TeaModel,
  type TeaProtocol,
  type TeaReply,
  type TeaRole,
  type TeaState,
} from '../../../shared/tea';
import { requestTea } from '../../remote-sessions/tea';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import '../../styles/tea.css';

const PROVIDER_NAMES: Record<TeaProtocol, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'Compatible provider',
};

function configuredRole(role: TeaRole | null): TeaRole | null {
  return role?.model.trim() ? { ...role, model: role.model.trim() } : null;
}

function draftOf(state: TeaState): TeaConfigurationInput {
  const { revision: _revision, connections, ...config } = state.config;
  return {
    ...config,
    connections: connections.map(
      ({ hasKey: _hasKey, ...connection }) => connection,
    ),
  };
}

export default function TeaSettings({
  hostId,
  connected,
  expanded = false,
}: {
  hostId: string;
  connected: boolean;
  expanded?: boolean;
}) {
  const host = useRemoteRegistry((state) =>
    state.views?.find((view) => view.hostId === hostId),
  );
  const [local, setLocal] = useState<TeaState>();
  const shared = host?.tea;
  const state =
    shared && (!local || shared.revision >= local.revision) ? shared : local;
  const [draft, setDraft] = useState<TeaConfigurationInput>();
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [models, setModels] = useState<Record<string, TeaModel[]>>({});
  const [newProtocol, setNewProtocol] = useState<TeaProtocol>('anthropic');
  const [connectionFeedback, setConnectionFeedback] = useState<
    Record<string, { text: string; failed?: boolean }>
  >({});
  useEffect(() => {
    if (!state || dirty) return;
    setDraft(draftOf(state));
    setRevision(state.config.revision);
  }, [state?.config.revision, dirty, hostId]);
  const load = async () => {
    const reply = await requestTea(hostId, { action: 'state' });
    if (reply.state) {
      setLocal(reply.state);
      setDraft(draftOf(reply.state));
      setRevision(reply.state.config.revision);
      setDirty(false);
    }
    setMessage(reply.error || '');
  };
  const change = (patch: Partial<TeaConfigurationInput>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  };
  const updateConnection = (id: string, patch: Partial<TeaConnectionInput>) => {
    if (!draft) return;
    const previous = draft.connections.find(
      (connection) => connection.id === id,
    );
    const changingProtocol =
      !!patch.protocol && previous?.protocol !== patch.protocol;
    const automaticName =
      changingProtocol &&
      previous &&
      previous.name === PROVIDER_NAMES[previous.protocol]
        ? { name: PROVIDER_NAMES[patch.protocol!] }
        : {};
    change({
      connections: draft.connections.map((connection) =>
        connection.id === id
          ? { ...connection, ...automaticName, ...patch }
          : connection,
      ),
      ...(changingProtocol
        ? {
            chat: draft.chat?.connectionId === id ? null : draft.chat,
            background:
              draft.background?.connectionId === id ? null : draft.background,
          }
        : {}),
    });
    if ('protocol' in patch || 'baseUrl' in patch || 'apiKey' in patch) {
      setModels((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setConnectionFeedback((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };
  const save = async (): Promise<TeaReply> => {
    if (!draft) return { ok: false, error: 'Load Tea settings first.' };
    const reply = await requestTea(hostId, {
      action: 'configure',
      expectedRevision: revision,
      config: {
        ...draft,
        chat: configuredRole(draft.chat),
        background: configuredRole(draft.background),
      },
    });
    if (reply.ok && reply.state) {
      setLocal(reply.state);
      setDraft(draftOf(reply.state));
      setRevision(reply.state.config.revision);
      setDirty(false);
    }
    setMessage(reply.error || 'Saved on this host.');
    return reply;
  };
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setMessage('');
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };
  const discover = async (id: string) => {
    setConnectionFeedback((current) => ({
      ...current,
      [id]: { text: 'Testing this connection and loading models…' },
    }));
    if (dirty) {
      const saved = await save();
      if (!saved.ok) {
        setConnectionFeedback((current) => ({
          ...current,
          [id]: {
            text: saved.error || 'Could not save this connection.',
            failed: true,
          },
        }));
        return;
      }
    }
    setMessage('');
    const reply = await requestTea(hostId, {
      action: 'discover',
      connectionId: id,
    });
    if (reply.state) setLocal(reply.state);
    const catalog = [...(reply.models ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    setModels((current) => ({ ...current, [id]: catalog }));
    setConnectionFeedback((current) => ({
      ...current,
      [id]: {
        text: reply.ok
          ? catalog.length
            ? `Connection works. Found ${catalog.length} model${catalog.length === 1 ? '' : 's'}. Choose models below.`
            : 'Connection works. The provider returned no models. Enter a model ID below.'
          : `Connection test failed. ${reply.error || 'No result was received.'} You can enter a model ID manually if this provider has no catalog.`,
        failed: !reply.ok,
      },
    }));
  };
  const roleEditor = (kind: 'chat' | 'background', label: string) => {
    if (!draft) return null;
    const role = draft[kind];
    const connectionId = role?.connectionId || draft.connections[0]?.id || '';
    const catalog = models[connectionId] ?? [];
    const selectedConnection = draft.connections.find(
      (connection) => connection.id === connectionId,
    );
    const updateRole = (patch: Partial<TeaRole>) => {
      const connectionId = role?.connectionId || draft.connections[0]?.id;
      if (connectionId)
        change({
          [kind]: {
            connectionId,
            model: '',
            effort: 'auto',
            ...role,
            ...patch,
          },
        });
    };
    return (
      <fieldset className="tea-role">
        <legend>{label}</legend>
        <label>
          Connection
          <select
            className="settings-select"
            value={connectionId}
            disabled={!connectionId}
            onChange={(event) =>
              updateRole({
                connectionId: event.target.value,
                model: '',
                effort: 'auto',
              })
            }
          >
            {!connectionId && <option value="">Add a connection first</option>}
            {draft.connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Discovered models
          <select
            className="settings-select"
            aria-label={`${label} discovered model`}
            disabled={!catalog.length}
            value={
              catalog.some((model) => model.id === role?.model)
                ? role!.model
                : ''
            }
            onChange={(event) => updateRole({ model: event.target.value })}
          >
            <option value="">
              {catalog.length
                ? 'Choose a model'
                : 'Test the connection to load models'}
            </option>
            {catalog.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name === model.id
                  ? model.id
                  : `${model.name} (${model.id})`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model ID
          <input
            className="settings-input"
            disabled={!connectionId}
            value={role?.model || ''}
            placeholder="Choose above or enter a model ID"
            onChange={(event) => updateRole({ model: event.target.value })}
          />
        </label>
        {selectedConnection?.protocol === 'openai' &&
          role?.model.startsWith('claude-') && (
            <p className="settings-hint" role="status">
              Choose an OpenAI model for this OpenAI connection.
            </p>
          )}
        <label>
          Effort
          <select
            className="settings-select"
            value={role?.effort || 'auto'}
            onChange={(event) =>
              updateRole({ effort: event.target.value as TeaRole['effort'] })
            }
          >
            <option value="auto">Model default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <span className="settings-hint">
          {state?.modelChecks[kind] && !dirty
            ? 'Model capabilities verified'
            : role?.model
              ? 'Test this selection before use'
              : 'Choose a model to configure this role'}
        </span>
      </fieldset>
    );
  };
  const Container = expanded ? 'section' : 'details';
  return (
    <Container className="tea-settings">
      {!expanded && <summary>Tea assistant</summary>}
      <p className="settings-hint">
        Shared by Remotea apps connected to this host. The host stores
        credentials and runs Tea.
      </p>
      {!draft ? (
        <button
          type="button"
          className="settings-button"
          disabled={!connected}
          onClick={() => void act(load)}
        >
          Load Tea settings
        </button>
      ) : (
        <fieldset disabled={busy || !connected}>
          <label className="tea-switch">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => change({ enabled: event.target.checked })}
            />
            Enable Tea on this host
          </label>
          <label className="tea-switch">
            <input
              type="checkbox"
              checked={draft.autoName}
              onChange={(event) => change({ autoName: event.target.checked })}
            />
            Automatic names for unnamed terminals
          </label>
          <label className="tea-switch">
            <input
              type="checkbox"
              checked={draft.summaries}
              onChange={(event) => change({ summaries: event.target.checked })}
            />
            Quick terminal summaries
          </label>
          {draft.connections.map((connection) => {
            const hasSavedKey = !!state?.config.connections.find(
              (item) => item.id === connection.id,
            )?.hasKey;
            const feedback = connectionFeedback[connection.id];
            return (
              <fieldset className="tea-connection" key={connection.id}>
                <legend>{connection.name || 'Connection'}</legend>
                <label>
                  Name
                  <input
                    className="settings-input"
                    value={connection.name}
                    maxLength={100}
                    onChange={(event) =>
                      updateConnection(connection.id, {
                        name: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  API format
                  <select
                    className="settings-select"
                    value={connection.protocol}
                    onChange={(event) => {
                      const protocol = event.target
                        .value as TeaConnectionInput['protocol'];
                      updateConnection(connection.id, {
                        protocol,
                        baseUrl: TEA_ENDPOINTS[protocol],
                      });
                    }}
                  >
                    <option value="anthropic">Anthropic Messages</option>
                    <option value="openai">OpenAI Responses</option>
                    <option value="openai-compatible">
                      OpenAI-compatible Chat Completions
                    </option>
                  </select>
                </label>
                <p className="settings-hint">
                  The name is a label. API format selects which provider
                  protocol Tea uses.
                </p>
                <label>
                  Base URL
                  <input
                    className="settings-input"
                    value={connection.baseUrl}
                    placeholder="https://gateway.example/v1"
                    onChange={(event) =>
                      updateConnection(connection.id, {
                        baseUrl: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  API key
                  <input
                    className="settings-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={connection.apiKey || ''}
                    placeholder={
                      state?.config.connections.find(
                        (item) => item.id === connection.id,
                      )?.hasKey
                        ? 'Key stored on host. Leave blank to keep it.'
                        : 'Enter an API key'
                    }
                    onChange={(event) =>
                      updateConnection(connection.id, {
                        apiKey: event.target.value || undefined,
                      })
                    }
                  />
                </label>
                <p className="settings-hint" role="status">
                  {connection.apiKey === ''
                    ? 'The saved API key will be removed when you save.'
                    : connection.apiKey
                      ? 'New API key entered. Save or test the connection to store it on this host.'
                      : hasSavedKey
                        ? 'API key saved on this host. The key field stays blank after saving.'
                        : 'No API key saved on this host.'}
                </p>
                <div className="tea-actions">
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() => void act(() => discover(connection.id))}
                  >
                    Test connection and find models
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() =>
                      change({
                        connections: draft.connections.filter(
                          (item) => item.id !== connection.id,
                        ),
                        chat:
                          draft.chat?.connectionId === connection.id
                            ? null
                            : draft.chat,
                        background:
                          draft.background?.connectionId === connection.id
                            ? null
                            : draft.background,
                      })
                    }
                  >
                    Remove connection
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={!hasSavedKey || connection.apiKey === ''}
                    onClick={() =>
                      updateConnection(connection.id, { apiKey: '' })
                    }
                  >
                    Remove saved key
                  </button>
                </div>
                {feedback && (
                  <p
                    className="settings-hint tea-connection-feedback"
                    role={feedback.failed ? 'alert' : 'status'}
                  >
                    {feedback.text}
                  </p>
                )}
              </fieldset>
            );
          })}
          <p className="settings-hint">
            Test connection saves pending settings and loads the model catalog.
            Remove connection and Remove saved key take effect when saved.
          </p>
          <label>
            New provider
            <select
              aria-label="New provider"
              className="settings-select"
              value={newProtocol}
              onChange={(event) =>
                setNewProtocol(event.target.value as TeaProtocol)
              }
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="openai-compatible">
                OpenAI-compatible provider
              </option>
            </select>
          </label>
          <button
            type="button"
            className="settings-button"
            disabled={draft.connections.length >= 8}
            onClick={() => {
              const id = crypto.randomUUID();
              change({
                connections: [
                  ...draft.connections,
                  {
                    id,
                    name: PROVIDER_NAMES[newProtocol],
                    protocol: newProtocol,
                    baseUrl: TEA_ENDPOINTS[newProtocol],
                  },
                ],
                chat:
                  draft.chat ||
                  (newProtocol === 'anthropic'
                    ? {
                        connectionId: id,
                        model: 'claude-sonnet-5-5',
                        effort: 'medium',
                      }
                    : null),
                background:
                  draft.background ||
                  (newProtocol === 'anthropic'
                    ? {
                        connectionId: id,
                        model: 'claude-haiku-5-5',
                        effort: 'low',
                      }
                    : null),
              });
            }}
          >
            Add provider connection
          </button>
          {roleEditor('chat', 'Tea conversation and actions')}
          {roleEditor('background', 'Names and quick summaries')}
          <div className="tea-actions">
            <button
              type="button"
              className="settings-button"
              onClick={() => void act(save)}
            >
              Save Tea settings
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() =>
                void act(async () => {
                  if (dirty && !(await save()).ok) return;
                  const reply = await requestTea(hostId, {
                    action: 'testModels',
                  });
                  if (reply.state) setLocal(reply.state);
                  setMessage(
                    reply.error ||
                      reply.checks?.join('. ') ||
                      'Choose models to test.',
                  );
                })
              }
            >
              Test selected models
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => void act(load)}
            >
              Reload settings
            </button>
          </div>
        </fieldset>
      )}
      {(message || busy) && (
        <p className="settings-hint" role="status">
          {busy ? 'Working on this host…' : message}
        </p>
      )}
      {!!state && state.config.revision !== revision && dirty && (
        <p role="status">
          Settings changed on another device. Reload before saving your changes.
        </p>
      )}
    </Container>
  );
}

import { useEffect, useState } from 'react';
import {
  TEA_ENDPOINTS,
  type TeaConfigurationInput,
  type TeaConnectionInput,
  type TeaModel,
  type TeaRole,
  type TeaState,
} from '../../../shared/tea';
import { requestTea } from '../../remote-sessions/tea';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import '../../styles/tea.css';

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
}: {
  hostId: string;
  connected: boolean;
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
    if (draft)
      change({
        connections: draft.connections.map((connection) =>
          connection.id === id ? { ...connection, ...patch } : connection,
        ),
      });
  };
  const save = async () => {
    if (!draft) return false;
    const reply = await requestTea(hostId, {
      action: 'configure',
      expectedRevision: revision,
      config: draft,
    });
    if (reply.ok && reply.state) {
      setLocal(reply.state);
      setDraft(draftOf(reply.state));
      setRevision(reply.state.config.revision);
      setDirty(false);
    }
    setMessage(reply.error || 'Saved on this host.');
    return reply.ok;
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
    if (dirty && !(await save())) return;
    const reply = await requestTea(hostId, {
      action: 'discover',
      connectionId: id,
    });
    if (reply.models)
      setModels((current) => ({ ...current, [id]: reply.models! }));
    setMessage(
      reply.ok
        ? `Connection works. Found ${reply.models?.length ?? 0} models.`
        : `${reply.error} You can also enter a model ID manually and test the selected models.`,
    );
  };
  const roleEditor = (kind: 'chat' | 'background', label: string) => {
    if (!draft) return null;
    const role = draft[kind];
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
    const listId = `tea-${hostId}-${kind}`;
    return (
      <fieldset className="tea-role">
        <legend>{label}</legend>
        <label>
          Connection
          <select
            className="settings-select"
            value={role?.connectionId || ''}
            onChange={(event) =>
              updateRole({
                connectionId: event.target.value,
                model: '',
                effort: 'auto',
              })
            }
          >
            <option value="">Choose connection</option>
            {draft.connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <input
            className="settings-input"
            list={listId}
            value={role?.model || ''}
            placeholder="Pick a discovered model or enter its ID"
            onChange={(event) => updateRole({ model: event.target.value })}
          />
          <datalist id={listId}>
            {(models[role?.connectionId || ''] ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </datalist>
        </label>
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
            : 'Test this selection before use'}
        </span>
      </fieldset>
    );
  };
  return (
    <details className="tea-settings">
      <summary>Tea assistant</summary>
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
          {draft.connections.map((connection) => (
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
              </div>
            </fieldset>
          ))}
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
                    name: 'Anthropic',
                    protocol: 'anthropic',
                    baseUrl: TEA_ENDPOINTS.anthropic,
                  },
                ],
                chat: draft.chat || {
                  connectionId: id,
                  model: 'claude-sonnet-5-5',
                  effort: 'medium',
                },
                background: draft.background || {
                  connectionId: id,
                  model: 'claude-haiku-5-5',
                  effort: 'low',
                },
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
                  if (dirty && !(await save())) return;
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
    </details>
  );
}

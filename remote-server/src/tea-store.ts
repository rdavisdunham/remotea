/** Private, atomic host persistence for Tea credentials, evidence and execution checkpoints. */
import fs from 'fs';
import path from 'path';
import type {
  TeaConfiguration,
  TeaConfigurationInput,
  TeaConnectionInput,
  TeaMessage,
  TeaRole,
  TeaState,
  TeaTurn,
} from '../../src/shared/tea';
import { writePrivate } from './eridani-mcp';
import type { TeaCall, TeaCompletion } from './tea-provider';

export interface TeaExchange {
  id: string;
  at: number;
  prompt: string;
  reply: string;
}
export interface TeaEvidence {
  source: string;
  version: string;
  sourceAt: number;
  prompt: string;
  reply: string;
  /** Latest ten root exchanges, retained between background updates. */
  recent?: TeaExchange[];
  /** Source-local completed exchange count. Older saved evidence starts at one. */
  exchanges?: number;
  /** Distilled context carried forward by the background model. */
  memory?: string;
  /** Count covered by memory. New captures can arrive during generation. */
  summarizedExchanges?: number;
}
export interface TeaCallReceipt extends TeaCall {
  fence: string;
  result?: unknown;
  applied?: boolean;
}
export interface SavedTeaTurn extends TeaTurn {
  device: string;
  text: string;
  started?: boolean;
  draftMessageId?: string;
  rounds: number;
  pending?: TeaCompletion;
  receipts: Record<string, TeaCallReceipt>;
}
export interface TeaSaved {
  version: 1;
  revision: number;
  config: TeaConfiguration;
  keys: Record<string, string>;
  messages: TeaMessage[];
  turns: SavedTeaTurn[];
  history: unknown[];
  profile: string;
  evidence: Record<string, TeaEvidence>;
  backgroundError?: string;
  validated?: Record<string, string>;
  inputReceipts?: Record<string, string>;
}

function initial(): TeaSaved {
  return {
    version: 1,
    revision: 0,
    config: {
      revision: 0,
      enabled: false,
      connections: [],
      chat: null,
      background: null,
      autoName: true,
      summaries: true,
    },
    keys: {},
    messages: [],
    turns: [],
    history: [],
    profile: '',
    evidence: {},
  };
}

export class TeaStore {
  data: TeaSaved;
  constructor(private readonly file: string | null) {
    this.data = initial();
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as TeaSaved;
      if (
        saved.version !== 1 ||
        !saved.config ||
        !Array.isArray(saved.turns) ||
        !Array.isArray(saved.messages) ||
        !saved.evidence ||
        !saved.keys ||
        !Array.isArray(saved.history)
      )
        throw new Error('Invalid Tea state');
      this.data = saved;
      for (const message of this.data.messages)
        if (message.delivery === 'streaming') message.delivery = 'interrupted';
      for (const turn of this.data.turns)
        if (turn.state === 'working') {
          turn.state = 'interrupted';
          turn.error =
            'The host restarted. Continue this saved turn to reconcile its actions.';
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Tea state is unreadable. Restore its private state file before enabling Tea.',
        );
    }
  }

  save(): void {
    if (!this.file) return;
    writePrivate(this.file, JSON.stringify(this.data));
    const descriptor = fs.openSync(this.file, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const directory = fs.openSync(path.dirname(this.file), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }

  public(pending: number): TeaState {
    return {
      revision: this.data.revision,
      config: structuredClone(this.data.config),
      messages: structuredClone(this.data.messages.slice(-180)),
      turns: this.data.turns
        .slice(-80)
        .map(({ id, state, phase, error }) => ({ id, state, phase, error })),
      backgroundPending: pending,
      backgroundError: this.data.backgroundError,
      modelChecks: { chat: false, background: false },
    };
  }

  connection(role: TeaRole): TeaConnectionInput {
    const connection = this.data.config.connections.find(
      (item) => item.id === role.connectionId,
    );
    const apiKey = this.data.keys[role.connectionId];
    if (!connection || !apiKey)
      throw new Error(
        'Configure a provider connection and API key in Tea settings.',
      );
    return {
      id: connection.id,
      name: connection.name,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      apiKey,
    };
  }

  configure(input: TeaConfigurationInput, expectedRevision: number): void {
    if (expectedRevision !== this.data.config.revision)
      throw new Error(
        'Tea settings changed on another device. Reload them before saving.',
      );
    if (
      !input ||
      typeof input !== 'object' ||
      !Array.isArray(input.connections) ||
      input.connections.length > 8
    )
      throw new Error('Use up to eight Tea connections.');
    if (
      typeof input.enabled !== 'boolean' ||
      typeof input.autoName !== 'boolean' ||
      typeof input.summaries !== 'boolean'
    )
      throw new Error('Invalid Tea switches.');
    const keys: Record<string, string> = {};
    const ids = new Set<string>();
    const connections = input.connections.map((connection) => {
      if (
        !connection ||
        typeof connection.id !== 'string' ||
        !/^[A-Za-z0-9_-]{8,96}$/.test(connection.id) ||
        ids.has(connection.id)
      )
        throw new Error('Use unique connection IDs.');
      ids.add(connection.id);
      if (
        typeof connection.name !== 'string' ||
        !connection.name.trim() ||
        connection.name.length > 100
      )
        throw new Error('Give each connection a short name.');
      if (
        !['anthropic', 'openai', 'openai-compatible'].includes(
          connection.protocol,
        )
      )
        throw new Error('Choose a supported API format.');
      if (
        typeof connection.baseUrl !== 'string' ||
        connection.baseUrl.length > 1000
      )
        throw new Error('Enter a provider base URL.');
      let url: URL;
      try {
        url = new URL(connection.baseUrl);
      } catch {
        throw new Error('Enter a valid provider base URL.');
      }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
        url.hostname,
      );
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      )
        throw new Error(
          'Use HTTPS for providers, or HTTP for a local gateway. Put the credential in the key field.',
        );
      if (
        connection.apiKey !== undefined &&
        (typeof connection.apiKey !== 'string' ||
          connection.apiKey.length > 8192 ||
          /[\r\n]/.test(connection.apiKey))
      )
        throw new Error('Invalid API key.');
      const key =
        connection.apiKey === undefined
          ? this.data.keys[connection.id]
          : connection.apiKey.trim();
      if (key) keys[connection.id] = key;
      return {
        id: connection.id,
        name: connection.name.trim(),
        protocol: connection.protocol,
        baseUrl: url.href.replace(/\/$/, ''),
        hasKey: !!key,
      };
    });
    const validateRole = (role: TeaRole | null): TeaRole | null => {
      if (role === null) return null;
      if (
        !role ||
        !ids.has(role.connectionId) ||
        typeof role.model !== 'string' ||
        !/^[A-Za-z0-9._:/@-]{1,200}$/.test(role.model) ||
        !['auto', 'low', 'medium', 'high'].includes(role.effort)
      )
        throw new Error(
          'Choose a connection, model ID and supported effort for each role.',
        );
      return {
        connectionId: role.connectionId,
        model: role.model,
        effort: role.effort,
      };
    };
    const config = {
      revision: expectedRevision + 1,
      enabled: input.enabled,
      connections,
      chat: validateRole(input.chat),
      background: validateRole(input.background),
      autoName: input.autoName,
      summaries: input.summaries,
    };
    const previous = this.data;
    this.data = { ...previous, config, keys };
    try {
      this.save();
    } catch (error) {
      this.data = previous;
      throw error;
    }
  }
}

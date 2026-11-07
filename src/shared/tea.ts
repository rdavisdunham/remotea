/** Tea's host API. Credentials appear only in explicit write requests. */
export type TeaProtocol = 'anthropic' | 'openai' | 'openai-compatible';
export type TeaEffort = 'auto' | 'low' | 'medium' | 'high';
export interface TeaConnection {
  id: string;
  name: string;
  protocol: TeaProtocol;
  baseUrl: string;
  hasKey: boolean;
}
export interface TeaConnectionInput extends Omit<TeaConnection, 'hasKey'> {
  apiKey?: string;
}
export interface TeaRole {
  connectionId: string;
  model: string;
  effort: TeaEffort;
}
export interface TeaConfiguration {
  revision: number;
  enabled: boolean;
  connections: TeaConnection[];
  chat: TeaRole | null;
  background: TeaRole | null;
  autoName: boolean;
  summaries: boolean;
}
export interface TeaConfigurationInput extends Omit<
  TeaConfiguration,
  'revision' | 'connections'
> {
  connections: TeaConnectionInput[];
}
export interface TeaModel {
  id: string;
  name: string;
}
export interface TeaInsight {
  title: string;
  summary: string;
  source: string;
  version: string;
  sourceAt: number;
  generatedAt: number;
}
export interface TeaMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: number;
  terminalIds?: string[];
}
export interface TeaTurn {
  id: string;
  state: 'queued' | 'working' | 'done' | 'failed' | 'interrupted' | 'canceled';
  phase?: string;
  error?: string;
}
export interface TeaState {
  revision: number;
  config: TeaConfiguration;
  messages: TeaMessage[];
  turns: TeaTurn[];
  backgroundPending: number;
  backgroundError?: string;
  modelChecks: { chat: boolean; background: boolean };
}
export type TeaCommand =
  | { action: 'state' }
  | {
      action: 'configure';
      expectedRevision: number;
      config: TeaConfigurationInput;
    }
  | { action: 'discover'; connectionId: string }
  | { action: 'testModels' }
  | { action: 'send'; id: string; text: string }
  | { action: 'retry'; id: string }
  | { action: 'cancel'; id: string }
  | { action: 'refresh'; terminalId?: string };
export interface TeaReply {
  ok: boolean;
  error?: string;
  uncertain?: boolean;
  state?: TeaState;
  models?: TeaModel[];
  checks?: string[];
}

export const TEA_ENDPOINTS: Record<TeaProtocol, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'openai-compatible': '',
};

/** Bounded envelope check shared by the IPC and host transport. Save validation runs on the host. */
export function isTeaCommand(value: unknown): value is TeaCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  const id = (v: unknown) =>
    typeof v === 'string' && /^[A-Za-z0-9_-]{8,96}$/.test(v);
  switch (command.action) {
    case 'state':
    case 'testModels':
      return true;
    case 'discover':
      return (
        typeof command.connectionId === 'string' && id(command.connectionId)
      );
    case 'send':
      return (
        id(command.id) &&
        typeof command.text === 'string' &&
        !!command.text.trim() &&
        command.text.length <= 8000
      );
    case 'retry':
    case 'cancel':
      return id(command.id);
    case 'refresh':
      return (
        command.terminalId === undefined ||
        (typeof command.terminalId === 'string' &&
          /^surf-[A-Za-z0-9_-]{1,96}$/.test(command.terminalId))
      );
    case 'configure':
      if (
        !Number.isSafeInteger(command.expectedRevision) ||
        !command.config ||
        typeof command.config !== 'object'
      )
        return false;
      try {
        return JSON.stringify(command.config).length <= 80000;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

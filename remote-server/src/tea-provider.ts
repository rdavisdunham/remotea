/** Provider wire adapters. Complete native output is retained privately for replay. */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type {
  TeaConnectionInput,
  TeaModel,
  TeaRole,
} from '../../src/shared/tea';

export interface TeaTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface TeaCall {
  id: string;
  name: string;
  input: unknown;
}
export interface TeaCompletion {
  text: string;
  calls: TeaCall[];
  output: unknown[];
  requestId?: string;
}
export interface TeaProviderRequest {
  system: string;
  history: unknown[];
  tools?: TeaTool[];
  schema?: Record<string, unknown>;
  signal: AbortSignal;
}

export const INSIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary'],
  properties: { title: { type: 'string' }, summary: { type: 'string' } },
};
export class TeaFault extends Error {}

/** Provider errors can echo request bodies and headers. Keep diagnostics deliberately bounded. */
export function providerError(error: unknown): string {
  if (error instanceof TeaFault) return error.message;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'APIUserAbortError' ||
      error.name === 'TimeoutError')
  )
    return 'The provider request was stopped or timed out.';
  const status = (error as { status?: number } | null)?.status;
  if (status === 401 || status === 403)
    return 'The provider refused this credential or model. Check the connection key and access.';
  if (status === 429)
    return 'The provider is rate-limiting this connection. Try again shortly.';
  if (status === 400 || status === 404 || status === 422)
    return 'The provider rejected this model or its selected capabilities. Check the model, effort and API format.';
  if (status && status >= 500)
    return 'The provider is temporarily unavailable.';
  return 'Could not complete the provider request. Check the endpoint and connection.';
}

export class TeaProvider {
  private anthropic?: Anthropic;
  private openai?: OpenAI;

  constructor(
    readonly connection: TeaConnectionInput,
    readonly role: TeaRole,
  ) {
    // Prevent an endpoint redirect from forwarding a credential to another destination.
    const safeFetch: typeof fetch = (input, init) =>
      fetch(input, { ...init, redirect: 'error' });
    const options = {
      apiKey: connection.apiKey!,
      baseURL: connection.baseUrl,
      maxRetries: 2,
      timeout: 90000,
      fetch: safeFetch,
    };
    if (connection.protocol === 'anthropic')
      this.anthropic = new Anthropic(options);
    else this.openai = new OpenAI(options);
  }

  async models(signal: AbortSignal): Promise<TeaModel[]> {
    if (!this.anthropic) {
      const page = await this.openai!.models.list({ signal });
      return page.data
        .slice(0, 1000)
        .map((model) => ({ id: model.id, name: model.id }));
    }
    const models: TeaModel[] = [];
    let after: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await this.anthropic.models.list(
        { limit: 100, ...(after ? { after_id: after } : {}) },
        { signal },
      );
      models.push(
        ...page.data.map((model) => ({
          id: model.id,
          name: model.display_name,
        })),
      );
      if (!page.has_more) break;
      if (!page.last_id || page.last_id === after)
        throw new Error('Invalid model pagination');
      after = page.last_id;
    }
    return models;
  }

  user(text: string): unknown {
    return { role: 'user', content: text };
  }

  results(calls: TeaCall[], results: unknown[]): unknown[] {
    if (this.anthropic)
      return [
        {
          role: 'user',
          content: calls.map((call, index) => ({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(results[index]),
          })),
        },
      ];
    if (this.connection.protocol === 'openai')
      return calls.map((call, index) => ({
        type: 'function_call_output',
        call_id: call.id,
        output: JSON.stringify(results[index]),
      }));
    return calls.map((call, index) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(results[index]),
    }));
  }

  async complete(request: TeaProviderRequest): Promise<TeaCompletion> {
    const { system, history, tools, schema, signal } = request;
    const effort = this.role.effort === 'auto' ? undefined : this.role.effort;
    if (this.anthropic) {
      const response = await this.anthropic.messages.create(
        {
          model: this.role.model,
          system,
          max_tokens: schema ? 2048 : 12000,
          messages: history as Anthropic.MessageParam[],
          ...(tools
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters as Anthropic.Tool.InputSchema,
                  strict: true,
                })),
                tool_choice: { type: 'auto' as const },
              }
            : {}),
          ...(schema || effort
            ? {
                output_config: {
                  ...(schema
                    ? { format: { type: 'json_schema' as const, schema } }
                    : {}),
                  ...(effort ? { effort } : {}),
                },
              }
            : {}),
          ...(schema && /^claude-haiku-5-5(?:-|$)/.test(this.role.model)
            ? { thinking: { type: 'disabled' as const } }
            : {}),
        },
        { signal },
      );
      if (
        response.stop_reason !== 'end_turn' &&
        response.stop_reason !== 'tool_use'
      )
        throw new TeaFault(
          'The provider stopped before a complete reply. Check the output limit and continue the turn.',
        );
      const calls = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: block.input,
        }));
      return {
        text: response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
        calls,
        output: [{ role: 'assistant', content: response.content }],
        requestId: response._request_id ?? undefined,
      };
    }
    if (this.connection.protocol === 'openai') {
      const response = await this.openai!.responses.create(
        {
          model: this.role.model,
          instructions: system,
          input: history as OpenAI.Responses.ResponseInput,
          store: false,
          include: ['reasoning.encrypted_content'],
          max_output_tokens: schema ? 4096 : 12000,
          ...(effort ? { reasoning: { effort } } : {}),
          ...(tools
            ? {
                tools: tools.map((tool) => ({
                  type: 'function' as const,
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                  strict: true,
                })),
              }
            : {}),
          ...(schema
            ? {
                text: {
                  format: {
                    type: 'json_schema' as const,
                    name: 'tea_insight',
                    schema,
                    strict: true,
                  },
                },
              }
            : {}),
        },
        { signal },
      );
      if (response.status !== 'completed')
        throw new TeaFault(
          'The provider stopped before a complete reply. Check the output limit and continue the turn.',
        );
      const calls = response.output
        .filter((item) => item.type === 'function_call')
        .map((item) => ({
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments),
        }));
      return {
        text: response.output_text,
        calls,
        output: toResponseInputItems(response.output),
        requestId: response._request_id ?? undefined,
      };
    }
    const response = await this.openai!.chat.completions.create(
      {
        model: this.role.model,
        messages: [
          { role: 'system', content: system },
          ...history,
        ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        max_tokens: schema ? 2048 : 12000,
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(tools
          ? {
              tools: tools.map((tool) => ({
                type: 'function' as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                  strict: true,
                },
              })),
            }
          : {}),
        ...(schema
          ? {
              response_format: {
                type: 'json_schema' as const,
                json_schema: { name: 'tea_insight', schema, strict: true },
              },
            }
          : {}),
      },
      { signal },
    );
    const choice = response.choices[0];
    if (
      !choice ||
      (choice.finish_reason !== 'stop' &&
        choice.finish_reason !== 'tool_calls') ||
      choice.message.refusal
    )
      throw new Error('Provider returned an incomplete or refused response');
    const calls = (choice.message.tool_calls ?? []).map((call) => {
      if (call.type !== 'function')
        throw new Error('Unsupported provider tool');
      return {
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
      };
    });
    return {
      text: choice.message.content ?? '',
      calls,
      output: [choice.message],
      requestId: response._request_id ?? undefined,
    };
  }
}

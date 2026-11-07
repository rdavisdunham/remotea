import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TeaProvider,
  INSIGHT_SCHEMA,
  providerError,
} from '../src/tea-provider';
import type { TeaConnectionInput, TeaProtocol } from '../../src/shared/tea';

const role = {
  connectionId: 'connection-one',
  model: 'claude-sonnet-5-5',
  effort: 'medium' as const,
};
const tool = {
  name: 'lookup',
  description: 'Look up a terminal.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};
const request = {
  system: 'Tea test',
  history: [{ role: 'user', content: 'Find it' }],
  tools: [tool],
  signal: AbortSignal.timeout(5000),
};
function connection(protocol: TeaProtocol): TeaConnectionInput {
  return {
    id: 'connection-one',
    name: 'Test',
    protocol,
    baseUrl:
      protocol === 'anthropic'
        ? 'https://provider.test'
        : 'https://provider.test/v1',
    apiKey: 'synthetic-api-key-for-tests',
  };
}
function network(...responses: unknown[]) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'request-id': 'request-test',
        },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function anthropic(content: unknown[], stop_reason = 'end_turn') {
  return {
    id: 'msg-test',
    type: 'message',
    role: 'assistant',
    model: role.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
function openai(output: unknown[], status = 'completed') {
  return {
    id: 'resp-test',
    object: 'response',
    created_at: 1,
    status,
    model: 'gpt-test',
    output,
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('Tea provider contracts', () => {
  it('discovers native OpenAI models through the model-list endpoint', async () => {
    const fetch = network({
      object: 'list',
      data: [
        { id: 'gpt-fixture', object: 'model', created: 1, owned_by: 'fixture' },
      ],
    });
    const provider = new TeaProvider(connection('openai'), {
      ...role,
      model: 'discovery',
      effort: 'auto',
    });
    expect(await provider.models(AbortSignal.timeout(5000))).toEqual([
      { id: 'gpt-fixture', name: 'gpt-fixture' },
    ]);
    expect(String(fetch.mock.calls[0][0])).toBe(
      'https://provider.test/v1/models',
    );
  });

  it.each(['anthropic', 'openai', 'openai-compatible'] as const)(
    'reports a %s refusal before returning tools',
    async (protocol) => {
      const refusal =
        protocol === 'anthropic'
          ? anthropic([{ type: 'text', text: 'Declined' }], 'refusal')
          : protocol === 'openai'
            ? openai([
                {
                  type: 'message',
                  id: 'refusal-message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'refusal', refusal: 'Declined' }],
                },
              ])
            : {
                id: 'refusal-chat',
                choices: [
                  {
                    finish_reason: 'stop',
                    message: {
                      role: 'assistant',
                      content: null,
                      refusal: 'Declined',
                    },
                  },
                ],
              };
      network(refusal);
      await expect(
        new TeaProvider(connection(protocol), {
          ...role,
          effort: 'auto',
        }).complete(request),
      ).rejects.toThrow('model declined');
    },
  );

  it('uses native Claude tool options and preserves signed thinking with tool results', async () => {
    const thinking = {
      type: 'thinking',
      thinking: 'opaque fixture',
      signature: 'fixture-signature',
    };
    const fetch = network(
      anthropic(
        [
          thinking,
          {
            type: 'tool_use',
            id: 'call-one',
            name: 'lookup',
            input: { query: 'login' },
          },
        ],
        'tool_use',
      ),
      anthropic([{ type: 'text', text: 'Found it' }]),
    );
    const provider = new TeaProvider(connection('anthropic'), role);
    const result = await provider.complete(request);
    expect(result.calls).toEqual([
      { id: 'call-one', name: 'lookup', input: { query: 'login' } },
    ]);
    await provider.complete({
      ...request,
      history: [
        ...request.history,
        ...result.output,
        ...provider.results(result.calls, [{ id: 'surf-test' }]),
      ],
    });
    const first = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(first.tool_choice).toEqual({ type: 'auto' });
    expect(first.tools[0].strict).toBe(true);
    expect(first.output_config.effort).toBe('medium');
    expect(first).not.toHaveProperty('temperature');
    expect(first).not.toHaveProperty('thinking');
    const next = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(next.messages[1].content[0]).toEqual(thinking);
    expect(next.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call-one',
    });
    expect(fetch.mock.calls[0][1]!.redirect).toBe('error');
  });

  it('configures Haiku background jobs with a schema and low-effort disabled thinking', async () => {
    const fetch = network(
      anthropic([
        {
          type: 'text',
          text: '{"title":"Login","summary":"Investigating sign-in","memory":"The fixture concerns saved login settings. Preserve the chosen credentials behavior and verify the pending sign-in change."}',
        },
      ]),
    );
    const provider = new TeaProvider(connection('anthropic'), {
      ...role,
      model: 'claude-haiku-5-5',
      effort: 'low',
    });
    await provider.complete({
      ...request,
      tools: undefined,
      schema: INSIGHT_SCHEMA,
    });
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toMatchObject({
      effort: 'low',
      format: { type: 'json_schema', schema: INSIGHT_SCHEMA },
    });
  });

  it('uses Responses for OpenAI and replays reasoning and phase-bearing output', async () => {
    const reasoning = {
      id: 'reason-one',
      type: 'reasoning',
      encrypted_content: 'opaque-encrypted-content',
      summary: [],
    };
    const commentary = {
      id: 'message-one',
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Looking', annotations: [] }],
    };
    const fetch = network(
      openai([
        reasoning,
        commentary,
        {
          id: 'function-one',
          type: 'function_call',
          status: 'completed',
          call_id: 'call-one',
          name: 'lookup',
          arguments: '{"query":"login"}',
        },
      ]),
      openai([
        {
          id: 'message-two',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Found it', annotations: [] }],
        },
      ]),
    );
    const provider = new TeaProvider(connection('openai'), {
      ...role,
      model: 'gpt-test',
    });
    const first = await provider.complete(request);
    const final = await provider.complete({
      ...request,
      history: [
        ...request.history,
        ...first.output,
        ...provider.results(first.calls, [{ found: true }]),
      ],
    });
    expect(final.text).toBe('Found it');
    expect(String(fetch.mock.calls[0][0])).toBe(
      'https://provider.test/v1/responses',
    );
    const body = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(body.store).toBe(false);
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          encrypted_content: 'opaque-encrypted-content',
        }),
        expect.objectContaining({ type: 'message', phase: 'commentary' }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-one',
        }),
      ]),
    );
  });

  it('keeps an explicitly selected Chat Completions gateway on its own protocol', async () => {
    const fetch = network({
      id: 'chat-test',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Hello' },
        },
      ],
    });
    const provider = new TeaProvider(connection('openai-compatible'), {
      ...role,
      model: 'gateway-model',
      effort: 'auto',
    });
    expect((await provider.complete(request)).text).toBe('Hello');
    expect(String(fetch.mock.calls[0][0])).toBe(
      'https://provider.test/v1/chat/completions',
    );
    expect(
      JSON.parse(fetch.mock.calls[0][1]!.body as string),
    ).not.toHaveProperty('reasoning_effort');
  });

  it('rejects incomplete responses before returning any callable action', async () => {
    network(
      anthropic(
        [{ type: 'tool_use', id: 'partial', name: 'lookup', input: {} }],
        'max_tokens',
      ),
    );
    await expect(
      new TeaProvider(connection('anthropic'), role).complete(request),
    ).rejects.toThrow('complete reply');
  });

  it('follows Claude model catalog pagination', async () => {
    const fetch = network(
      {
        data: [{ id: 'one', display_name: 'One' }],
        has_more: true,
        last_id: 'one',
      },
      {
        data: [{ id: 'two', display_name: 'Two' }],
        has_more: false,
        last_id: 'two',
      },
    );
    const models = await new TeaProvider(connection('anthropic'), role).models(
      AbortSignal.timeout(5000),
    );
    expect(models.map((model) => model.id)).toEqual(['one', 'two']);
    expect(String(fetch.mock.calls[1][0])).toContain('after_id=one');
  });

  it('turns provider failures into bounded credential-free errors', () => {
    expect(
      providerError({
        status: 401,
        message: 'secret body synthetic-api-key-for-tests',
      }),
    ).toContain('credential');
    expect(
      providerError(new Error('request body synthetic-api-key-for-tests')),
    ).not.toContain('synthetic');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeaProvider } from '../src/tea-provider';
import type { TeaProtocol } from '../../src/shared/tea';

const tool = {
  name: 'lookup',
  description: 'Find a terminal.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};
function provider(protocol: TeaProtocol) {
  return new TeaProvider(
    {
      id: 'connection-stream',
      name: 'Fixture',
      protocol,
      baseUrl: 'https://provider.test/v1',
      apiKey: 'synthetic-stream-key',
    },
    { connectionId: 'connection-stream', model: 'fixture', effort: 'auto' },
  );
}
function request(
  onText: (delta: string) => void,
  signal = AbortSignal.timeout(5000),
) {
  return {
    system: 'Streaming fixture',
    tools: [tool],
    history: [{ role: 'user', content: 'Find login' }],
    signal,
    onText,
  };
}
function fixture(initial: unknown[], named = true) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const send = (events: unknown[]) =>
    events.forEach((event) => {
      const name = named ? `event: ${(event as { type: string }).type}\n` : '';
      controller.enqueue(
        encoder.encode(`${name}data: ${JSON.stringify(event)}\n\n`),
      );
    });
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      controller = stream;
      send(initial);
    },
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'request-id': 'fixture-request',
        },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    finish(events: unknown[] = []) {
      send(events);
      if (!named) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  };
}
function response(status: string, output: unknown[]) {
  return {
    id: 'response-stream',
    object: 'response',
    created_at: 1,
    status,
    model: 'fixture',
    output,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('Tea streaming provider contracts', () => {
  it('streams Claude text before completion and preserves signed thinking and complete tool arguments', async () => {
    const network = fixture([
      {
        type: 'message_start',
        message: {
          id: 'message-stream',
          type: 'message',
          role: 'assistant',
          model: 'fixture',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'opaque fixture reasoning' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'fixture-signature' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Hello ' },
      },
    ]);
    const text = vi.fn();
    let done = false;
    const pending = provider('anthropic')
      .complete(request(text))
      .then((result) => {
        done = true;
        return result;
      });
    await vi.waitFor(() => expect(text).toHaveBeenCalledWith('Hello '));
    expect(done).toBe(false);
    network.finish([
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'there' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'tool-stream',
          name: 'lookup',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"query":' },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '"login"}' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 10 },
      },
      { type: 'message_stop' },
    ]);
    const result = await pending;
    expect(result.text).toBe('Hello there');
    expect(result.calls).toEqual([
      { id: 'tool-stream', name: 'lookup', input: { query: 'login' } },
    ]);
    expect(result.output).toEqual([
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'thinking',
            signature: 'fixture-signature',
          }),
        ]),
      }),
    ]);
    expect(text.mock.calls.map((call) => call[0]).join('')).toBe('Hello there');
    expect(JSON.parse(network.fetch.mock.calls[0][1].body).stream).toBe(true);
  });

  it('streams Responses text and retains encrypted reasoning and commentary phase for replay', async () => {
    const reasoning = {
      id: 'reasoning-stream',
      type: 'reasoning',
      summary: [],
      encrypted_content: 'encrypted-fixture',
    };
    const message = {
      id: 'message-stream',
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      phase: 'commentary',
      content: [],
    };
    const part = {
      type: 'output_text',
      text: '',
      annotations: [],
      logprobs: [],
    };
    const network = fixture([
      {
        type: 'response.created',
        sequence_number: 0,
        response: response('in_progress', []),
      },
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: reasoning,
      },
      {
        type: 'response.output_item.done',
        sequence_number: 2,
        output_index: 0,
        item: reasoning,
      },
      {
        type: 'response.output_item.added',
        sequence_number: 3,
        output_index: 1,
        item: message,
      },
      {
        type: 'response.content_part.added',
        sequence_number: 4,
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        part,
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 5,
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        delta: 'Looking ',
        logprobs: [],
      },
    ]);
    const text = vi.fn();
    const pending = provider('openai').complete(request(text));
    await vi.waitFor(() => expect(text).toHaveBeenCalledWith('Looking '));
    const completedMessage = {
      ...message,
      status: 'completed',
      content: [{ ...part, text: 'Looking ' }],
    };
    const call = {
      id: 'function-stream',
      type: 'function_call',
      call_id: 'tool-stream',
      name: 'lookup',
      arguments: '{"query":"login"}',
      status: 'completed',
    };
    network.finish([
      {
        type: 'response.output_text.done',
        sequence_number: 6,
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        text: 'Looking ',
        logprobs: [],
      },
      {
        type: 'response.content_part.done',
        sequence_number: 7,
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        part: completedMessage.content[0],
      },
      {
        type: 'response.output_item.done',
        sequence_number: 8,
        output_index: 1,
        item: completedMessage,
      },
      {
        type: 'response.output_item.added',
        sequence_number: 9,
        output_index: 2,
        item: { ...call, arguments: '', status: 'in_progress' },
      },
      {
        type: 'response.function_call_arguments.delta',
        sequence_number: 10,
        item_id: call.id,
        output_index: 2,
        delta: call.arguments,
      },
      {
        type: 'response.function_call_arguments.done',
        sequence_number: 11,
        item_id: call.id,
        output_index: 2,
        name: call.name,
        arguments: call.arguments,
      },
      {
        type: 'response.output_item.done',
        sequence_number: 12,
        output_index: 2,
        item: call,
      },
      {
        type: 'response.completed',
        sequence_number: 13,
        response: response('completed', [reasoning, completedMessage, call]),
      },
    ]);
    const result = await pending;
    expect(result.calls[0]).toEqual({
      id: 'tool-stream',
      name: 'lookup',
      input: { query: 'login' },
    });
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ encrypted_content: 'encrypted-fixture' }),
        expect.objectContaining({ phase: 'commentary' }),
      ]),
    );
    expect(result.text).toBe('Looking ');
  });

  it('streams compatible chat text and strips SDK parsing fields from replay messages', async () => {
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: 'chat-stream',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    });
    const network = fixture(
      [
        chunk({
          role: 'assistant',
          content: 'Hello ',
          extra_content: { signature: 'gateway-fixture' },
        }),
      ],
      false,
    );
    const text = vi.fn();
    const adapter = provider('openai-compatible');
    const pending = adapter.complete(request(text));
    await vi.waitFor(() => expect(text).toHaveBeenCalledWith('Hello '));
    network.finish([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'tool-stream',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":' },
          },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '"login"}' } }],
      }),
      chunk({}, 'tool_calls'),
    ]);
    const result = await pending;
    expect(result.calls[0].input).toEqual({ query: 'login' });
    expect(result.output[0]).not.toHaveProperty('parsed');
    expect(
      (result.output[0] as { tool_calls: unknown[] }).tool_calls[0],
    ).not.toHaveProperty('function.parsed_arguments');
    expect(result.output[0]).toHaveProperty(
      'extra_content.signature',
      'gateway-fixture',
    );
    network.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chat-final',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Done' },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    await adapter.complete({
      ...request(text),
      onText: undefined,
      history: [
        ...request(text).history,
        ...result.output,
        ...adapter.results(result.calls, [{ found: true }]),
      ],
    });
    const replay = JSON.parse(network.fetch.mock.calls[1][1].body).messages[2];
    expect(replay).not.toHaveProperty('parsed');
    expect(replay.tool_calls[0].function.arguments).toBe('{"query":"login"}');
  });

  it('rejects an unfinished Responses stream after delivering its text preview', async () => {
    const message = {
      id: 'message-stream',
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    };
    const network = fixture([
      {
        type: 'response.created',
        sequence_number: 0,
        response: response('in_progress', []),
      },
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: message,
      },
      {
        type: 'response.content_part.added',
        sequence_number: 2,
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 3,
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: 'Partial ',
        logprobs: [],
      },
    ]);
    const text = vi.fn();
    const pending = provider('openai').complete(request(text));
    const failed = expect(pending).rejects.toThrow('complete reply');
    await vi.waitFor(() => expect(text).toHaveBeenCalledWith('Partial '));
    network.finish();
    await failed;
  });
});

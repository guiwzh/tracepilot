import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleClient } from './model';
import { TOOL_SPECS } from './tools';

/**
 * 用本地 HTTP 服务模拟 OpenAI 兼容的流式 chat/completions，不发真实请求、不产生费用。
 * 重点是流式工具调用的拼装：同一个调用的函数名和参数会被拆散在多个 chunk 里。
 */
let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function mockStream(events: unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => (body += part));
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests };
}

describe('OpenAICompatibleClient', () => {
  it('forwards text deltas and reassembles tool calls split across chunks', async () => {
    const mock = await mockStream([
      chunk({ role: 'assistant', content: 'Checking the ' }),
      chunk({ content: 'latest event.' }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'get_event_', arguments: '' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'detail', arguments: '{"eventId":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"evt-1"}' } }] }),
      chunk({
        tool_calls: [
          {
            index: 1,
            id: 'call_b',
            type: 'function',
            function: { name: 'compare_releases', arguments: '{}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      {
        ...chunk({}),
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      },
    ]);
    const client = new OpenAICompatibleClient({
      modelApiKey: 'test-key',
      modelApiUrl: mock.url,
      modelName: 'mock-model',
    });
    const deltas: string[] = [];
    const turn = await client.complete({
      messages: [{ role: 'user', content: 'Investigate.' }],
      tools: TOOL_SPECS,
      toolChoice: 'auto',
      signal: new AbortController().signal,
      onTextDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(['Checking the ', 'latest event.']);
    expect(turn).toEqual({
      text: 'Checking the latest event.',
      toolCalls: [
        { id: 'call_a', name: 'get_event_detail', arguments: '{"eventId":"evt-1"}' },
        { id: 'call_b', name: 'compare_releases', arguments: '{}' },
      ],
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(mock.requests[0]).toMatchObject({
      model: 'mock-model',
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
    });
  });

  it('forces a named tool when the loop asks for it', async () => {
    const mock = await mockStream([chunk({ content: 'ok' }, 'stop')]);
    const client = new OpenAICompatibleClient({
      modelApiKey: 'test-key',
      modelApiUrl: `${mock.url}/chat/completions`,
      modelName: 'mock-model',
    });
    await client.complete({
      messages: [{ role: 'user', content: 'Finish.' }],
      tools: TOOL_SPECS,
      toolChoice: { name: 'submit_report' },
      signal: new AbortController().signal,
      onTextDelta: () => {},
    });
    // 配置里写成完整的 /chat/completions 地址也能工作。
    expect(mock.requests[0]).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'submit_report' } },
    });
  });
});

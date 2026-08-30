import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../app';
import type { ServerConfig } from '../config';

// 本地 HTTP Server 模拟 Responses API，验证外部适配器而不发送真实模型请求或产生费用。
interface MockModel {
  url: string;
  requests: Array<{ url?: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

const validDiagnosis = {
  summary: 'The captured state was missing a required cart value.',
  evidence: [{ description: 'The stored stack points to submit.', source: 'stack' }],
  possibleCauses: [
    {
      cause: 'The cart response omitted a required field.',
      confidence: 0.82,
      supportingEvidence: ['The stored stack points to submit.'],
    },
  ],
  investigationSteps: ['Inspect the mapped submit frame.'],
  suggestions: ['Guard the missing cart field.'],
  missingInformation: ['A correlated backend request ID.'],
  disclaimer: 'This is an evidence-bound hypothesis.',
};

/**
 * mock 按 URL 分派，而不是对任何路径都返回同一种形状——否则测试无法证明适配层
 * 究竟走了哪条通道，降级路径也就等于没被覆盖。
 *
 * `responsesStatus` 用来模拟「端点存在但不支持严格结构化输出」（400）
 * 或「端点根本不存在」（404），驱动适配层降级到 chat/completions。
 */
interface MockOptions {
  responsesText?: string;
  responsesStatus?: number;
  chatText?: string;
}

async function startMockModel(options: MockOptions): Promise<MockModel> {
  const requests: MockModel['requests'] = [];
  const server: Server = createServer((request, response) => {
    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(rawBody) as Record<string, unknown> });
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (request.url?.endsWith('/responses')) {
        if (options.responsesStatus && options.responsesStatus !== 200) {
          return json(options.responsesStatus, {
            error: {
              message: 'This response_format type is unavailable now',
              type: 'invalid_request_error',
            },
          });
        }
        return json(200, {
          id: 'response-test',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          model: 'mock-evidence-model',
          output: [
            {
              id: 'message-test',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [
                { type: 'output_text', text: options.responsesText ?? '', annotations: [] },
              ],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
        });
      }

      if (request.url?.endsWith('/chat/completions')) {
        return json(200, {
          id: 'chat-test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-evidence-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: options.chatText ?? '' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 21, completion_tokens: 43, total_tokens: 64 },
        });
      }

      return json(404, { error: { message: 'Unknown endpoint', type: 'invalid_request_error' } });
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

let directory: string;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-model-'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function buildModelApp(modelApiUrl: string) {
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    databasePath: join(directory, 'test.db'),
    sourceMapDir: join(directory, 'maps'),
    modelName: 'mock-evidence-model',
    modelApiKey: 'test-only-key',
    modelApiUrl,
  };
  app = await buildApp({ config, logger: false });
  return app;
}

async function ingestIssue(instance: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/v1/envelopes',
    payload: {
      dsnKey: 'demo-dsn-key',
      sentAt: Date.now(),
      events: [
        {
          eventId: 'external-model-event',
          eventType: 'error',
          timestamp: Date.now(),
          projectId: 'demo-project',
          release: '2.4.1',
          environment: 'production',
          page: { url: 'https://shop.test/cart?customer=private-customer', route: '/cart' },
          device: { userAgent: 'Mozilla/5.0 Chrome/130.0' },
          payload: {
            name: 'TypeError',
            message: 'Cannot submit cart',
            stack: 'TypeError: Cannot submit cart\n    at submit (https://shop.test/app.js:1:10)',
          },
          breadcrumbs: [],
        },
      ],
    },
  });
  expect(response.statusCode).toBe(202);
  return response.json().issueIds[0] as string;
}

describe('external diagnosis adapter', () => {
  it('parses a schema-valid Responses API result and records model usage', async () => {
    const model = await startMockModel({ responsesText: JSON.stringify(validDiagnosis) });
    try {
      const instance = await buildModelApp(model.url);
      const issueId = await ingestIssue(instance);
      const response = await instance.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/diagnoses`,
        payload: {},
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        model: 'mock-evidence-model',
        inputTokens: 12,
        outputTokens: 34,
        cached: false,
        result: validDiagnosis,
      });
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]?.url).toBe('/v1/responses');
      expect(JSON.stringify(model.requests[0]?.body)).not.toContain('private-customer');
    } finally {
      await model.close();
    }
  });

  it('falls back to chat/completions when the endpoint rejects structured Responses output', async () => {
    // 实测过的真实分布：有的兼容端点支持 Responses API 的严格 json_schema，
    // 有的只认 chat/completions 的 json_object。这里模拟后者。
    const model = await startMockModel({
      responsesStatus: 400,
      chatText: JSON.stringify(validDiagnosis),
    });
    try {
      const instance = await buildModelApp(model.url);
      const issueId = await ingestIssue(instance);
      const response = await instance.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/diagnoses`,
        payload: {},
      });

      expect(response.statusCode).toBe(201);
      // 降级路径的 token 用量来自 chat/completions 的字段名，不是 Responses 的。
      expect(response.json()).toMatchObject({
        inputTokens: 21,
        outputTokens: 43,
        result: validDiagnosis,
      });
      // 先试 Responses、被拒后再走 chat/completions——顺序本身就是断言的一部分。
      expect(model.requests.map((item) => item.url)).toEqual([
        '/v1/responses',
        '/v1/chat/completions',
      ]);
      // 降级路径同样不得把脱敏前的原始值发出去。
      expect(JSON.stringify(model.requests[1]?.body)).not.toContain('private-customer');
      // json_object 模式要求提示词里出现 JSON 字样，并且要带上从 Zod 生成的 schema。
      const chatBody = JSON.stringify(model.requests[1]?.body);
      expect(chatBody).toContain('json_object');
      expect(chatBody).toContain('possibleCauses');
    } finally {
      await model.close();
    }
  });

  it('does not fall back when the endpoint fails for a reason other than capability', async () => {
    // 鉴权失败、限流、超时都不该触发降级——那样只会把一次失败变成两次收费。
    const model = await startMockModel({ responsesStatus: 401 });
    try {
      const instance = await buildModelApp(model.url);
      const issueId = await ingestIssue(instance);
      const response = await instance.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/diagnoses`,
        payload: {},
      });

      expect(response.statusCode).toBe(502);
      expect(model.requests.map((item) => item.url)).toEqual(['/v1/responses']);
    } finally {
      await model.close();
    }
  });

  it('isolates invalid model output while keeping issue evidence available', async () => {
    const model = await startMockModel({ responsesText: 'not valid JSON' });
    try {
      const instance = await buildModelApp(model.url);
      const issueId = await ingestIssue(instance);
      const diagnosis = await instance.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/diagnoses`,
        payload: {},
      });

      expect(diagnosis.statusCode).toBe(502);
      expect(diagnosis.json()).toMatchObject({ error: 'DIAGNOSIS_FAILED' });
      expect(
        (await instance.inject({ method: 'GET', url: `/api/v1/issues/${issueId}` })).statusCode,
      ).toBe(200);
      expect((await instance.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await model.close();
    }
  });
});

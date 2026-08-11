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

async function startMockModel(outputText: string): Promise<MockModel> {
  const requests: MockModel['requests'] = [];
  const server: Server = createServer((request, response) => {
    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      requests.push({
        url: request.url,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
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
              content: [{ type: 'output_text', text: outputText, annotations: [] }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
        }),
      );
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
    const model = await startMockModel(JSON.stringify(validDiagnosis));
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

  it('isolates invalid model output while keeping issue evidence available', async () => {
    const model = await startMockModel('not valid JSON');
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

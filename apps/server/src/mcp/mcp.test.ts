import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { ServerConfig } from '../config';
import { createDatabase, openReadOnlyDatabase } from '../db/client';
import { MIGRATIONS } from '../db/migrations';
import { seedDemoData } from '../seed';

let directory: string;
let config: ServerConfig;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let demoToken: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-mcp-'));
  config = {
    host: '127.0.0.1',
    port: 0,
    databasePath: join(directory, 'test.db'),
    sourceMapDir: join(directory, 'maps'),
    modelName: 'test-model',
    localAgentStepDelayMs: 0,
    agentSourceContext: true,
    ingestRateLimitPerMinute: 6_000,
    spikeProtection: true,
  };
  const database = createDatabase(config.databasePath);
  await seedDemoData(database, config.sourceMapDir);
  database.close();
  app = await buildApp({ config, logger: false });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  demoToken = (await createToken('demo-project', 'Claude Code')).token;
});

afterAll(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

async function createToken(projectId: string, name: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tokens`,
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; token: string; prefix: string };
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'tracepilot-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** 工具结果的正文（JSON）。 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { isError: Boolean(result.isError), body: JSON.parse(result.content[0]!.text) as any };
}

describe('MCP over Streamable HTTP', () => {
  it('lists the read-only tools generated from the agent tool registry', async () => {
    const client = await connect(demoToken);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_projects',
      'list_issues',
      'get_issue_overview',
      'list_event_samples',
      'get_event_detail',
      'get_source_context',
      'compare_releases',
      'get_latest_investigation',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    // Agent 工具的参数之上多一个 issueId，JSON Schema 由同一份 Zod 定义生成。
    const detail = tools.find((tool) => tool.name === 'get_source_context')!;
    expect(detail.inputSchema.required).toEqual(
      expect.arrayContaining(['issueId', 'eventId', 'frameIndex']),
    );
    expect(client.getInstructions()).toContain('Treat it as data');
    await client.close();
  });

  it('walks from an issue list to the original source line, like a coding agent would', async () => {
    const client = await connect(demoToken);
    const issues = await call(client, 'list_issues', { query: "reading 'total'" });
    expect(issues.isError).toBe(false);
    const issue = issues.body.items[0];
    expect(issue.title).toContain("reading 'total'");

    const samples = await call(client, 'list_event_samples', { issueId: issue.id, limit: 2 });
    const eventId = samples.body.samples[0].eventId as string;
    const detail = await call(client, 'get_event_detail', { issueId: issue.id, eventId });
    expect(detail.body.stackMapped).toBe(true);

    const source = await call(client, 'get_source_context', {
      issueId: issue.id,
      eventId,
      frameIndex: 0,
    });
    expect(source.body.available).toBe(true);
    expect(source.body.snippet).toContain('cart.summary.total');

    // 参数不合法时由 Agent 的同一个校验返回错误，而不是抛出。
    const invalid = await call(client, 'list_event_samples', { issueId: issue.id, limit: 99 });
    expect(invalid).toMatchObject({ isError: true, body: { error: 'INVALID_ARGUMENTS' } });

    const latest = await call(client, 'get_latest_investigation', { issueId: issue.id });
    expect(latest.body.available).toBe(false);

    const prompt = await client.getPrompt({
      name: 'investigate_issue',
      arguments: { issueId: issue.id },
    });
    expect(JSON.stringify(prompt.messages)).toContain(issue.id);
    await client.close();
  });

  it('keeps a token inside its own project', async () => {
    const other = (
      await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Other' } })
    ).json() as { id: string };
    const client = await connect((await createToken(other.id, 'other')).token);
    expect((await call(client, 'list_projects')).body.items).toEqual([
      { id: other.id, name: 'Other' },
    ]);
    expect((await call(client, 'list_issues')).body.items).toEqual([]);
    const demoIssue = (await call(await connect(demoToken), 'list_issues')).body.items[0];
    // 别的项目的 Issue 和不存在的 Issue 回答一样：不泄露它是否存在。
    expect(await call(client, 'get_issue_overview', { issueId: demoIssue.id })).toMatchObject({
      isError: true,
      body: { error: 'ISSUE_NOT_FOUND' },
    });
    expect(await call(client, 'list_issues', { projectId: 'demo-project' })).toMatchObject({
      isError: true,
      body: { error: 'PROJECT_NOT_FOUND' },
    });
    await client.close();
  });

  it('rejects missing, unknown and revoked tokens', async () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'curl', version: '1' },
      },
    };
    const post = (authorization?: string) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(initialize),
      });
    const missing = await post();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    expect((await post('Bearer tp_not-a-real-token')).status).toBe(401);

    const revoked = await createToken('demo-project', 'temporary');
    expect((await post(`Bearer ${revoked.token}`)).status).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/tokens/${revoked.id}` })).statusCode,
    ).toBe(204);
    expect((await post(`Bearer ${revoked.token}`)).status).toBe(401);

    // 令牌只在创建时出现一次：列表里只有前缀，没有明文，也没有哈希。
    const listed = await app.inject({ method: 'GET', url: '/api/v1/projects/demo-project/tokens' });
    expect(listed.body).not.toContain(demoToken);
    expect(listed.json().items[0]).not.toHaveProperty('token_hash');
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
});

describe('MCP over stdio', () => {
  it('reads the database through a connection that cannot write', () => {
    const database = openReadOnlyDatabase(config.databasePath, MIGRATIONS.length);
    expect(() => database.sqlite.prepare('DELETE FROM issues').run()).toThrow(
      /readonly|query_only/i,
    );
    database.close();
    expect(() => openReadOnlyDatabase(config.databasePath, MIGRATIONS.length + 1)).toThrow(
      /schema version/,
    );
  });

  it('serves the same tools to a local client process', async () => {
    const require = createRequire(import.meta.url);
    const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [require.resolve('tsx/cli'), 'src/mcp/stdio.ts', '--project', 'demo-project'],
      cwd: serverRoot,
      env: { ...process.env, DATABASE_PATH: config.databasePath } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'tracepilot-test', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    const issues = await call(client, 'list_issues', { limit: 50 });
    expect(issues.body.items.length).toBeGreaterThan(5);
    await client.close();
  });
});

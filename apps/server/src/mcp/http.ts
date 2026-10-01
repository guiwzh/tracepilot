import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import { authenticateApiToken } from '../services/apiTokens';
import { createMcpServer } from './server';

/**
 * MCP 的 Streamable HTTP 入口：POST /mcp，Authorization: Bearer <项目令牌>。
 *
 * 无状态模式：每个请求新建一个 MCP 服务器和传输层，处理完就丢。工具都是一问一答，不需要服务器主动
 * 推送，也就不需要会话和 GET 上的 SSE 长连接；多实例部署时请求落到哪个实例都一样。
 *
 * 鉴权用项目级的静态令牌（services/apiTokens.ts），Claude Code、Cursor 都支持给 MCP 服务器配置请求头。
 * MCP 规范里完整的 OAuth 2.1 授权流程（受保护资源元数据、动态客户端注册）没有实现，见已知限制。
 */
export function registerMcpRoutes(
  app: FastifyInstance,
  database: TraceDatabase,
  config: Pick<ServerConfig, 'agentSourceContext' | 'repositoryRoot'>,
): void {
  app.post('/mcp', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const auth = token ? authenticateApiToken(database, token) : null;
    if (!auth) {
      // JSON-RPC 形状的错误体，客户端能直接展示；WWW-Authenticate 告诉它要的是 Bearer 令牌。
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="tracepilot-mcp"')
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'A valid TracePilot API token is required.' },
          id: null,
        });
    }

    const server = createMcpServer({
      database,
      projectIds: [auth.projectId],
      allowSourceContext: config.agentSourceContext,
      repositoryRoot: config.repositoryRoot,
    });
    // sessionIdGenerator: undefined 即无状态模式；enableJsonResponse 让一问一答直接返回 JSON 而不是开 SSE 流。
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // 交出原始的 Node 请求和响应，由 MCP 的传输层写响应；Fastify 不再处理这个回复。
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // 无状态模式没有服务器主动推送的 SSE 流，也没有可以结束的会话。
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_request, reply) =>
        reply
          .code(405)
          .header('allow', 'POST')
          .send({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'This MCP endpoint is stateless; use POST.' },
            id: null,
          }),
    });
  }
}

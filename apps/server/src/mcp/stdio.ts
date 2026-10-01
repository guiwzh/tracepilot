import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config as loadEnvFile } from 'dotenv';
import { loadConfig, serverRoot } from '../config';
import { openReadOnlyDatabase } from '../db/client';
import { MIGRATIONS } from '../db/migrations';
import { createMcpServer } from './server';

/**
 * MCP 的 stdio 入口：编码 Agent 把它作为子进程启动，通过标准输入输出说 JSON-RPC。
 *
 *   claude mcp add tracepilot -- node /path/to/tracepilot/apps/server/dist/mcp.js
 *   claude mcp add tracepilot -- node /path/to/tracepilot/apps/server/dist/mcp.js --project demo-project
 *
 * 直接读本机的 SQLite 文件（只读连接），不需要服务端在运行，也不需要令牌：能运行这个进程的人本来就能读
 * 这个文件。默认能看到全部项目，--project 限定为一个。
 * 标准输出是协议通道，任何日志都只能写到标准错误，否则会破坏客户端的解析。
 */
// 编码 Agent 从它自己的工作目录启动这个进程：按 apps/server 的位置读 .env（DATABASE_PATH 等），
// 而不是当前目录。已经设置的环境变量不会被覆盖；quiet 让 dotenv 不输出任何提示（标准输出是协议通道）。
loadEnvFile({ path: resolve(serverRoot, '.env'), quiet: true });
const config = loadConfig();
const projectFlag = process.argv.indexOf('--project');
const project = projectFlag === -1 ? undefined : process.argv[projectFlag + 1];

const database = openReadOnlyDatabase(config.databasePath, MIGRATIONS.length);
const server = createMcpServer({
  database,
  projectIds: project ? [project] : 'all',
  allowSourceContext: config.agentSourceContext,
});
await server.connect(new StdioServerTransport());
process.stderr.write(`TracePilot MCP (stdio) reading ${config.databasePath}\n`);

const shutdown = () => {
  void server.close().finally(() => {
    database.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);

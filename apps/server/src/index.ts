import 'dotenv/config';
import { buildApp } from './app';
import { loadConfig } from './config';

// 进程入口只负责读取环境、组装应用并监听端口；buildApp 保持可被测试直接调用。
const config = loadConfig();
const app = await buildApp({ config, logger: true });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  // 设置 exitCode 能让日志有机会冲刷完，再由 Node 以失败状态退出。
  app.log.error(error);
  process.exitCode = 1;
}

import 'dotenv/config';
import { buildApp } from './app';
import { loadConfig } from './config';

// 进程入口只负责读取环境、组装应用、监听端口和优雅退出；buildApp 保持可被测试直接调用。
const config = loadConfig();
const app = await buildApp({ config, logger: true });

/**
 * 收到 SIGTERM（部署平台停止实例）或 SIGINT（开发时 Ctrl+C）时优雅退出：app.close() 触发 onClose，
 * 先中止进行中的调查并写入终止事件，再关闭 SQLite。缺了这一步，进程被直接结束，调查记录会停在
 * running，要等下次启动才被标记为失败。退出过程中再收到一次信号则立即强制退出。
 */
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) process.exit(1);
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error(error);
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  // 设置 exitCode 能让日志有机会冲刷完，再由 Node 以失败状态退出。
  app.log.error(error);
  process.exitCode = 1;
}

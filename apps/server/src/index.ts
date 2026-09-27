// 只为副作用导入：把 .env 文件里的变量写进 process.env，必须在读取配置之前执行，所以放在第一行。
import 'dotenv/config';
import { buildApp } from './app';
import { loadConfig } from './config';

/**
 * 服务端进程入口：pnpm dev 用 tsx 直接运行它，pnpm start 运行它构建后的 dist/index.js。
 * 只负责读取环境、组装应用、监听端口和优雅退出；buildApp 保持可被测试直接调用。
 *
 * 文件顶层直接写 await：ES Module 支持顶层 await，不需要包一层 async 函数。
 */
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
  // 开始监听端口。host 默认 127.0.0.1：只接受本机访问；想让局域网访问要设为 0.0.0.0。
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  // 最常见的原因是端口被占用（EADDRINUSE）。设置 exitCode 而不是直接 process.exit(1)：
  // 让日志有机会写完，再由 Node 以失败状态自然退出。
  app.log.error(error);
  process.exitCode = 1;
}

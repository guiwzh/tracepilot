import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 演练场专用的故障接口，只存在于 Playground 自己的开发与预览服务器里。
 * 它们曾注册在生产服务端上（/api/v1/playground/fail），部署出去的 API 里凭空多了一个演示接口。
 */
const labEndpoints: Connect.NextHandleFunction = (request, response, next) => {
  const path = (request.url ?? '').split('?')[0] ?? '';
  if (!path.startsWith('/__lab/')) return next();
  if (path === '/__lab/payment' || path === '/__lab/inventory') {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'UPSTREAM_UNAVAILABLE', retryAfter: 30 }));
    return;
  }
  if (path === '/__lab/slow') {
    // 两秒后才响应，足够让「取消请求」场景在它完成之前中止它。
    const timer = setTimeout(() => response.end('{}'), 2_000);
    request.on('close', () => clearTimeout(timer));
    return;
  }
  // 其余 /__lab/ 地址（故意缺失的图片等）一律 404，开发和预览服务器的行为一致。
  response.statusCode = 404;
  response.end();
};

function labEndpointsPlugin(): Plugin {
  return {
    name: 'tracepilot-lab-endpoints',
    configureServer: (server) => void server.middlewares.use(labEndpoints),
    configurePreviewServer: (server) => void server.middlewares.use(labEndpoints),
  };
}

export default defineConfig({
  plugins: [react(), labEndpointsPlugin()],
  // 演练场故意抛错：把浏览器里的每个未处理错误都转发到终端，一次「错误风暴」就是二十段堆栈，
  // 淹没 pnpm dev 里其他服务的日志。这些错误由 SDK 采集，在工作台里看。
  server: { forwardConsole: false },
});

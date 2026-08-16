import { defineConfig } from 'vitest/config';

// Server 测试使用真实 Node API、SQLite 临时文件和本地 mock HTTP 服务。
export default defineConfig({
  test: { environment: 'node', testTimeout: 15_000, hookTimeout: 15_000 },
});

import { defineConfig } from 'vitest/config';

// 插件在 Node 里运行；集成测试真的跑一次 vite build，给它留足时间。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});

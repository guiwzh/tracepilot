import { defineConfig } from 'vitest/config';

// SDK 依赖 window、document 和 PerformanceObserver，因此使用 happy-dom 浏览器环境。
// 测试放在 test/ 下，目录结构与 src/ 一一对应（src/plugins/X.ts ↔ test/plugins/X.test.ts）。
export default defineConfig({
  test: {
    environment: 'happy-dom',
    restoreMocks: true,
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});

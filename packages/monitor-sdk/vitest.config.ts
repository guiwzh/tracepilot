import { defineConfig } from 'vitest/config';

// SDK 依赖 window、document 和 PerformanceObserver，因此使用 happy-dom 浏览器环境。
export default defineConfig({
  test: { environment: 'happy-dom', restoreMocks: true, setupFiles: ['./src/test/setup.ts'] },
});

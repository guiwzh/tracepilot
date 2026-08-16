import { defineConfig } from 'vitest/config';

// happy-dom 在 Node 中模拟轻量浏览器 DOM，比启动真实浏览器更适合快速单元测试。
export default defineConfig({ test: { environment: 'happy-dom' } });

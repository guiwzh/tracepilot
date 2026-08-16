import { defineConfig } from 'vitest/config';

// shared 是纯数据/Schema 包，不需要 DOM；coverage 同时输出终端摘要与 HTML 报告。
export default defineConfig({
  test: { environment: 'node', coverage: { reporter: ['text', 'html'] } },
});

# 阶段 10 — 最终回归与交付审计

> **数字口径**：本文记录的是该阶段完成当时的测量值，仅作历史留档。
> 最新基线以 [`docs/reports/performance.md`](../reports/performance.md) 为唯一权威来源；
> 两者不一致时以报告为准。

## 阶段目标

把前三个修复阶段转化为长期回归保障，并重新执行安装、质量、安全、生产运行、浏览器闭环、性能和
诊断评测，确认核心 MVP 达到可复现、可演示的既定目标。

## 新增回归保障

1. 外部模型适配器通过本机临时 HTTP 服务模拟 Responses API：有效结构化结果会记录模型与 Token
   用量，无效 JSON 返回 502，同时 Issue 证据与健康检查保持可用。
2. Playwright 增加高级筛选、全局搜索聚焦和真实分页测试。
3. 使用 390×844 视口打开包含长资源 URL 的 Issue，断言 `body` 和文档宽度均不超过视口。
4. 通过 multipart API 上传最小有效 Source Map，再接入带浏览器堆栈的新事件，断言详情 API 返回
   `src/runtime.ts:1:1` 原始位置；测试创建的私有地图文件在结束时删除。
5. 诊断 E2E 监听“重新生成”请求，断言请求体包含 `force: true`。

## 最终验证结果

```bash
pnpm install --frozen-lockfile --offline
pnpm format:check
pnpm verify
pnpm test:e2e
pnpm audit --prod --audit-level=high
pnpm measure:sdk
pnpm benchmark
pnpm evaluate:diagnosis
```

- ESLint 与严格 TypeScript：通过，零警告。
- 单元/集成测试：25 项通过，覆盖共享隐私工具、SDK、服务端、外部模型和 Dashboard 工具。
- 生产构建与烟雾测试：全部工作区构建成功；共享包、SDK ESM/CJS 和构建后 Server 均可运行。
- Playwright：7/7 通过，覆盖筛选、分页、移动端、证据链、诊断、Source Map 和 SDK 接入。
- 生产依赖审计：无已知漏洞。
- SDK：13,556 字节 minified ESM，gzip 9 后 4,419 字节。
- 1,000 事件本机微基准：10 事件批次 P50/P95 为 1.88/2.28 ms；Issue 查询为
  0.13/0.16 ms。
- 本地诊断评测：4/4 结构化成功，4/4 未变化上下文缓存命中。
- 重置后的演示数据库：307 个事件、4 个 Issue、0 个反向时间区间、0 个带 query 的上下文或
  Breadcrumb、0 个诊断和 0 个 Source Map 记录。

## 交付边界

核心 MVP 的代码、自动化验证、架构图、演示脚本、性能报告和诊断评测均已就绪。身份认证、企业
多租户、生产限流、保留策略和语义级外部模型质量评测仍是 README 明确说明的非 MVP 能力；
3–5 分钟演示视频需要实际讲解者录制，本仓库提供逐分钟演示脚本，但不伪造真人讲解视频。

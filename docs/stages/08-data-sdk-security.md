# 阶段 08 — 数据正确性、SDK 稳定性与隐私加固

## 阶段目标

修复乱序接入导致的 Issue 时间错误，保证 SDK 在持续故障时遵守有限重试预算，阻止任意 URL
查询参数进入存储、日志和诊断上下文，并消除已识别的高危依赖漏洞。

## 实现步骤

1. Issue 更新时用最小事件时间维护 `firstSeenAt`、最大事件时间维护 `lastSeenAt`；只有不早于当前
   最新样本的事件才能更新展示标题。
2. 调整 Transport 批次状态：发送失败后将原批次放回队列，但不立即递归开启一轮新的重试；只有
   当前批次成功时才继续排空后续满批次。
3. 在 SDK 核心层和 Transport 层同时约束 `batchSize`、`flushInterval` 和 `maxRetries`，防止零批量、
   负数或非有限值导致空请求、忙循环或异常定时器。
4. 扩展共享隐私工具：URL 字段、路由字段、绝对 URL 文本和相对 URL 文本都删除全部 query 与
   fragment，而不仅仅是已知的 `token`、`secret` 等参数名。
5. 服务端仍在入库前执行独立递归脱敏，因此 payload、页面上下文和 Breadcrumb 会使用同一规则；
   Fastify 请求日志序列化时也只保留无 query 的路径。
6. 将 `drizzle-orm` 从受影响的 `0.44.x` 升级到 `0.45.2`，并刷新锁文件。
7. 新增乱序时间、任意 URL 参数、持续离线满批次、非法 SDK 数值选项等回归测试。

## 验证方式

```bash
pnpm verify
pnpm audit --prod --audit-level=high
```

验证时还会确认生产烟雾测试继续通过，确保依赖升级和共享脱敏逻辑没有重新破坏构建产物。

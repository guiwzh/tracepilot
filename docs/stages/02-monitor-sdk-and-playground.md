# 阶段 02 — 监控 SDK 与事故演练场

> **数字口径**：本文记录的是该阶段完成当时的测量值，仅作历史留档。
> 最新基线以 [`docs/reports/performance.md`](../reports/performance.md) 为唯一权威来源；
> 两者不一致时以报告为准。

## 阶段成果

交付插件化浏览器 SDK 和专用 React 事故实验场。SDK 可采集运行时、Promise、资源、Fetch、XHR、
用户行为、导航和 Web Vital 信号，并将其分批发送至服务端。

## 实现步骤

1. 构建幂等的核心生命周期，涵盖插件注册、用户上下文、Breadcrumb、采样、`beforeSend`、错误去重、
   刷新和完整销毁。
2. 分别实现错误、Promise、资源、网络、行为、性能和传输插件。
3. 保存原始 Fetch/XHR/history 函数并在销毁时恢复，防止重复初始化产生重复监听器。
4. 在插桩前捕获原始 Fetch 实现，为 SDK 请求添加标记，并排除接入端点以防止递归遥测。
5. 添加内存批处理队列、定时/定量刷新、指数退避重试、keepalive Fetch，以及页面隐藏时的
   `sendBeacon` 发送机制。
6. 实现 LCP、INP、CLS、FCP 和 TTFB 采集，并在浏览器能力不足时安全降级。
7. 构建无障碍、响应式的事故演练场，为每种目标故障提供可控触发器和 SPA 路由 Breadcrumb。

## 验证方式

```bash
pnpm --filter @trace-pilot/monitor-sdk typecheck
pnpm --filter @trace-pilot/monitor-sdk test
pnpm --filter @trace-pilot/monitor-sdk build
pnpm --filter @trace-pilot/playground typecheck
pnpm --filter @trace-pilot/playground build
```

结果：4 项 SDK 测试通过，ESM 和 CommonJS 包构建成功。最终验证的 ESM 压缩产物为 12,502 字节，
在本机经 gzip 压缩后为 4,183 字节；这些数字仅作为本地构建测量结果记录，不代表生产基准。

## 关键选择

- 成功的 HTTP Span 会成为证据，但不会创建 Issue；失败分类由服务端完成。
- 不支持的 PerformanceObserver 条目类型会静默降级，因为不同浏览器的支持能力存在差异。
- 事故演练场使用虚构的结账事故，无需任何真实客户数据。

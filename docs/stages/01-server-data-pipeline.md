# 阶段 01 — 服务端数据管道

## 阶段成果

交付由 SQLite 和 Drizzle Schema 支撑的可运行 Fastify 服务。该服务接收浏览器事件批次、执行共享
契约校验、清理敏感信息、创建 Release、将可处理事件聚合为 Issue，并提供项目、Issue、事件、概览
和性能 API。

## 实现步骤

1. 创建项目、Release、Issue、事件、Source Map 和诊断关系表，并配置外键、唯一约束、WAL 模式与
   查询索引。
2. 添加确定性的演示项目，使仓库启动后即可使用。
3. 在单个事务中实现事件信封接入，并加入 DSN/项目授权和事件 ID 幂等处理。
4. 先归一化 UUID、长数字 ID、分块哈希、查询字符串和空白字符，再计算 SHA-256 Issue 指纹。
5. 聚合首次/最近出现时间、事件数量和不同受影响用户，同时避免性能样本进入 Issue 流。
6. 添加支持分页与筛选的 Issue 查询、事件详情、浏览器/路由/Release 分布、项目概览趋势、
   Release 管理和 Web Vital 分位数。
7. 添加稳定的 JSON 错误响应，并验证格式错误的输入不会影响服务健康状态。

## 验证方式

```bash
pnpm --filter @trace-pilot/server typecheck
pnpm --filter @trace-pilot/server test
pnpm --filter @trace-pilot/server build
```

结果：指纹归一化与注入式 HTTP 集成场景共 4 项测试通过。

## 关键选择

- SQLite 事务确保 MVP 中每个批次都具备原子性和确定性。
- 成功的网络 Span 和性能样本仍可作为事件查询，但不会污染 Issue。
- 复杂的调查工作台聚合使用显式 SQL，Drizzle 则负责类型化表定义和核心插入/更新操作。

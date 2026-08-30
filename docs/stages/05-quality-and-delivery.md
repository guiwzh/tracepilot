# 阶段 05 — 质量保障与交付

> **数字口径**：本文记录的是该阶段完成当时的测量值，仅作历史留档。
> 最新基线以 [`docs/reports/performance.md`](../reports/performance.md) 为唯一权威来源；
> 两者不一致时以报告为准。

## 阶段成果

将可运行的 MVP 整理为可复现仓库：完整本地配置、确定性演示数据、浏览器级验收测试、CI、如实的
性能/诊断报告、操作演示脚本，以及单命令质量验证。

## 实现步骤

1. 添加根级 Playwright 配置，启动或复用服务端、调查工作台和事故演练场，并在每个测试套件前重置
   虚构种子数据。
2. 通过 4 项真实浏览器测试覆盖可分享的 Issue 筛选、证据链重建、诊断生成和 SDK 到 API 的传输。
3. E2E 测试发现受限网络中存在可避免的加载延迟后，移除远程字体依赖。
4. 添加可重复执行的 SDK gzip 体积测量、1,000 事件 SQLite 微基准测试，以及确定性的诊断契约/
   缓存评测。
5. 编写报告，明确区分可复现的开发基线与生产容量或 AI 语义质量声明。
6. 在 README 中添加环境配置、SDK 示例、Source Map 工作流、API 摘要、安全边界、限制、命令、
   架构和实测结果。
7. 添加 3–5 分钟演示流程、MIT 许可证、Node 运行时要求和 GitHub Actions 工作流。
8. 在整个仓库应用 Prettier，并将根目录 E2E 源码纳入严格 TypeScript 验证。

## 最终验证

```bash
pnpm format:check
pnpm verify
pnpm test:e2e
pnpm measure:sdk
pnpm benchmark
pnpm evaluate:diagnosis
```

最终工作树上的结果：

- ESLint：通过，零警告。
- TypeScript：根目录 E2E 与全部 5 个工作区项目均通过。
- 单元/集成测试：15 项通过。
- 生产构建：shared、SDK、服务端、调查工作台和事故演练场均通过。
- Playwright：4/4 项完整闭环测试通过。
- SDK 最终产物：压缩后 12,502 字节；gzip 后 4,183 字节。
- 本地 API 微基准测试：批次接入 P50/P95 为 1.79/2.23 ms；查询 P50/P95 为 0.13/0.16 ms。
- 本地诊断冒烟评测：4/4 项结构化输出成功，4/4 项相同上下文缓存命中。

每项指标的详细限制均保留在 `docs/reports/` 中。

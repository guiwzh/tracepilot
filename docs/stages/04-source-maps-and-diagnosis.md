# 阶段 04 — Source Map 与证据诊断

## 阶段成果

打通从浏览器压缩堆栈到原始源码坐标，以及从已存储遥测数据到可缓存结构化诊断的产品闭环。两项
功能都能明确降级，且不会影响核心 Issue 调查流程。

## 实现步骤

1. 添加私有 multipart Source Map 上传，设置 10 MB 上限、`.map` 扩展名检查、版本 3 结构校验、
   服务端随机文件名和严格文件权限。
2. 将浏览器资源 URL 归一化为 Release 范围内的文件名，并使用 `source-map` Consumer 映射堆栈的
   行号与列号。
3. Map 上传后重新处理已存储的 Release 事件；如果匹配的 Map 已存在，则在新事件到达时立即解析。
4. 使用 Issue、已还原/压缩堆栈、最近 8 个事件样本、每个样本 12 条 Breadcrumb、失败请求、
   Release、浏览器和项目级性能数据构建紧凑的诊断上下文。
5. 在计算哈希或调用模型前，再次递归清理敏感信息。
6. 实现确定性的本地证据引擎，使演示与测试无需密钥或网络访问。
7. 添加可选的 OpenAI Responses API 适配器，使用 Zod 支持的 `text.format` 结构化输出，设置
   30 秒超时、禁用 SDK 重试，并在最后执行共享 Schema 校验。
8. 持久化模型、提示词版本、上下文哈希、Token、延迟、结果与缓存状态。
9. 提供方失败时返回隔离的 502 错误，同时保持 Issue API 独立可用。

## 验证方式

```bash
pnpm --filter @trace-pilot/server typecheck
pnpm --filter @trace-pilot/server test
pnpm --filter @trace-pilot/server build
```

结果：8 项测试通过，覆盖 Release 范围内的源码映射、Map 缺失降级、符合 Schema 的本地诊断，
以及上下文未变化时的缓存复用。完整诊断报告也已连接本地服务端渲染，并在 1440×1200 尺寸下
完成视觉检查。

## 关键选择

- Source Map 永远不会通过下载端点公开。
- 在调用模型前主动限制上下文大小，而不是依赖提供方的限制。
- 外部结构化输出和本地 Zod 校验刻意形成冗余的信任边界。

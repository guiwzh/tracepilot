# 阶段 03 — 调查工作台

## 阶段成果

交付 React 证据工作台：项目选择、Issue 分诊、可分享的筛选条件、项目趋势、Issue 详情、源码堆栈、
按时间排列的 Breadcrumb、网络证据、事件样本、性能分位数、Release、私有 Source Map 上传界面，
以及基于证据的诊断展示。

## 实现步骤

1. 使用 TanStack Query 缓存 API 状态，以 URL 查询参数保存可分享的 Issue 视图，并通过 Zustand
   持久化表格行密度偏好。
2. 构建项目创建/选择功能，以及具备项目感知导航的响应式应用外壳。
3. 实现服务端分页的 Issue 筛选、按新鲜度排序、严重程度/状态标记、迷你趋势图、概览指标和按小时
   聚合的 ECharts 趋势图。
4. 创建 Issue 调查界面，包含概览、堆栈、Breadcrumb、网络、事件和 AI 诊断标签页。
5. 将按时间排列的“证据链”设计为产品标志性交互：每个采集动作都获得稳定的证据索引、来源标签、
   时间戳和可选的结构化载荷。
6. 添加 Source Map 解析状态、浏览器分布、Web Vital 分位数卡片、Release 创建和上传控件。
7. 添加确定性种子命令，生成跨 Release、浏览器、路由、用户、故障和性能指标的 307 个虚构浏览器
   事件。
8. 懒加载调查路由，并将图表运行时拆分到非首屏加载的第三方 Chunk 中。
9. 归一化 Issue 标题中的易变 ID，同时保留易读的大小写格式。

## 验证方式

```bash
pnpm --filter @trace-pilot/server test
pnpm seed
pnpm --filter @trace-pilot/dashboard typecheck
pnpm --filter @trace-pilot/dashboard test
pnpm --filter @trace-pilot/dashboard build
```

结果：5 项服务端测试和 1 项调查工作台格式化测试通过，生产 Chunk 构建成功。Issue 列表和详情视图
在 1440×1000 与 390×844 两种尺寸下连接真实本地 API 完成渲染，均未出现文档级横向溢出。

## 视觉方向

界面的灵感来自航空事故调查台，而非通用的霓虹监控大屏：冷调蓝灰表面、橙色事故信号、等宽字体
证据标签、紧凑但克制的表格，以及连接错误相关事实的连续证据链。动效保持克制，并遵循用户的
“减少动态效果”设置。

# 阶段 13：真实浏览器审查、全局搜索与可发现分页

## 目标

使用 Browser MCP 和 Playwright 补做真实浏览器质量检查，修复用户实际操作中发现的顶部搜索误导和
Issue 分页不可发现问题，并把复现路径固化为自动化回归。

## 实现步骤

1. 在 Chrome 中复现顶部 Search evidence 会跳转并聚焦列表搜索框的行为。
2. 检查 Issues 请求和 UI，确认服务端分页存在，但默认 25 条和 4 个种子 Issue 使演示无法出现
   第二页，图标按钮也没有名称。
3. 在 AppShell 中实现独立搜索 Dialog，加入服务端结果、快捷键、焦点恢复、滚动锁定和移动端入口。
4. 将 Issues 默认页大小调整为 10，增加范围、总数、每页数量以及 Previous/Next 控件。
5. 在保持 307 个事件不变的前提下，将演示错误扩展为 16 个稳定指纹分组。
6. 使用 390 × 844 应用内浏览器检查 Projects、Issues、Performance、Releases 和 Playground。
7. 更新 Playwright，覆盖搜索 Dialog、快捷键、两页分页、Console 和失败 API 响应。

## 浏览器测试发现

- 原全局搜索只是跨路由传递 `focus=search`，和顶栏命令入口的视觉语义不一致。
- 原分页虽然可通过手工设置 `pageSize=1` 测试，但默认数据与默认页大小让用户无法发现它。
- 移动端隐藏搜索文字后，按钮失去可访问名称。
- 扩充种子数据时，变化的堆栈列号会破坏指纹稳定性；真实页面的 99 个 Unresolved 指标暴露了
  回归，随后改为每种根因固定堆栈位置。

## 验证

- Dashboard 与 Server TypeScript 检查通过。
- ESLint 和 `git diff --check` 通过。
- Browser MCP 桌面与 390px 检查通过，无非预期 Console warning/error。
- Playwright 8/8 通过，包括搜索、分页、移动端、证据链、诊断、Source Map、SDK 和主要路由健康
  检查。

详细证据见 [浏览器质量审查报告](../reports/browser-audit.md)。

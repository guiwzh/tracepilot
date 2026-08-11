# TracePilot 平台使用手册

本文面向首次体验平台、接入浏览器 SDK 和排查前端事故的使用者。当前界面中的按钮与栏目名称以
英文显示，因此本文在关键位置同时保留英文名称，便于直接对照操作。

本文适用于当前本地 MVP。它可以完成浏览器信号采集、Issue 聚合、证据查看、性能分析、
Source Map 还原和只读诊断，但不包含登录鉴权、企业多租户和生产集群部署。

## 1. 平台由什么组成

| 服务       | 默认地址                     | 用途                                   |
| ---------- | ---------------------------- | -------------------------------------- |
| Dashboard  | http://localhost:4173        | 查看项目、Issue、性能、Release 和诊断  |
| Playground | http://localhost:4174        | 主动制造可控的浏览器错误和行为信号     |
| Server     | http://localhost:4318        | 接收事件、保存数据并提供查询与诊断 API |
| 健康检查   | http://localhost:4318/health | 判断服务端是否已经就绪                 |

Dashboard 左侧主导航包含三个入口：

- Issues：按归一化原因聚合后的问题列表和调查入口。
- Performance：LCP、INP、CLS、FCP、TTFB 等真实用户指标。
- Releases：创建发布版本并私有上传 Source Map。

## 2. 启动与停止

### 2.1 环境要求

- Node.js 22 或更高版本。
- pnpm 10 或更高版本。

首次运行：

```bash
pnpm install
pnpm seed
pnpm dev
```

以后通常只需要：

```bash
pnpm dev
```

当终端显示 Dashboard、Playground 和 Server 均已监听后，即可打开第 1 节中的地址。停止服务时，
在运行 pnpm dev 的终端按 Ctrl+C。

注意：pnpm seed 会重建 demo-project 的虚构演示数据。需要保留当前本地数据时不要执行该命令。

### 2.2 启动后快速确认

```bash
curl http://localhost:4318/health
```

健康接口返回成功后，再打开 Dashboard。如果页面可以打开但没有数据，先确认是否执行过
pnpm seed，或按照下一节从 Playground 产生新事件。

## 3. 五分钟完成一次完整体验

### 3.1 制造浏览器信号

1. 打开 Playground：http://localhost:4174。
2. 确认右上角显示 SDK armed，表示 SDK 已完成初始化。
3. 依次点击 SPA route change、Fetch 503 和 Captured warning。
4. 点击 Flush event buffer，立即发送尚在缓冲区中的事件。

建议按上述顺序操作。这样后产生的事件会携带前面的路由和请求 Breadcrumb，更容易在证据链中
看到事故发生前后的上下文。SDK 默认也会定时或达到批量阈值时自动发送，手动 Flush 只是让演示
结果更快出现。

Playground 提供以下场景：

| 场景              | 会产生的信号                             |
| ----------------- | ---------------------------------------- |
| Runtime exception | window.error 捕获的运行时异常            |
| Unhandled promise | 未处理的 Promise rejection               |
| Broken resource   | 图片等静态资源加载失败                   |
| Fetch 503         | Fetch 请求失败及网络 Breadcrumb          |
| XHR 503           | XMLHttpRequest 请求失败及网络 Breadcrumb |
| SPA route change  | 不刷新页面的路由 Breadcrumb              |
| Captured warning  | 业务主动上报的 warning 消息              |

页面底部 Flight recorder 只记录本次页面会话里点击过的场景，不代表服务端最终聚合结果。

### 3.2 在 Dashboard 找到信号

1. 打开 Dashboard：http://localhost:4173。
2. 选择 Checkout Web 项目。
3. 进入 Issues 页面；如果页面此前已经打开，请刷新一次或重新进入该页面。
4. 使用搜索框查找 503、Payment、Inventory 等关键词。
5. 点击一条 Issue 进入详情。

TracePilot 会归一化时间戳、UUID 和动态 ID，再计算指纹。多次触发同一类错误通常会增加同一个
Issue 的事件数，而不是无限生成标题略有不同的新 Issue。

### 3.3 生成诊断

1. 在 Issue 详情切换到 diagnosis 标签。
2. 点击 Generate diagnosis。
3. 阅读 Evidence cited、Possible causes、Investigation steps、Suggested changes 和
   Evidence still missing。
4. 再次生成相同上下文的诊断时可能显示 Cache hit。
5. 只有希望忽略缓存并重新计算时才点击 Regenerate。

没有配置外部模型密钥时，平台会使用 local-evidence-engine。这个结果适合离线演示和检查诊断
契约，不应被误解为外部大模型已经完成了真实推理。

## 4. Dashboard 操作说明

### 4.1 项目选择与创建

Dashboard 首页展示所有项目及其 Grouped issues 和 Total events。

- 点击项目卡片进入该项目的 Issues 页面。
- 点击 New project，输入 2 至 80 个字符的名称并提交。
- 进入项目后，可通过左上角 Active project 下拉框切换项目。
- 点击左上角 TracePilot 标志可返回项目首页。

创建真实接入项目时，还需要保存项目 ID 和 DSN Key。当前本地 MVP 的界面尚未单独展示 DSN
Key，可通过项目 API 获取：

```bash
curl http://localhost:4318/api/v1/projects
```

也可以直接通过 API 创建项目，创建响应会包含 id 和 dsnKey：

```bash
curl -X POST http://localhost:4318/api/v1/projects \
  -H "content-type: application/json" \
  -d '{"name":"Customer portal"}'
```

DSN Key 是浏览器使用的公开接入键，不是管理员密钥。新建项目的 SDK 必须同时使用该项目自己的
id 和 dsnKey；两者不匹配时服务端会拒绝事件。

### 4.2 Issues：筛选和分诊

页面顶部显示四类概览：

- Unresolved：尚未处理的 Issue 数。
- Events / 24 h：最近 24 小时接收的事件数。
- Affected users：最近 24 小时出现过的去重用户数。
- Tracked releases：当前项目记录的 Release 数。

Evidence volume 图表展示最近 24 小时的小时级错误趋势。

筛选栏支持：

| 控件                        | 作用                                    |
| --------------------------- | --------------------------------------- |
| Search title or fingerprint | 搜索 Issue 标题或指纹，输入后按 Enter   |
| Issue status                | 筛选 unresolved、resolved 或 ignored    |
| Severity                    | 筛选 error、warning 或 info             |
| Release                     | 只看某个发布版本                        |
| Browser                     | 只看 Chrome、Edge、Firefox 或 Safari    |
| Time window                 | 查看最近 24 小时、7 天、30 天或全部时间 |
| Route contains              | 按路由片段筛选，输入后按 Enter          |
| Last seen                   | 在最近出现时间的升序和降序之间切换      |

筛选条件会保存在 URL 查询参数中，因此刷新页面或复制链接后仍能恢复当前视图。按 Command+K
或 Ctrl+K 可以快速把焦点移到搜索框。Compact rows 可在紧凑行和舒适行之间切换。

列表中的每一行依次展示级别、标题、指纹前缀、最新 Release、状态、事件数、用户数、趋势和最后
出现时间。点击整行进入 Issue 详情。

### 4.3 Issue 详情：阅读证据

详情页右上角可修改状态：

- Unresolved：仍需调查或修复。
- Resolved：已经处理完成。
- Ignored：已确认无需处理。

状态更改会立即写回服务端。建议在验证修复已经发布且错误不再出现后再标记为 Resolved。

详情页包含六个标签：

| 标签        | 主要内容                                  | 建议用途                       |
| ----------- | ----------------------------------------- | ------------------------------ |
| overview    | 事件数、用户数、Release、最新路由及分布图 | 先判断影响范围和集中区域       |
| stack       | 原始源码堆栈和浏览器压缩堆栈              | 确认具体文件、函数和行列       |
| breadcrumbs | 点击、路由、请求和错误的时间顺序          | 重建事故发生前后的操作路径     |
| network     | 方法、URL、耗时和 HTTP 状态               | 判断是否由接口失败或慢请求引发 |
| events      | 最近的事件样本、用户、Release、路由和时间 | 检查问题是否跨用户或跨版本     |
| diagnosis   | 证据引用、可能原因、置信度和调查步骤      | 在人工核验证据后获得辅助建议   |

Overview 中的 Browser share、Route share 和 Release share 用于判断问题是否集中在特定环境。
Source location 显示最新样本的源码位置；没有匹配 Source Map 时会明确显示压缩堆栈或无堆栈，
不会伪造源码位置。

### 4.4 Performance：查看真实用户指标

Performance 页面当前汇总最近 7 天的浏览器样本：

| 指标 | 含义                                       |
| ---- | ------------------------------------------ |
| LCP  | 主要内容完成渲染的速度                     |
| INP  | 用户交互后的响应延迟                       |
| CLS  | 页面布局意外移动的程度；该指标没有毫秒单位 |
| FCP  | 首个内容完成绘制的时间                     |
| TTFB | 收到首字节前的服务端与网络耗时             |

每张指标卡展示 p50、p75、p95、样本数和评级。平台使用 p75 作为主要体验判断值。

通过 Compare metric 下拉框选择指标后，可查看：

- By release：不同版本的 p75 对比。
- By route：不同页面路由的 p75 对比。
- By browser：不同浏览器的 p75 对比。
- p75 trend：最近 7 天的日趋势。

图表中的 0 表示尚未收到匹配样本，不应直接解释为性能耗时为 0。

### 4.5 Releases：创建版本并上传 Source Map

建议每次部署按以下顺序操作：

1. 点击 Create release。
2. 输入与 SDK release 完全一致的版本号。
3. 可选填写 Commit SHA，便于追溯构建提交。
4. 保存后展开该 Release。
5. 在 Minified file name 中填写堆栈里压缩文件的文件名，例如
   checkout.a81e93bd.js。
6. 选择与该构建完全对应的 .map 文件。
7. 点击 Upload private map。
8. 回到相关 Issue 的 stack 标签确认出现 Mapped to source。

匹配使用 Release 和压缩文件 basename 两个条件。URL 查询参数和目录会被去掉，因此通常填写
app.a1b2c3.js 这样的文件名，而不是完整 URL。

上传限制：

- 只接受 .map 文件。
- 必须是 version 3 Source Map。
- 单个文件不超过 10 MB。
- 文件仅保存在服务端私有目录，不提供浏览器下载接口。
- 为同一 Release 和文件名重新上传时会替换原记录。

上传成功后，服务端会重新尝试解析同一 Release 的历史事件；之后进入的新事件也会在入库时尝试
解析。Release 不一致或文件名不一致时会保留原始浏览器堆栈，不影响其他调查功能。

## 5. 接入业务 Web 应用

当前 SDK 是仓库内的 workspace 包，尚未发布到公共包仓库。在本仓库内的应用可直接依赖
@trace-pilot/monitor-sdk；外部项目需要先通过组织自己的包仓库发布，或使用本地 workspace/link
方式接入。

基础示例：

```ts
import { createMonitor } from '@trace-pilot/monitor-sdk';

const monitor = createMonitor({
  dsn: 'https://monitor.example.com/api/v1/envelopes',
  dsnKey: '项目的公开接入键',
  projectId: '项目 ID',
  release: '2.5.0',
  environment: 'production',
  user: { id: '内部不可逆用户标识' },
  beforeSend(event) {
    return event;
  },
});

monitor.start();
```

建议在应用入口初始化一次，在登录状态变化时更新用户，在应用卸载时销毁：

```ts
monitor.setUser({ id: 'user-42' });
monitor.captureException(new Error('Checkout failed'), { module: 'checkout' });
monitor.captureMessage('Inventory response omitted warehouseId', 'warning');

monitor.addBreadcrumb({
  type: 'custom',
  category: 'checkout',
  message: 'User confirmed payment',
});

await monitor.flush();
monitor.setUser(undefined);
monitor.destroy();
```

常用配置：

| 配置          | 必填         | 默认值    | 说明                                       |
| ------------- | ------------ | --------- | ------------------------------------------ |
| dsn           | 是           | 无        | 完整事件接入地址，结尾为 /api/v1/envelopes |
| dsnKey        | 建议显式填写 | projectId | 项目的公开接入键                           |
| projectId     | 是           | 无        | 必须与 DSN Key 对应                        |
| release       | 是           | 无        | 必须与 Releases 中的版本完全一致           |
| environment   | 是           | 无        | development、test 或 production            |
| user          | 否           | 无        | id 或 anonymousId，用于影响用户去重        |
| sampleRate    | 否           | 1         | 0 至 1 的采样率                            |
| batchSize     | 否           | 10        | 1 至 100 条事件一批                        |
| flushInterval | 否           | 5000 ms   | 定时发送间隔                               |
| maxRetries    | 否           | 2         | 失败后的有限重试次数                       |
| dedupeWindow  | 否           | 5000 ms   | 相同错误的短窗口去重时间                   |
| beforeSend    | 否           | 原样返回  | 发送前删除字段或返回 null 取消事件         |

createMonitor 默认启用：

- 运行时错误、未处理 Promise 和资源加载错误。
- Fetch 与 XMLHttpRequest 结果及耗时。
- 点击和 SPA 路由 Breadcrumb。
- LCP、INP、CLS、FCP、TTFB。
- 批量、定时、页面隐藏时的发送，以及有限重试。

## 6. 隐私与数据边界

建议业务侧始终在 beforeSend 中执行自己的最小化采集策略。服务端还会独立进行第二次脱敏，但
这不替代业务方对数据范围的判断。

当前默认行为：

- URL 会移除 query 和 fragment。
- Authorization、Cookie、password、token、secret、apiKey 等敏感键会被遮蔽。
- 请求体默认不采集。
- Breadcrumb 最多保留 100 条。
- 单批事件最多 100 条，接入请求体上限为 1 MB。
- Source Map、SQLite 数据库和环境变量文件不会提交到 Git。
- 送往诊断提供方的上下文会再次脱敏。

不要把姓名、邮箱、手机号或订单明文直接作为 user.id。优先使用内部不可逆标识或匿名 ID。

## 7. AI 诊断配置与解读

### 7.1 离线模式

未配置 MODEL_API_KEY 时，Server 使用 local-evidence-engine。监控接入、查询、聚合、Source Map
和 Dashboard 均可正常使用。

### 7.2 外部模型

```bash
cp .env.example apps/server/.env
```

然后在 apps/server/.env 中配置：

```dotenv
MODEL_API_KEY=你的服务端密钥
MODEL_API_URL=https://api.openai.com/v1
MODEL_NAME=gpt-5.6-terra
```

重新启动 pnpm dev 后生效。通过 pnpm filter 运行时，Server 的工作目录是 apps/server，因此
不要把该文件只放在仓库根目录。API Key 只由 Server 读取，不要放入 VITE_ 开头的变量，也不要
写进浏览器应用。

### 7.3 如何解读诊断

- Evidence cited 应能回指 stack、breadcrumb、network、performance 或 release 证据。
- Confidence 表示候选原因相对可信度，不代表已经证明根因。
- Investigation steps 用于安排下一步验证。
- Suggested changes 是建议，不会自动修改代码。
- Evidence still missing 提醒当前结论还缺少什么信息。
- Model、Latency、Tokens 和 Cache hit 用于追踪诊断成本与来源。

模型失败只影响本次诊断，不会中断事件接入和人工调查。TracePilot 不会执行 Shell、运行测试或
自动修改业务代码。

## 8. 推荐的日常排障顺序

1. 在 Issues 使用状态、级别、时间、Release、浏览器和路由缩小范围。
2. 从事件数、影响用户数和分布图判断影响面。
3. 在 breadcrumbs 按时间顺序还原用户操作。
4. 在 network 检查失败请求和耗时。
5. 在 stack 确认是否已经映射到正确源码。
6. 在 events 对比不同用户、路由和 Release 的样本。
7. 最后生成 diagnosis，并逐条核对其证据引用。
8. 完成修复和验证后，将 Issue 标记为 Resolved；确认无需处理时标记为 Ignored。

这套顺序可以避免先看到模型建议，再反向挑选支持建议的证据。

## 9. 常见问题

### Dashboard 打不开

先访问 http://localhost:4318/health，再检查 pnpm dev 的终端输出。Dashboard 默认使用 4173，
Playground 使用 4174，Server 使用 4318；端口被占用时需要先停止冲突进程或修改对应配置。

### Dashboard 能打开但没有 Issue

- 确认选择了正确项目。
- 清除 Issue 页面上的状态、时间、Release 和路由筛选。
- 在 Playground 触发场景后点击 Flush event buffer。
- 刷新 Issues 页面。
- 检查 SDK 的 projectId 和 dsnKey 是否属于同一项目。

### 事件接口返回 INVALID_DSN 或 PROJECT_DSN_MISMATCH

INVALID_DSN 表示 dsnKey 不存在；PROJECT_DSN_MISMATCH 表示事件中的 projectId 与该接入键所属
项目不一致。重新从项目 API 获取这两个值并成对配置。

### Source Map 上传成功但没有源码堆栈

- SDK release 必须和 Releases 页面中的版本完全一致。
- Minified file name 必须与浏览器堆栈中的文件 basename 一致。
- .map 必须来自同一次构建，并且是有效的 version 3 Source Map。
- 选中的事件本身必须包含可解析的堆栈和行列号。

### 诊断显示 local-evidence-engine

这是未配置 MODEL_API_KEY 时的预期行为。若需要外部模型，请按第 7.2 节配置服务端环境变量并
重启服务。

### 新事件没有立刻出现

SDK 默认按批量或 5 秒间隔发送。可调用 await monitor.flush() 强制发送，然后刷新 Issues 页面。

### 演示数据需要恢复

```bash
pnpm seed
```

该命令会重建 demo-project 数据，执行前确认不需要保留现有本地演示事件。

## 10. 当前 MVP 限制

- 仅面向本地单用户使用，没有身份认证和租户隔离。
- 没有生产级限流、数据保留策略和水平扩展。
- SDK 尚未发布到公共包仓库。
- 没有 Session Replay。
- 没有项目、Release、Source Map 或事件删除界面。
- 不会自动修改代码、执行命令或替用户完成修复。
- 本地 SQLite 与微基准结果不代表生产 SLA。

部署到真实环境前，需要补充鉴权、授权、TLS、限流、数据生命周期、备份恢复、审计和生产容量
验证。

## 11. 相关文档

- [README](../README.md)：项目概览、命令与技术边界。
- [代码阅读指南](code-reading-guide.md)：技术栈地图、数据流和推荐源码阅读顺序。
- [演示脚本](demo-script.md)：3 至 5 分钟演示讲解顺序。
- [事件信封格式](event-schema.md)：SDK 和 Server 的传输契约。
- [架构说明](architecture.md)：组件边界与数据流。
- [性能报告](reports/performance.md)：本地性能测量。
- [诊断评测报告](reports/diagnosis-evaluation.md)：诊断契约与缓存评测。

# Vite 构建插件

`@trace-pilot/vite-plugin`（`packages/vite-plugin`）在 `vite build` 时做三件事：给每个 JS 产物注入 **Debug ID**，把
Source Map 上传到服务端，并且不让 map 进入产物目录。服务端按 Debug ID 找 map，不再依赖 SDK 配置的版本号与上传时填的
一致。决策见 [ADR 0005](decisions/0005-debug-ids.md)，服务端一侧见 [server.md](server.md#77-debug-id-与构建插件)，
SDK 一侧见 [monitor-sdk.md](monitor-sdk.md#56-debug-id)。

## 1. 用法

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { tracepilotSourceMaps } from '@trace-pilot/vite-plugin';

export default defineConfig({
  plugins: [
    tracepilotSourceMaps({
      url: 'https://tracepilot.example.com',
      projectId: 'checkout-web',
      release: process.env.RELEASE!, // 与 SDK 初始化时的 release 相同
    }),
  ],
});
```

| 选项          | 默认    | 含义                                                                  |
| ------------- | ------- | --------------------------------------------------------------------- |
| `url`         | —       | 服务端地址                                                            |
| `projectId`   | —       | 上传到哪个项目                                                        |
| `release`     | —       | 上传到哪个版本；没有就创建                                            |
| `failOnError` | `true`  | 上传失败时让构建失败。设为 `false` 时只打印警告                       |
| `dryRun`      | `false` | 只注入 Debug ID、不上传；map 照样不进产物目录。没有服务端的本地构建用 |

插件只在 `vite build` 时生效（`apply: 'build'`）。它会把 `build.sourcemap` 设为 `hidden`：生成 map，但产物里不写
`sourceMappingURL`。用户配置的 `true` 或 `inline` 会被替换并打印一条警告：`true` 会留下一个指向已被拿走的文件的注释，
`inline` 直接把源码嵌进产物。

演练场的生产模式就是这样接入的：`apps/playground/vite.lab.config.ts` 在 `vite.config.ts` 之上加这个插件，
`pnpm --filter @trace-pilot/playground lab:production` 构建、上传、预览。它是一个单独的配置文件：Vite 加载配置时会解析
其中的每个 import（包括动态 import），而插件包要先构建才有可加载的入口；`lab:production` 会先构建依赖，`pnpm dev` 不会。

## 2. 构建时发生了什么

```text
vite build
  ├─ config          build.sourcemap = 'hidden'
  ├─ generateBundle  对每个 JS 产物：
  │                    Debug ID = SHA-256(压缩后的代码) 取 128 位，按 UUID v4 写版本号和变体位
  │                    产物开头插入一行登记代码，末尾加 //# debugId=<id>
  │                    map 的 mappings 前面加一个分号，写入 "debugId": "<id>"
  │                    从 bundle 里删掉 map：它不会被写进 dist
  └─ writeBundle     产物写盘之后，把 map 逐个上传到「项目 + 版本」下
```

注入后的产物：

```js
;!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},s=(new Error).stack;s&&((g.__TRACEPILOT_DEBUG_IDS__=g.__TRACEPILOT_DEBUG_IDS__||{})[s]="1cba3b97-0951-49b4-825d-9c4b1d41a5c3")}catch(e){}}();
var e=(e,t)=>()=>…
//# debugId=1cba3b97-0951-49b4-825d-9c4b1d41a5c3
```

### 2.1 为什么在 generateBundle 里注入

`renderChunk` 时代码还没压缩完，之后还会变；`generateBundle` 时代码已经是最终部署出去的样子，Debug ID 对应的就是它。
代价是文件名里的内容哈希是注入之前算的。注入的内容完全由注入前的代码决定，所以哈希仍然随内容变化，缓存失效不受影响。

### 2.2 map 怎么跟着改

`mappings` 用分号分隔产物的每一行。登记代码单独占一行插进去，map 只需在对应位置多一个分号：后面所有行的映射整体下移
一行，行内的列号不受影响。如果插在第一行的开头而不换行，压缩成一行的产物里每一个位置的列号都要改。

一般插在最前面。开头是 `#!`（Node 脚本）或独占一行的 `'use strict'`（CJS / IIFE 产物）时插在它后面：`#!` 必须是文件的
第一行，`'use strict'` 只有作为第一条语句才生效。

### 2.3 为什么要注入代码

ECMA-426（Source Map 规范）的 Debug ID 提案只规定了 map 里的 `debugId` 字段和产物末尾的 `//# debugId=` 注释，浏览器还没有
在运行时读取它的接口。登记代码在文件顶层 `new Error()`，它的 stack 第一帧就是文件自己的地址：

- 不直接写地址：构建时不知道文件最终部署在哪个域名、哪个路径下；
- 不用 `document.currentScript`：ES 模块里它是 null；
- 不用 `import.meta.url`：只有 ES 模块才有。

Sentry 的构建插件也是这样做的。整段包在 `try` 里，任何异常都不影响业务代码执行。

### 2.4 Debug ID 由内容决定

同样的内容永远得到同样的 Debug ID：重新构建出相同的文件，重新上传的是同一份 map，服务端替换而不是新增；内容变了，
Debug ID 一定跟着变。没改动的 vendor 文件在两个版本里 Debug ID 相同，服务端因此不要求 Debug ID 全局唯一。

## 3. 上传

- 先查项目的版本列表，没有这个版本就创建（`POST /api/v1/projects/:projectId/releases`）。SDK 上报时服务端也会按版本号
  自动创建版本，先到先得。
- 逐个 `POST /api/v1/releases/:releaseId/source-maps`，`minifiedFile` 是产物的文件名。逐个而不是并发：一次构建只有几个到
  几十个 chunk，服务端每收到一份都要完整校验、回填历史事件，并发只会让它们互相抢 CPU。
- 失败默认让构建失败：map 没传上去，线上的错误既还原不了源码，聚合也只能按压缩后的位置进行（同一个 bug 每次发版都成了
  新 Issue），宁可在构建时就发现。错误信息带着服务端的原文，例如 400 时 map 哪里不合格。

## 4. 测试

`packages/vite-plugin/test/`，8 项：

| 文件              | 覆盖                                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debugId.test.ts` | 同样内容同样的 UUID；登记代码在真实的 JS 引擎里执行后写入登记表；插入一行后 map 的映射正好下移一行（用 source-map 库核对）；保留 `#!` 和 `'use strict'` 在最前面                                                                                                                                            |
| `plugin.test.ts`  | 真的跑一次 `vite build`（库模式，入口加一个懒加载 chunk），对一个本地起的假服务端：每个产物一个 Debug ID、map 带同一个 ID、产物目录里没有 map；在独立的 Node 进程里执行产物、抛错，用上传的 map 把真实堆栈换算回 fixture 的 throw 那一行；dry run 不上传；上传失败让构建失败，`failOnError: false` 时不失败 |

## 5. 已知限制

- 只支持 Vite（Rollup 系的 `generateBundle`）。webpack、Rspack、esbuild 需要各自的插件，思路相同。
- 上传接口和服务端其他管理接口一样没有鉴权，插件也就没有令牌参数。
- 每个 JS 产物多一行登记代码和一行注释：登记代码 239 字节（单独 gzip 199 字节，混在整个文件里压缩后更少）。

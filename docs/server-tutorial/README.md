# Node + HTTP 练习环境

给「前端很熟、服务端没写过」的同学准备的第二份材料。SQL 教程解决「数据怎么查」，
这份解决「数据怎么经过 HTTP 安全地收进来、发出去」。

练完之后，`apps/server/src` 下那 2500 行代码里的 HTTP 层对你就没有黑盒了。

配套教程（对照译文形式，17 章 + 12 道练习）：
<https://claude.ai/code/artifact/a51adc2d-3c22-4be8-a2c3-06a6da3f1474>

## 为什么不用装依赖

整套练习只用 Node 内置的 `node:http`，**零依赖、零启动 flag**（比 SQL 教程还省事，
那边还需要 `--experimental-sqlite`）。数据层是内存对象，不需要数据库。

学习目标是 HTTP 与 Node 运行时，不是再练一遍 SQL——所以数据层被刻意做薄了。
但它的每个方法都标注了对应的真实 SQL，换成数据库之后 HTTP 层一行都不用改。

## 用法

```bash
# 1. 看有哪些题
node docs/server-tutorial/serve.mjs --list

# 2. 看某一题的题面
node docs/server-tutorial/serve.mjs 01 --prompt

# 3. 写答案到 answers/01.mjs，然后判分
node docs/server-tutorial/check.mjs 01     # 单题（会顺便打印题面）
node docs/server-tutorial/check.mjs        # 全部

# 4. 写不出来时，把答案跑成真 server 手动戳
node docs/server-tutorial/serve.mjs 01
# 它会把判分用的 curl 命令直接打印出来，复制粘贴即可
```

命令太长可以先设别名：

```bash
alias tp-check='node docs/server-tutorial/check.mjs'
alias tp-serve='node docs/server-tutorial/serve.mjs'
```

## 答案文件长什么样

`answers/<编号>.mjs`，default 导出一个函数：

```js
export default function handler(req, res, store) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: 'ok' }));
}
```

- `req` / `res` 就是 `node:http` 的原生参数，没有任何包装。
- `store` 是数据层，对应真实项目里 `registerIssueRoutes(app, database)` 注入的那个 `database`。
- handler 可以是 `async` 函数，判分器会 await。

判分方式是**用真实 HTTP 请求打你的 handler、比对响应**，不比对代码文本。
所以写法和参考答案不同、但行为一致就算通过——用正则还是 `split`、用 `writeHead`
还是 `setHeader`、用 `req.on('data')` 还是 `for await`，都可以。

## 12 道题的安排

| #   | 题目                                 | 对应项目里的代码                           |
| --- | ------------------------------------ | ------------------------------------------ |
| 01  | 返回一个 JSON 响应                   | `app.ts` 的 `/health`                      |
| 02  | 按请求方法分流                       | 所有路由的方法约定                         |
| 03  | 读取查询参数做分页                   | `routes/issues.ts` 的分页                  |
| 04  | 匹配路径参数                         | `routes/issues.ts:47`                      |
| 05  | 读取请求 body（它是一个流）          | 所有 POST / PATCH 路由                     |
| 06  | 用状态码表达不同的失败               | `routes/issues.ts:63`                      |
| 07  | CORS 与预检请求                      | `app.ts` 的 `@fastify/cors`                |
| 08  | 把不可信的查询参数夹进合法区间       | `routes/issues.ts:16` 的 `positiveInteger` |
| 09  | 校验 body 的结构（手写一个迷你 Zod） | `routes/events.ts:12` 的 `safeParse`       |
| 10  | 入库前脱敏                           | `shared/redaction.ts`                      |
| 11  | 幂等：同一批事件重发不能重复入库     | `services/events.ts` 的 eventId 去重       |
| 12  | 把前面全部拼起来：真正的接入端点     | `routes/events.ts` + `services/events.ts`  |

前 5 题是 HTTP 机制，6–8 题是服务端语义，9–11 题是**信任边界**，12 题把前面全部合起来，
写出来的东西结构上就是 TracePilot 的接入端点。

## 数据里刻意埋的东西

数据身份与 SQL 教程完全一致（`demo-project`、`iss-hydrate`、`evt-0001`…），
两套练习讲的是同一个系统。同样保留了那几个教学陷阱：

- `legacy-admin` 项目**没有任何 Issue** —— 练习 03 会撞上「空结果不是错误」。
- `iss-tax` 这个 Issue **一条事件都没有** —— 练习 12 用它验证新用户计数。
- 2 条事件的 `issueId` 和 `userId` 是 `null` —— 练习 12 要求跳过它们。

## 练习 12 是重点

它复现了 TracePilot 真实踩过的坑：**「该用户是否已出现」的判定必须在事件落库之前执行**，
否则会查到刚写入的那一行，`user_count` 恒为 0。

这个 bug 的隐蔽之处在于 **HTTP 响应完全正确**，只有数据库里的计数是错的。
所以第 12 题的判分除了比对响应，还会比对写入后的数据状态——
就像真实项目里那条专门锁定这个顺序的回归测试。

## 和其它材料的关系

- 上一份：[SQL 练习环境](../sql-tutorial/README.md)
- 下一步：[代码阅读指南](../code-reading-guide.md) 第 4–7 步，开始读真实 server 代码
- 架构全景：[architecture.md](../architecture.md)

`answers/` 已被 `.gitignore` 忽略，随便写不会污染仓库。

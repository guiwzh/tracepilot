# SQL 练习环境

给不熟悉数据库的同学准备的 SQL 入门材料。表结构与 `apps/server/src/db/client.ts`
完全一致，因此在这里练熟的查询可以直接用到 TracePilot 上。

配套教程（对照译文形式，20 章 + 12 道练习）：
<https://claude.ai/code/artifact/2846701b-6532-4cc2-a2c2-d98e8b360457>

## 为什么不用装依赖

Node 22 内置了 `node:sqlite`，所以这套脚本不依赖 `better-sqlite3`，
在没有 `pnpm install` 过的仓库里也能直接跑。

## 用法

```bash
# 1. 生成练习库（3 个项目、8 个 Issue、67 条事件，确定性数据）
node --experimental-sqlite docs/sql-tutorial/seed.mjs

# 2. 执行任意查询
node --experimental-sqlite docs/sql-tutorial/q.mjs "SELECT * FROM projects"
node --experimental-sqlite docs/sql-tutorial/q.mjs --schema        # 看表结构
node --experimental-sqlite docs/sql-tutorial/q.mjs -f 某个文件.sql  # 从文件读

# 3. 做练习：答案写进 answers/<编号>.sql，然后判分
echo "SELECT id, name FROM projects ORDER BY id" > docs/sql-tutorial/answers/01.sql
node --experimental-sqlite docs/sql-tutorial/check.mjs 01   # 单题
node --experimental-sqlite docs/sql-tutorial/check.mjs      # 全部
```

命令太长可以先设别名：

```bash
alias q='node --experimental-sqlite docs/sql-tutorial/q.mjs'
```

## 文件说明

| 文件            | 作用                                                       |
| --------------- | ---------------------------------------------------------- |
| `seed.mjs`      | 建库建表 + 灌入确定性数据，重复执行会重建                  |
| `q.mjs`         | 查询执行器，把结果打印成对齐表格                           |
| `check.mjs`     | 12 道练习的题面与参考答案，按结果集判分                    |
| `answers/`      | 你写的答案，`.gitignore` 已忽略                            |
| `tutorial.html` | 教程正文，Artifact 的页面源码（无 `<html>`/`<body>` 外壳） |

## 数据里刻意埋的东西

这些不是随手造的数据，每一条都为某个教学点服务：

- `legacy-admin` 项目**没有任何 Issue** —— 用来体现 `JOIN` 与 `LEFT JOIN` 的差别。
- `iss-tax` 这个 Issue **一条事件都没有** —— 用来演示 `LEFT JOIN` 后
  `COUNT(*)` 会错报成 1 的经典陷阱。
- 2 条事件的 `issue_id` 和 `user_id` 是 `NULL` —— 用来演示 `IS NULL` 与
  `COUNT(*)` / `COUNT(列)` 的区别。
- `rel-m-1-0` 的 `commit_sha` 是 `NULL` —— 用来演示 `= NULL` 永远匹配不到任何行。

练习库写在 `docs/sql-tutorial/.data/`（已被 `.gitignore` 忽略），
与项目自己的 `apps/server/.tracepilot/` 完全隔离，怎么折腾都不影响开发数据。

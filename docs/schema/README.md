# 数据结构 ER 图

`apps/server/src/db/client.ts` 里那段 `INITIAL_SCHEMA` 的可视化：六张表、46 个列、
6 条外键、17 个索引。

在线查看：<https://claude.ai/artifact/D2jTUZHwqpeg1HFoFiBSnV>

## 这张图不是手画的

`generate.mjs` 会读取 `client.ts` 里的 DDL，**在临时目录真实建一个库**，再用
`PRAGMA table_info` / `foreign_key_list` / `index_list` 把结构读回来渲染成 SVG。

所以图和代码不可能对不上。手画的图迟早会变成第三处需要手动同步的地方——
项目里已经有 `client.ts` 的 DDL 和 `db/schema.ts` 两处要同步了，不该再添一处。

## 表结构改了之后

```bash
node --experimental-sqlite docs/schema/generate.mjs
```

需要 Node 22+（`node:sqlite` 是内置模块，但目前仍需 `--experimental-sqlite`）。
命令只依赖 Node，不需要 `pnpm install`。

生成完把 `er-diagram.html` 重新发布一次，在线版本就同步了。

## 文件说明

| 文件              | 作用                                             |
| ----------------- | ------------------------------------------------ |
| `generate.mjs`    | 内省数据库 + 渲染 SVG 和索引表格，注入模板       |
| `template.html`   | 页面骨架：样式、说明文字、交互脚本，含两个占位符 |
| `er-diagram.html` | **生成产物，不要手改**——改了会被下次生成覆盖     |

`template.html` 里的两个占位符 `<!--ER-SVG-->` 和 `<!--INDEX-ROWS-->` 由生成器填充。
想改样式或说明文字，改模板然后重新生成。

## 新增表的话

`generate.mjs` 里的 `layout` 写死了每张表的坐标（三列，按数据血缘从左到右排）。
新表没有坐标时生成器会直接报错，而不是画出一张错位的图：

```
Error: 表 xxx 没有布局坐标，请在 layout 里补上
```

补一个 `{ x, y }` 即可。连线、箭头、列表全部自动算。

## 图里在讲什么

颜色编码的是外键的删除策略，这是整段 DDL 里最值得讲的设计决定：

- **红实线 CASCADE**（4 条）——父记录没了，子记录一起删
- **绿虚线 SET NULL**（2 条）——父记录没了，子记录留着，外键置空

判断标准只有一句：**这条子记录脱离父记录之后，还有价值吗？**

`events` 是唯一用 `SET NULL` 的表。因为 Issue 是归纳出来的、Release 是关联上去的，
但事件本身是浏览器上真实发生过的观测记录——删掉归纳结论，不该抹掉原始观测。
这也是 SQL 教程练习数据里那两条 `issue_id` 为 `NULL` 的「孤儿事件」的由来。

## 相关材料

- [SQL 练习环境](../sql-tutorial/README.md)
- [Node + HTTP 练习环境](../server-tutorial/README.md)
- [代码阅读指南](../code-reading-guide.md)

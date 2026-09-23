/**
 * 从真实数据库内省结果生成 ER 图页面。
 *
 *   node --experimental-sqlite docs/schema/generate.mjs
 *
 * 流程：读取 apps/server/src/db/client.ts 里的 INITIAL_SCHEMA → 在临时目录真实建库
 * → PRAGMA table_info / foreign_key_list / index_list 内省 → 渲染 SVG 与索引表格
 * → 注入 template.html → 写出 er-diagram.html。
 *
 * 为什么不手写这张图：六张表 46 个列，手算坐标必然出错，而且改了表结构就会过期。
 * 由 DDL 生成意味着图和代码不可能对不上——表结构一变，重跑一次即可。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const clientPath = resolve(repoRoot, 'apps/server/src/db/client.ts');

// ---------------------------------------------------------------- 内省
/** 把 client.ts 里的 DDL 抽出来，在临时库上真实执行一遍再读回结构。 */
function introspect() {
  const source = readFileSync(clientPath, 'utf8');
  const marker = 'const INITIAL_SCHEMA = `';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`在 ${clientPath} 里找不到 INITIAL_SCHEMA`);
  const ddl = source.slice(start + marker.length).split('`;')[0];

  const dir = mkdtempSync(join(tmpdir(), 'tracepilot-er-'));
  const db = new DatabaseSync(join(dir, 'introspect.db'));
  try {
    db.exec(ddl);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    const schema = {};
    for (const table of tables) {
      schema[table] = {
        columns: db.prepare(`PRAGMA table_info(${table})`).all(),
        foreignKeys: db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
        indexes: db
          .prepare(`PRAGMA index_list(${table})`)
          .all()
          .map((ix) => ({
            name: ix.name,
            unique: !!ix.unique,
            // origin 'c' = CREATE INDEX 显式建的；'u' / 'pk' = UNIQUE/PRIMARY KEY 约束自动生成。
            explicit: ix.origin === 'c',
            cols: db
              .prepare(`PRAGMA index_info(${ix.name})`)
              .all()
              .map((c) => c.name),
          })),
      };
    }
    return schema;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const schema = introspect();

// ---------------------------------------------------------------- 布局
const W = 268; // 表框宽
const ROW = 16; // 每列行高
const HEAD = 27; // 表头高
const PAD = 7;

/** 三列，按数据血缘从左到右排：根表 → 一级子表 → 二级子表。 */
const layout = {
  projects: { x: 24, y: 262 },
  releases: { x: 392, y: 84 },
  issues: { x: 392, y: 322 },
  source_maps: { x: 760, y: 24 },
  events: { x: 760, y: 194 },
  diagnoses: { x: 760, y: 474 },
};

for (const table of Object.keys(schema)) {
  if (!layout[table]) throw new Error(`表 ${table} 没有布局坐标，请在 layout 里补上`);
}

const boxH = (t) => HEAD + schema[t].columns.length * ROW + PAD;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fkByCol = {};
for (const [table, info] of Object.entries(schema)) {
  fkByCol[table] = {};
  for (const fk of info.foreignKeys) fkByCol[table][fk.from] = fk;
}

// ---------------------------------------------------------------- 表框
function tableSvg(name) {
  const { x, y } = layout[name];
  const info = schema[name];
  const h = boxH(name);
  const parts = [
    `  <g class="tbl" data-table="${name}" tabindex="0" role="listitem" aria-label="表 ${name}">`,
    `    <rect class="tbl-box" x="${x}" y="${y}" width="${W}" height="${h}" rx="8"/>`,
    `    <path class="tbl-head" d="M${x} ${y + 8} a8 8 0 0 1 8 -8 h${W - 16} a8 8 0 0 1 8 8 v${HEAD - 8} h${-W} z"/>`,
    `    <text class="tbl-name" x="${x + 11}" y="${y + 18}">${name}</text>`,
    `    <text class="tbl-count" x="${x + W - 11}" y="${y + 18}" text-anchor="end">${info.columns.length} 列</text>`,
  ];

  info.columns.forEach((col, i) => {
    const cy = y + HEAD + i * ROW + 12;
    const fk = fkByCol[name][col.name];
    if (col.pk || fk) {
      const cls = col.pk
        ? 'badge-pk'
        : `badge-fk ${fk.on_delete === 'CASCADE' ? 'is-cascade' : 'is-setnull'}`;
      parts.push(
        `    <text class="badge ${cls}" x="${x + 11}" y="${cy}">${col.pk ? 'PK' : 'FK'}</text>`,
      );
    }
    // SQLite 只有 INTEGER PRIMARY KEY 隐含 NOT NULL，其它类型主键仍可为空，
    // 所以这里把主键单独排除，避免把 id 标成 nullable 误导读者。
    const nullable = !col.notnull && !col.pk;
    parts.push(
      `    <text class="col-name${nullable ? ' is-null' : ''}" x="${x + 40}" y="${cy}">${esc(col.name)}</text>`,
    );
    const type = col.type === 'INTEGER' ? 'INT' : col.type;
    parts.push(
      `    <text class="col-type" x="${x + W - 11}" y="${cy}" text-anchor="end">${type}${nullable ? ' ·null' : ''}</text>`,
    );
  });

  parts.push('  </g>');
  return parts.join('\n');
}

// ---------------------------------------------------------------- 连线
/** 父表右缘 → 子表左缘，三次贝塞尔平滑走线。 */
function edgeSvg(childTable, fk, slot) {
  const parent = layout[fk.table];
  const child = layout[childTable];
  const x1 = parent.x + W;
  const y1 = parent.y + boxH(fk.table) / 2;
  const x2 = child.x;
  const y2 = child.y + boxH(childTable) * slot;
  // 控制点不得越过中点，否则曲线会回折成 S 形。
  const dx = Math.max(18, Math.min(60, (x2 - x1) * 0.45));
  const cascade = fk.on_delete === 'CASCADE';
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return [
    `  <g class="edge ${cascade ? 'is-cascade' : 'is-setnull'}" data-parent="${fk.table}" data-child="${childTable}">`,
    `    <path class="edge-line" d="M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" marker-end="url(#arw-${cascade ? 'c' : 's'})"/>`,
    `    <rect class="edge-chip" x="${mx - 37}" y="${my - 9}" width="74" height="17" rx="8"/>`,
    `    <text class="edge-label" x="${mx}" y="${my + 3}" text-anchor="middle">${cascade ? 'CASCADE' : 'SET NULL'}</text>`,
    '  </g>',
  ].join('\n');
}

// events 有两条入边，错开落点避免箭头重叠。
const slots = { 'events:releases': 0.3, 'events:issues': 0.72 };

const edges = [];
for (const [table, info] of Object.entries(schema)) {
  for (const fk of info.foreignKeys) {
    edges.push(edgeSvg(table, fk, slots[`${table}:${fk.table}`] ?? 0.5));
  }
}

const maxY = Math.max(...Object.keys(layout).map((t) => layout[t].y + boxH(t)));
const VB_W = 760 + W + 24;
const VB_H = maxY + 24;

const svg = `<svg class="er" viewBox="0 0 ${VB_W} ${VB_H}" role="img"
  aria-label="TracePilot 数据库 ER 图：projects 为根，releases 与 issues 挂在其下并级联删除；events 同时引用 releases 与 issues，但采用 SET NULL 保留原始证据；source_maps 与 diagnoses 级联删除。">
  <defs>
    <marker id="arw-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arw is-cascade" d="M0 0 L10 5 L0 10 z"/>
    </marker>
    <marker id="arw-s" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arw is-setnull" d="M0 0 L10 5 L0 10 z"/>
    </marker>
  </defs>
${edges.join('\n')}
${Object.keys(layout).map(tableSvg).join('\n')}
</svg>`;

// ---------------------------------------------------------------- 索引表格
const indexRows = [];
for (const [table, info] of Object.entries(schema)) {
  for (const ix of info.indexes) {
    indexRows.push({
      table,
      name: ix.name,
      cols: ix.cols.join(', '),
      unique: ix.unique,
      explicit: ix.explicit,
    });
  }
}
// 显式建的排前面，其余按表名、索引名排，保证每次生成结果稳定。
indexRows.sort(
  (a, b) =>
    Number(b.explicit) - Number(a.explicit) ||
    a.table.localeCompare(b.table) ||
    a.name.localeCompare(b.name),
);

const indexHtml = indexRows
  .map(
    (r) => `        <tr class="${r.explicit ? '' : 'is-auto'}">
          <td class="m">${r.explicit ? '<span class="tag tag-exp">显式</span>' : '<span class="tag tag-auto">自动</span>'}</td>
          <td class="m">${r.table}</td>
          <td class="m">${r.name}</td>
          <td class="m">(${r.cols})</td>
          <td class="m">${r.unique ? '<span class="tag tag-uniq">UNIQUE</span>' : ''}</td>
        </tr>`,
  )
  .join('\n');

// ---------------------------------------------------------------- 输出
const template = readFileSync(resolve(here, 'template.html'), 'utf8');
for (const placeholder of ['<!--ER-SVG-->', '<!--INDEX-ROWS-->']) {
  if (!template.includes(placeholder)) throw new Error(`template.html 缺少占位符 ${placeholder}`);
}
const page = template.replace('<!--ER-SVG-->', svg).replace('<!--INDEX-ROWS-->', indexHtml);
writeFileSync(resolve(here, 'er-diagram.html'), page);

const columnCount = Object.values(schema).reduce((n, t) => n + t.columns.length, 0);
console.log(
  `已生成 er-diagram.html —— ${Object.keys(schema).length} 表 / ${columnCount} 列 / ` +
    `${edges.length} 外键 / ${indexRows.length} 索引（显式 ${indexRows.filter((r) => r.explicit).length}）`,
);

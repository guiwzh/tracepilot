/**
 * 教程用的 SQL 执行器：把结果打印成对齐的表格。
 *
 *   node --experimental-sqlite docs/sql-tutorial/q.mjs "SELECT * FROM projects"
 *   node --experimental-sqlite docs/sql-tutorial/q.mjs -f docs/sql-tutorial/answers/01.sql
 *   node --experimental-sqlite docs/sql-tutorial/q.mjs --schema
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { DB_PATH } from './seed.mjs';

function render(rows) {
  if (rows.length === 0) return '(0 行)';
  const cols = Object.keys(rows[0]);
  const cell = (v) => (v === null ? 'NULL' : String(v));
  // 中文字符按两个终端列宽计算，否则表格会错位。
  const width = (s) => [...s].reduce((n, ch) => n + (/[一-龥＀-￯]/.test(ch) ? 2 : 1), 0);
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
  const widths = cols.map((c) => Math.max(width(c), ...rows.map((r) => width(cell(r[c])))));
  const line = (chars) => chars.map((c, i) => c.repeat(widths[i] + 2)).join('+');
  const out = [
    `+${line(cols.map(() => '-'))}+`,
    `| ${cols.map((c, i) => pad(c, widths[i])).join(' | ')} |`,
    `+${line(cols.map(() => '-'))}+`,
    ...rows.map((r) => `| ${cols.map((c, i) => pad(cell(r[c]), widths[i])).join(' | ')} |`),
    `+${line(cols.map(() => '-'))}+`,
  ];
  return `${out.join('\n')}\n(${rows.length} 行)`;
}

function readSql(argv) {
  if (argv[0] === '--schema') {
    return "SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type DESC, name";
  }
  if (argv[0] === '-f' || argv[0] === '--file') {
    if (!argv[1]) throw new Error('用法：q.mjs -f <文件路径>');
    return readFileSync(argv[1], 'utf8');
  }
  return argv.join(' ');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log('用法：node --experimental-sqlite docs/sql-tutorial/q.mjs "<SQL>"');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DB_PATH)) {
    console.error('练习库还没生成，先运行：node --experimental-sqlite docs/sql-tutorial/seed.mjs');
    process.exitCode = 1;
    return;
  }

  const sql = readSql(argv).trim();
  const db = new DatabaseSync(DB_PATH);
  try {
    // 只有 SELECT / WITH / PRAGMA 才有结果集，其余语句走 run() 并汇报影响行数。
    if (/^(select|with|pragma|explain)/i.test(sql)) {
      console.log(render(db.prepare(sql).all()));
    } else {
      const info = db.prepare(sql).run();
      console.log(`OK，影响 ${info.changes} 行`);
    }
  } catch (error) {
    console.error(`SQL 出错：${error.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();

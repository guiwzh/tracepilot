/**
 * 练习自测：把你的答案写进 answers/<编号>.sql，然后运行
 *
 *   node --experimental-sqlite docs/sql-tutorial/check.mjs 03
 *   node --experimental-sqlite docs/sql-tutorial/check.mjs        # 检查全部
 *
 * 判分方式是比对结果集而不是比对 SQL 文本，所以写法不同但结果对就算通过。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from './seed.mjs';

const answersDir = resolve(dirname(fileURLToPath(import.meta.url)), 'answers');

export const EXERCISES = [
  {
    id: '01',
    prompt: '列出所有项目的 id 和 name，按 id 升序。',
    solution: 'SELECT id, name FROM projects ORDER BY id',
  },
  {
    id: '02',
    prompt: '列出所有 status 为 unresolved 的 Issue 的 title 和 event_count，事件多的排前面。',
    solution: `SELECT title, event_count FROM issues
               WHERE status = 'unresolved' ORDER BY event_count DESC`,
  },
  {
    id: '03',
    prompt: '找出 event_count 在 5 到 20 之间（含两端）的 Issue 的 id 和 event_count，按 id 升序。',
    solution: `SELECT id, event_count FROM issues
               WHERE event_count BETWEEN 5 AND 20 ORDER BY id`,
  },
  {
    id: '04',
    prompt: "找出 level 是 warning、且 title 里含有 'Error' 的 Issue 的 id，按 id 升序。",
    solution: `SELECT id FROM issues
               WHERE level = 'warning' AND title LIKE '%Error%' ORDER BY id`,
  },
  {
    id: '05',
    prompt: '统计每个 status 各有多少个 Issue，列名用 status 和 n，按 status 升序。',
    solution: 'SELECT status, COUNT(*) AS n FROM issues GROUP BY status ORDER BY status',
  },
  {
    id: '06',
    prompt:
      '每个项目有多少个 Issue、这些 Issue 的 event_count 合计是多少。' +
      '输出 project_id、issue_count、total_events，按 project_id 升序。',
    solution: `SELECT project_id, COUNT(*) AS issue_count, SUM(event_count) AS total_events
               FROM issues GROUP BY project_id ORDER BY project_id`,
  },
  {
    id: '07',
    prompt:
      '在上一题基础上，只保留事件合计超过 10 的项目。' +
      '输出 project_id 和 total_events，按 total_events 降序。',
    solution: `SELECT project_id, SUM(event_count) AS total_events
               FROM issues GROUP BY project_id HAVING SUM(event_count) > 10
               ORDER BY total_events DESC`,
  },
  {
    id: '08',
    prompt:
      '把 Issue 和它所属的项目连起来，输出 Issue 的 title 和项目的 name（列名 project_name），' +
      '只要 level = error 的，按 title 升序。',
    solution: `SELECT i.title, p.name AS project_name
               FROM issues i JOIN projects p ON i.project_id = p.id
               WHERE i.level = 'error' ORDER BY i.title`,
  },
  {
    id: '09',
    prompt: '找出一条事件都没有的 Issue 的 id（用 JOIN 做，不要直接读 event_count）。',
    solution: `SELECT i.id FROM issues i
               LEFT JOIN events e ON e.issue_id = i.id
               WHERE e.id IS NULL ORDER BY i.id`,
  },
  {
    id: '10',
    prompt:
      '统计每个 Issue 的真实事件数与去重用户数，输出 issue_id、real_events、real_users，' +
      '按 real_events 降序、issue_id 升序。孤儿事件（issue_id 为 NULL）不算。',
    solution: `SELECT issue_id, COUNT(*) AS real_events, COUNT(DISTINCT user_id) AS real_users
               FROM events WHERE issue_id IS NOT NULL
               GROUP BY issue_id ORDER BY real_events DESC, issue_id`,
  },
  {
    id: '11',
    prompt:
      '列出所有项目的 name 和它们各自的 Issue 数量（列名 issue_count），' +
      '没有 Issue 的项目也要出现（数量为 0），按 name 升序。',
    solution: `SELECT p.name, COUNT(i.id) AS issue_count
               FROM projects p LEFT JOIN issues i ON i.project_id = p.id
               GROUP BY p.id, p.name ORDER BY p.name`,
  },
  {
    id: '12',
    prompt:
      '用窗口函数找出每个项目里 event_count 最高的那个 Issue，' +
      '输出 project_id、id、event_count，按 project_id 升序。event_count 为 0 的也算。',
    solution: `SELECT project_id, id, event_count FROM (
                 SELECT project_id, id, event_count,
                        ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY event_count DESC, id) AS rn
                 FROM issues
               ) WHERE rn = 1 ORDER BY project_id`,
  },
];

function run(db, sql) {
  return db.prepare(sql).all();
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkOne(db, exercise) {
  const file = resolve(answersDir, `${exercise.id}.sql`);
  if (!existsSync(file)) return { id: exercise.id, state: 'todo' };

  const sql = readFileSync(file, 'utf8').trim();
  if (!sql) return { id: exercise.id, state: 'todo' };

  const expected = run(db, exercise.solution);
  try {
    const actual = run(db, sql);
    if (same(expected, actual)) return { id: exercise.id, state: 'pass' };
    return {
      id: exercise.id,
      state: 'fail',
      detail:
        `期望 ${expected.length} 行，你的查询返回 ${actual.length} 行\n` +
        `  期望首行: ${JSON.stringify(expected[0] ?? null)}\n` +
        `  实际首行: ${JSON.stringify(actual[0] ?? null)}`,
    };
  } catch (error) {
    return { id: exercise.id, state: 'error', detail: error.message };
  }
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error('练习库还没生成，先运行：node --experimental-sqlite docs/sql-tutorial/seed.mjs');
    process.exitCode = 1;
    return;
  }
  const only = process.argv[2];
  const targets = only ? EXERCISES.filter((e) => e.id === only) : EXERCISES;
  if (targets.length === 0) {
    console.error(`没有编号为 ${only} 的题目`);
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  const marks = { pass: '✅', fail: '❌', error: '💥', todo: '⬜' };
  let failed = 0;
  for (const exercise of targets) {
    const result = checkOne(db, exercise);
    if (result.state === 'fail' || result.state === 'error') failed += 1;
    console.log(`${marks[result.state]} ${result.id}  ${exercise.prompt}`);
    if (result.detail) console.log(`   ${result.detail.replace(/\n/g, '\n   ')}`);
  }
  db.close();
  process.exitCode = failed > 0 ? 1 : 0;
}

// 只有直接运行时才执行，被 import 时不产生副作用。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

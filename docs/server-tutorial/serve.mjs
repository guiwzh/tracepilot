/**
 * 把你的答案跑成一个真实的 HTTP server，好用 curl / 浏览器手动戳。
 *
 *   node docs/server-tutorial/serve.mjs 03              # 跑 answers/03.mjs
 *   node docs/server-tutorial/serve.mjs 03 --port 3000  # 指定端口（默认 4000）
 *   node docs/server-tutorial/serve.mjs 03 --prompt     # 只看题面，不启动
 *   node docs/server-tutorial/serve.mjs --list          # 列出全部题目
 *
 * check.mjs 是「判分」，serve.mjs 是「手动调试」。
 * 写不出来的时候先用这个把响应打出来看看，比盯着代码猜快得多。
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './lib/store.mjs';
import { EXERCISES } from './check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const answersDir = resolve(here, 'answers');

function parseArgs(argv) {
  const flags = { port: 4000 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') {
      flags.port = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--list') {
      flags.list = true;
    } else if (argv[i] === '--prompt') {
      flags.prompt = true;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, id: positional[0] };
}

function printList() {
  console.log('\n可用练习：\n');
  for (const exercise of EXERCISES) {
    const done = existsSync(resolve(answersDir, `${exercise.id}.mjs`)) ? '✅' : '⬜';
    console.log(`  ${done} ${exercise.id}  ${exercise.title}`);
  }
  console.log('\n查看题面：node docs/server-tutorial/serve.mjs <编号> --prompt');
  console.log('开始判分：node docs/server-tutorial/check.mjs <编号>\n');
}

function printPrompt(exercise) {
  console.log(`\n【${exercise.id}】${exercise.title}\n`);
  console.log(exercise.prompt);
  console.log(`\n提示：${exercise.hint}\n`);
}

/** 把练习里的测试请求渲染成可以直接粘贴执行的 curl 命令。 */
function printCurls(exercise, port) {
  console.log('判分会发这些请求，你可以先手动试：\n');
  for (const request of exercise.requests) {
    const parts = [`curl -i -X ${request.method} 'http://127.0.0.1:${port}${request.path}'`];
    if (request.rawBody !== undefined) {
      parts.push(`-H 'Content-Type: application/json' --data-raw '${request.rawBody}'`);
    } else if (request.body !== undefined) {
      parts.push(`-H 'Content-Type: application/json' -d '${JSON.stringify(request.body)}'`);
    }
    console.log(`  ${parts.join(' \\\n    ')}`);
  }
  console.log();
}

async function main() {
  const { flags, id } = parseArgs(process.argv.slice(2));

  if (flags.list || !id) {
    printList();
    if (!id) process.exitCode = 1;
    return;
  }

  const exercise = EXERCISES.find((item) => item.id === id);
  if (!exercise) {
    console.error(`没有编号为 ${id} 的练习。可用编号：${EXERCISES.map((e) => e.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (flags.prompt) {
    printPrompt(exercise);
    return;
  }

  const file = resolve(answersDir, `${exercise.id}.mjs`);
  if (!existsSync(file)) {
    console.error(`还没有 answers/${exercise.id}.mjs。先看题面：`);
    printPrompt(exercise);
    process.exitCode = 1;
    return;
  }

  const module = await import(pathToFileURL(file).href);
  const handler = module.default;
  if (typeof handler !== 'function') {
    console.error(`answers/${exercise.id}.mjs 必须 export default 一个函数`);
    process.exitCode = 1;
    return;
  }

  // 整个进程共用一个 store，所以你连续发请求能看到数据累积——
  // 这正是真实 server 的样子：进程活着，状态就活着。
  const store = createStore();
  const server = createServer((req, res) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} → ${res.statusCode}  ${Date.now() - startedAt}ms`);
    });
    Promise.resolve()
      .then(() => handler(req, res, store))
      .catch((error) => {
        console.error('handler 抛异常：', error);
        if (res.headersSent) return;
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'HANDLER_THREW', message: error.message }));
      });
  });

  server.listen(flags.port, '127.0.0.1', () => {
    printPrompt(exercise);
    console.log(`answers/${exercise.id}.mjs 已启动： http://127.0.0.1:${flags.port}\n`);
    printCurls(exercise, flags.port);
    console.log('Ctrl+C 停止。\n' + '─'.repeat(72));
  });
}

main();

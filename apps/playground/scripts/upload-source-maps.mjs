import { readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

/**
 * 生产模式的第二步：把 vite build 产出的 Source Map 上传到服务端对应的 Release，再从 dist 里删掉。
 *
 * 构建用 `--sourcemap hidden`：产物里不写 sourceMappingURL，浏览器不会去取 map；
 * 上传后删除文件，预览服务器也就不会把它们（连同内联的源码）提供给任何人。
 * 服务端按「Release + 压缩文件名」查找 map，所以压缩后的报错能在工作台里还原到 src/ 下的源码位置。
 *
 * 需要服务端已经在运行（pnpm dev 或 pnpm --filter @trace-pilot/server dev）。
 */
const lab = JSON.parse(await readFile(new URL('../lab.json', import.meta.url), 'utf8'));
// 与 vite build 读取同一份 .env：上传到的项目，就是构建出的演练场上报的项目。
const env = loadEnv('production', fileURLToPath(new URL('..', import.meta.url)), 'VITE_');
const api = env.VITE_API_URL ?? 'http://localhost:4318';
const projectId = env.VITE_DEMO_PROJECT_ID ?? 'demo-project';

async function call(path, init) {
  const response = await fetch(`${api}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path} → ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

// 找到演练场上报用的那个 Release；还没有就创建。
const { items } = await call(`/api/v1/projects/${projectId}/releases`);
const release =
  items.find((item) => item.version === lab.release) ??
  (await call(`/api/v1/projects/${projectId}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: lab.release }),
  }));

const assets = new URL('../dist/assets/', import.meta.url);
let uploaded = 0;
for (const file of await readdir(assets)) {
  if (!file.endsWith('.js.map')) continue;
  const form = new FormData();
  // 普通字段要排在文件之前：服务端流式解析，读到文件时字段必须已经到达。
  form.append('minifiedFile', file.replace(/\.map$/, ''));
  form.append('file', new Blob([await readFile(new URL(file, assets))]), file);
  await call(`/api/v1/releases/${release.id}/source-maps`, { method: 'POST', body: form });
  await rm(new URL(file, assets));
  uploaded += 1;
  process.stdout.write(`uploaded ${file} → release ${lab.release}\n`);
}
if (uploaded === 0)
  throw new Error('No source maps found; build with `vite build --sourcemap hidden`.');

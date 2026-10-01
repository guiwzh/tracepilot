import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SourceMapConsumer } from 'source-map';
import { build } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEBUG_ID_REGISTRY } from '@trace-pilot/shared';
import { tracepilotSourceMaps, type TracePilotPluginOptions } from '../src/index';

const fixture = fileURLToPath(new URL('./fixture/', import.meta.url));

/** 假的 TracePilot 服务端：记下创建的版本和上传的 map。 */
interface Received {
  releases: Array<{ version: string; commitSha?: string }>;
  maps: Array<{
    releaseId: string;
    minifiedFile: string;
    filename: string;
    map: Record<string, unknown>;
  }>;
}

let server: Server;
let url: string;
let received: Received;
let failUploads: boolean;
let outDir: string;

beforeEach(async () => {
  received = { releases: [], maps: [] };
  failUploads = false;
  outDir = await mkdtemp(join(tmpdir(), 'tracepilot-plugin-'));
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const path = request.url ?? '';
    if (request.method === 'GET' && path === '/api/v1/projects/shop/releases') {
      return send(200, {
        items: received.releases.map((release) => ({
          id: `r-${release.version}`,
          version: release.version,
          commitSha: release.commitSha ?? null,
        })),
      });
    }
    if (request.method === 'POST' && path === '/api/v1/projects/shop/releases') {
      const release = JSON.parse(body.toString()) as { version: string; commitSha?: string };
      received.releases.push(release);
      const version = release.version;
      return send(201, { id: `r-${version}`, version });
    }
    const upload = path.match(/^\/api\/v1\/releases\/([^/]+)\/source-maps$/);
    if (request.method === 'POST' && upload) {
      if (failUploads) return send(500, { error: 'INTERNAL' });
      // 借 Response 解析 multipart，和服务端收到的是同一份请求体。
      const form = await new Response(body, {
        headers: { 'content-type': String(request.headers['content-type']) },
      }).formData();
      const file = form.get('file') as File;
      received.maps.push({
        releaseId: upload[1]!,
        minifiedFile: String(form.get('minifiedFile')),
        filename: file.name,
        map: JSON.parse(await file.text()) as Record<string, unknown>,
      });
      return send(201, {});
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(outDir, { recursive: true, force: true });
});

function buildFixture(options: Partial<TracePilotPluginOptions> = {}) {
  return build({
    configFile: false,
    logLevel: 'silent',
    root: fixture,
    plugins: [tracepilotSourceMaps({ url, projectId: 'shop', release: '1.2.0', ...options })],
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      // 库模式保留入口的导出，测试才能在 Node 里调用构建出的 explode()。
      lib: { entry: join(fixture, 'main.js'), formats: ['es'], fileName: 'main' },
    },
  });
}

/** 在一个独立的 Node 进程里加载构建产物：不经过 Vitest 的模块转换，堆栈里是产物真实的行列号。 */
function runBuilt(file: string): { stack: string; registry: Record<string, string> } {
  const script = `
    const built = await import(process.argv[1]);
    await built.loadLazy();
    try { built.explode('cart'); } catch (error) {
      console.log(JSON.stringify({ stack: error.stack, registry: globalThis.${DEBUG_ID_REGISTRY} }));
    }`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, pathToFileURL(file).href],
      {
        encoding: 'utf8',
      },
    ),
  ) as { stack: string; registry: Record<string, string> };
}

describe('tracepilotSourceMaps', () => {
  it('injects one debug ID per file, uploads its map and keeps maps out of the output', async () => {
    await buildFixture();
    const files = (await readdir(outDir)).sort();
    expect(files.some((file) => file.endsWith('.map'))).toBe(false);
    const scripts = files.filter((file) => file.endsWith('.js'));
    // 入口和懒加载的 chunk 各一个。
    expect(scripts).toHaveLength(2);

    // 版本创建时记下构建所在的提交：fixture 就在本仓库里，取到的是本仓库的 HEAD。
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture,
      encoding: 'utf8',
    }).trim();
    expect(received.releases).toEqual([{ version: '1.2.0', commitSha: head }]);
    expect(received.maps.map((item) => item.minifiedFile).sort()).toEqual(scripts);
    for (const item of received.maps) {
      const code = await readFile(join(outDir, item.minifiedFile), 'utf8');
      const debugId = String(item.map.debugId);
      expect(item.releaseId).toBe('r-1.2.0');
      expect(item.filename).toBe(`${item.minifiedFile}.map`);
      expect(code.split('\n')[0]).toContain(`"${debugId}"`);
      expect(code.trimEnd().endsWith(`//# debugId=${debugId}`)).toBe(true);
      expect(code).not.toContain('sourceMappingURL');
    }
  });

  it('lets a real stack from the built file resolve to the original line', async () => {
    await buildFixture();
    const main = join(outDir, 'main.js');
    const { stack, registry } = runBuilt(main);

    // 两个文件执行时都把自己登记了：键是登记时的堆栈，第一帧就是文件自己的地址。
    const registered = Object.entries(registry).map(([key, id]) => [
      key.match(/file:\/\/[^\s)]+?\.js/)?.[0],
      id,
    ]);
    const uploaded = received.maps.map((item) => [
      pathToFileURL(join(outDir, item.minifiedFile)).href,
      item.map.debugId,
    ]);
    expect(registered.sort()).toEqual(uploaded.sort());

    // 抛错位置：产物里的行列号，用上传的 map 换算回 fixture/main.js 第 3 行（throw 那一行）。
    const frame = stack.match(/main\.js:(\d+):(\d+)/);
    const mainMap = received.maps.find((item) => item.minifiedFile === 'main.js')!.map;
    const consumer = await new SourceMapConsumer(mainMap as never);
    const original = consumer.originalPositionFor({
      line: Number(frame![1]),
      column: Number(frame![2]) - 1,
    });
    consumer.destroy();
    expect(original.source).toMatch(/main\.js$/);
    expect(original.line).toBe(3);
  });

  it('records an explicit commit, or none when told not to', async () => {
    await buildFixture({ commitSha: 'a'.repeat(40) });
    expect(received.releases).toEqual([{ version: '1.2.0', commitSha: 'a'.repeat(40) }]);
    received.releases = [];
    await buildFixture({ release: '1.3.0', commitSha: false });
    expect(received.releases).toEqual([{ version: '1.3.0' }]);
  });

  it('only injects in a dry run', async () => {
    await buildFixture({ dryRun: true });
    expect(received).toEqual({ releases: [], maps: [] });
    const files = await readdir(outDir);
    expect(files.some((file) => file.endsWith('.map'))).toBe(false);
    expect(await readFile(join(outDir, 'main.js'), 'utf8')).toContain('//# debugId=');
  });

  it('fails the build when the upload fails, unless told not to', async () => {
    failUploads = true;
    await expect(buildFixture()).rejects.toThrow(/source map upload failed: .* 500/);
    await expect(buildFixture({ failOnError: false })).resolves.toBeDefined();
  });
});

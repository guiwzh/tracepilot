import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceMapGenerator } from 'source-map';
import type { MonitorEvent } from '@trace-pilot/shared';
import { buildApp } from './app';
import type { ServerConfig } from './config';
import { percentile } from './lib/json';

/**
 * 接入性能基准：pnpm benchmark
 *
 * 分 1000 批、每批 10 条上报 1 万个错误事件，统计每批接入耗时的 P50 / P95，
 * 再测 Issue 列表查询的耗时；最后用一份大型 Source Map 测带堆栈的接入和上传回填。
 * 结果只反映本机 + SQLite 的量级，不代表生产容量。
 */

// 基准全部运行在临时目录，结束后删除，避免污染开发数据库。
const directory = await mkdtemp(join(tmpdir(), 'tracepilot-benchmark-'));
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  databasePath: join(directory, 'benchmark.db'),
  sourceMapDir: join(directory, 'maps'),
  modelName: 'local-evidence-engine',
  localAgentStepDelayMs: 0,
  agentSourceContext: true,
  // 基准要在一两秒里灌进上万个事件，测的是接入本身：关掉限流和突增保护。
  ingestRateLimitPerMinute: 0,
  spikeProtection: false,
  repositoryRoot: null,
  dashboardUrl: 'http://localhost:4173',
};
// 不配置模型密钥、关闭日志：只测接入和查询本身。
const app = await buildApp({ config, logger: false });

/**
 * 所有事件的 message 只有一个会被归一化掉的订单号，因此 1 万条事件全部聚合到同一个
 * Issue。这既是最贴近“错误风暴”的真实形态，也是接入路径的最坏情况：任何与
 * “Issue 内已有事件数”相关的每条开销，都会在这里被放大出来。
 */
function makeBatch(batch: number): MonitorEvent[] {
  return Array.from({ length: 10 }, (_, index) => {
    const sequence = batch * 10 + index;
    return {
      eventId: `benchmark-${sequence}`,
      eventType: 'error',
      timestamp: Date.now(),
      projectId: 'demo-project',
      release: 'benchmark-1.0.0',
      environment: 'production',
      page: { url: 'https://benchmark.test/checkout', route: '/checkout' },
      user: { id: `user-${sequence % 200}` },
      device: { userAgent: 'Benchmark Chrome' },
      payload: {
        name: 'TypeError',
        message: `Cannot read order ${8_000_000 + sequence}`,
        stack: 'TypeError: failure\n    at submit (https://benchmark.test/app.aa11bb22.js:1:20)',
      },
      breadcrumbs: [],
    };
  });
}

const TOTAL_BATCHES = 1_000;

/** 合成 map 的规模：2,000 行 × 150 列 = 30 万条映射，与真实的大型前端应用同一量级。 */
const MAP_LINES = 2_000;
const MAP_COLUMNS = 150;

/** 生成一份合成的大型 map：压缩文件的每一行有 MAP_COLUMNS 个映射点，分散到 50 个源文件。 */
function largeSourceMap(): string {
  const generator = new SourceMapGenerator({ file: 'vendor.bench.js' });
  for (let line = 1; line <= MAP_LINES; line += 1) {
    for (let index = 0; index < MAP_COLUMNS; index += 1) {
      generator.addMapping({
        generated: { line, column: index * 40 },
        original: { line: ((line * 7 + index) % 900) + 1, column: (index * 3) % 80 },
        source: `src/module-${(line + index) % 50}.ts`,
        name: `fn${(line * index) % 500}`,
      });
    }
  }
  return generator.toString();
}

/** 堆栈里的三帧落在 map 覆盖的不同位置。 */
function mappedStack(sequence: number): string {
  const frame = (offset: number) => {
    const line = ((sequence * 13 + offset * 101) % MAP_LINES) + 1;
    const column = (((sequence + offset) * 37) % MAP_COLUMNS) * 40 + 1;
    return `    at f${offset} (https://benchmark.test/assets/vendor.bench.js:${line}:${column})`;
  };
  return ['TypeError: failure', frame(0), frame(1), frame(2)].join('\n');
}

function multipartMap(content: string): { payload: string; headers: Record<string, string> } {
  const boundary = '----tracepilot-benchmark';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload:
      `--${boundary}\r\nContent-Disposition: form-data; name="minifiedFile"\r\n\r\nvendor.bench.js\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="vendor.bench.js.map"\r\n` +
      `Content-Type: application/json\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  };
}

/**
 * Source Map 还原的开销。解析一份 map 是整条链路里最贵的一步；它在进程里只做一次，
 * 之后每个事件只是几次查表，所以接入延迟不应随 map 大小明显增长。
 * 重新上传会替换缓存并回填这个版本里引用了该文件的全部事件。
 */
async function measureSourceMaps(events: number) {
  const map = largeSourceMap();
  const release = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/demo-project/releases',
    payload: { version: 'benchmark-maps-1.0.0' },
  });
  const releaseId = String(release.json().id);
  const upload = async () => {
    const startedAt = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/releases/${releaseId}/source-maps`,
      ...multipartMap(map),
    });
    if (response.statusCode !== 201) throw new Error(`Map upload failed: ${response.body}`);
    return performance.now() - startedAt;
  };

  const firstUploadMs = await upload();
  const ingestLatency: number[] = [];
  for (let batch = 0; batch < events / 10; batch += 1) {
    const batchEvents = makeBatch(batch).map((event, index) => ({
      ...event,
      eventId: `mapped-${batch * 10 + index}`,
      release: 'benchmark-maps-1.0.0',
      payload: { ...event.payload, stack: mappedStack(batch * 10 + index) },
    }));
    const startedAt = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: { dsnKey: 'demo-dsn-key', sentAt: Date.now(), events: batchEvents },
    });
    if (response.statusCode !== 202) throw new Error(`Mapped ingest failed: ${response.body}`);
    ingestLatency.push(performance.now() - startedAt);
  }
  const reuploadMs = await upload();
  return {
    mapBytes: Buffer.byteLength(map),
    mappings: MAP_LINES * MAP_COLUMNS,
    uploadMs: Number(firstUploadMs.toFixed(0)),
    ingestBatchWithStacksMs: {
      p50: Number(percentile(ingestLatency, 0.5).toFixed(2)),
      p95: Number(percentile(ingestLatency, 0.95).toFixed(2)),
    },
    reuploadWithBackfill: { events, ms: Number(reuploadMs.toFixed(0)) },
  };
}

try {
  const ingestLatency: number[] = [];
  for (let batch = 0; batch < TOTAL_BATCHES; batch += 1) {
    const events = makeBatch(batch);
    const startedAt = performance.now();
    // app.inject 直接经过完整 Fastify 路由栈，但不占用真实网络端口，减少网络噪声。
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: { dsnKey: 'demo-dsn-key', sentAt: Date.now(), events },
    });
    if (response.statusCode !== 202) throw new Error(`Benchmark ingest failed: ${response.body}`);
    ingestLatency.push(performance.now() - startedAt);
  }

  const queryLatency: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const startedAt = performance.now();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/issues?page=1&pageSize=25',
    });
    if (response.statusCode !== 200) throw new Error('Benchmark query failed.');
    queryLatency.push(performance.now() - startedAt);
  }
  /**
   * 按接入进度分段统计，用来暴露“写入放大”——即单条写入的开销是否随 Issue 内
   * 已有事件数增长。三段的 P50 应当基本持平；若尾段明显高于首段，说明接入路径上
   * 又出现了与已有事件数成正比的操作（历史上是每条事件都 COUNT(*) 重新派生计数）。
   */
  const segment = (from: number, to: number) => ({
    afterEvents: to * 10,
    p50: Number(percentile(ingestLatency.slice(from, to), 0.5).toFixed(2)),
    p95: Number(percentile(ingestLatency.slice(from, to), 0.95).toFixed(2)),
  });

  const report = {
    runtime: process.version,
    database: 'SQLite WAL, temporary local file',
    eventsIngested: TOTAL_BATCHES * 10,
    batchSize: 10,
    aggregatedIssues: JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/projects/demo-project/issues?page=1&pageSize=25',
        })
      ).body,
    ).total,
    ingestBatchMs: {
      p50: Number(percentile(ingestLatency, 0.5).toFixed(2)),
      p95: Number(percentile(ingestLatency, 0.95).toFixed(2)),
    },
    ingestWriteAmplification: [
      segment(0, 100),
      segment(400, 500),
      segment(TOTAL_BATCHES - 100, TOTAL_BATCHES),
    ],
    issueQueryMs: {
      p50: Number(percentile(queryLatency, 0.5).toFixed(2)),
      p95: Number(percentile(queryLatency, 0.95).toFixed(2)),
    },
    sourceMap: await measureSourceMaps(2_000),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}

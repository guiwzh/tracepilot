import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MonitorEvent } from '@trace-pilot/shared';
import { buildApp } from './app';
import type { ServerConfig } from './config';
import { percentile } from './lib/json';

const directory = await mkdtemp(join(tmpdir(), 'tracepilot-benchmark-'));
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  databasePath: join(directory, 'benchmark.db'),
  sourceMapDir: join(directory, 'maps'),
  modelName: 'local-evidence-engine',
};
const app = await buildApp({ config, logger: false });

try {
  const ingestLatency: number[] = [];
  for (let batch = 0; batch < 100; batch += 1) {
    const events: MonitorEvent[] = Array.from({ length: 10 }, (_, index) => {
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
    const startedAt = performance.now();
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
  const report = {
    runtime: process.version,
    database: 'SQLite WAL, temporary local file',
    eventsIngested: 1_000,
    batchSize: 10,
    ingestBatchMs: {
      p50: Number(percentile(ingestLatency, 0.5).toFixed(2)),
      p95: Number(percentile(ingestLatency, 0.95).toFixed(2)),
    },
    issueQueryMs: {
      p50: Number(percentile(queryLatency, 0.5).toFixed(2)),
      p95: Number(percentile(queryLatency, 0.95).toFixed(2)),
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}

import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const artifact = resolve('packages/monitor-sdk/dist/index.js');
const content = await readFile(artifact);
process.stdout.write(
  `${JSON.stringify(
    {
      artifact: 'packages/monitor-sdk/dist/index.js',
      minifiedBytes: content.byteLength,
      gzipBytes: gzipSync(content, { level: 9 }).byteLength,
      measuredAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

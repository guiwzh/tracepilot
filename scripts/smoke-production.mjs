import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function runNode(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  assert.equal(exitCode, 0, output);
}

async function getAvailablePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address();
  assert(address && typeof address === 'object');
  await new Promise((resolveClose, reject) => {
    probe.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function waitForHealth(url, processExit) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const exited = await Promise.race([
      processExit.then((result) => ({ exited: true, result })),
      new Promise((resolveWait) => setTimeout(() => resolveWait({ exited: false }), 100)),
    ]);
    if (exited.exited) {
      throw new Error(`Production server exited before becoming healthy: ${exited.result.code}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.service, 'tracepilot-server');
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }
  }
  throw new Error('Production server did not become healthy within 5 seconds.');
}

async function stopProcess(child, processExit) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    processExit.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2_000)),
  ]);
  if (!stopped) {
    child.kill('SIGKILL');
    await processExit;
  }
}

await runNode(
  [
    '--input-type=module',
    '--eval',
    "const sdk = await import('@trace-pilot/monitor-sdk'); if (typeof sdk.createMonitor !== 'function') throw new Error('Missing ESM createMonitor export');",
  ],
  resolve(repoRoot, 'apps/playground'),
);
await runNode(
  [
    '--eval',
    "const sdk = require('@trace-pilot/monitor-sdk'); if (typeof sdk.createMonitor !== 'function') throw new Error('Missing CJS createMonitor export');",
  ],
  resolve(repoRoot, 'apps/playground'),
);
await runNode(
  [
    '--input-type=module',
    '--eval',
    "const shared = await import('@trace-pilot/shared'); if (!shared.envelopeSchema) throw new Error('Missing shared package export');",
  ],
  resolve(repoRoot, 'apps/server'),
);

const temporaryRoot = await mkdtemp(join(tmpdir(), 'tracepilot-production-smoke-'));
const port = await getAvailablePort();
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_PATH: join(temporaryRoot, 'tracepilot.db'),
    SOURCEMAP_DIR: join(temporaryRoot, 'source-maps'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
const processExit = new Promise((resolveExit) => {
  server.once('exit', (code, signal) => resolveExit({ code, signal }));
});

try {
  await waitForHealth(`http://127.0.0.1:${port}/health`, processExit);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverOutput}`);
} finally {
  await stopProcess(server, processExit);
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Production package imports and server health check passed.\n');

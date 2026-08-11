import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ServerConfig {
  host: string;
  port: number;
  databasePath: string;
  sourceMapDir: string;
  modelApiUrl?: string;
  modelApiKey?: string;
  modelName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 4318),
    databasePath: resolve(env.DATABASE_PATH ?? resolve(serverRoot, '.tracepilot/tracepilot.db')),
    sourceMapDir: resolve(env.SOURCEMAP_DIR ?? resolve(serverRoot, '.tracepilot/source-maps')),
    modelApiUrl: env.MODEL_API_URL,
    modelApiKey: env.MODEL_API_KEY,
    modelName: env.MODEL_NAME ?? 'gpt-5-mini',
  };
}

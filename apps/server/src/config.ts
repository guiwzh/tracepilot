import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 把 process.env 转成显式配置对象，测试可传入自己的 env 而不污染全局环境。 */
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
    // 没有 Key 时不创建外部客户端，诊断服务会明确降级到本地证据引擎。
    modelApiUrl: env.MODEL_API_URL ?? (env.MODEL_API_KEY ? 'https://api.openai.com/v1' : undefined),
    modelApiKey: env.MODEL_API_KEY,
    modelName: env.MODEL_NAME ?? 'gpt-5.6-terra',
  };
}

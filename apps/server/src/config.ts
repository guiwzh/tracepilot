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
  /** 离线演示脚本每一步的停顿，让调查过程在界面上看得见；测试里设为 0。 */
  localAgentStepDelayMs: number;
  /** 是否允许排障 Agent 把出错行附近的源码片段发给模型服务商。 */
  agentSourceContext: boolean;
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
    localAgentStepDelayMs: Math.max(0, Number(env.LOCAL_AGENT_STEP_DELAY_MS ?? 450) || 0),
    // 源码会离开本机发往模型服务商；有合规要求的团队可以设为 false 关闭。
    agentSourceContext: env.AGENT_SOURCE_CONTEXT !== 'false',
  };
}

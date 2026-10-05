import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * apps/server 目录的绝对路径。开发时本文件在 src/，构建后被打包进 dist/index.js，
 * 两种情况下「上一级目录」都是 apps/server，默认的数据目录因此不随运行方式变化。
 */
export const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 服务端的全部配置。环境变量只在 loadConfig 里读一次（只给评测用的 EVAL_JUDGE_* 由 eval/scoring.ts 读），
 * 其余代码只接收这个对象：测试可以直接构造一份配置（临时数据库、不同的上限），不必改动全局的 process.env。
 */
export interface ServerConfig {
  host: string;
  port: number;
  /** SQLite 数据库文件的位置。 */
  databasePath: string;
  /** 上传的 Source Map 存放目录；只有服务端能读，不对外提供下载。 */
  sourceMapDir: string;
  /** OpenAI 兼容接口的地址，例如 https://api.deepseek.com/v1。 */
  modelApiUrl?: string;
  /** 模型服务的密钥。只在服务端读取，永远不会发给浏览器。 */
  modelApiKey?: string;
  modelName: string;
  /** 离线演示脚本每一步的停顿，让调查过程在界面上看得见；测试里设为 0。 */
  localAgentStepDelayMs: number;
  /** 是否允许排障 Agent 把出错行附近的源码片段发给模型服务商。 */
  agentSourceContext: boolean;
  /** 每个项目每分钟最多接收的事件数（没有在项目设置里单独调的项目用它）；0 表示不限。 */
  ingestRateLimitPerMinute: number;
  /** 是否启用突增保护（services/ingestGuard.ts）；关闭时项目设置里的开关不起作用。 */
  spikeProtection: boolean;
  /**
   * 被监控应用的 git 仓库放在哪个目录下：<repositoryRoot>/<项目 id>。代码类工具（读源码、搜代码、
   * 找嫌疑提交）只读这里的仓库；null 表示不提供代码上下文。
   */
  repositoryRoot: string | null;
  /** 工作台的地址，告警消息里的链接指向它。 */
  dashboardUrl: string;
  /** 每个项目 24 小时内告警最多自动发起几次调查；0 表示关闭（services/autoInvestigation.ts）。 */
  autoInvestigationsPerDay: number;
}

/** 非负整数；没有设置或不是数字时用默认值（写错的值不应悄悄变成 0，也就是「不限」）。 */
function nonNegative(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : fallback;
}

/**
 * 从环境变量读取配置。环境变量来自两处：启动命令里直接设置的，以及 index.ts 通过 dotenv
 * 从 apps/server/.env 读入的（已存在的变量不会被 .env 覆盖）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 4318),
    // 相对路径以启动时的工作目录为基准；默认值用 serverRoot 拼出绝对路径，避免位置随启动方式漂移。
    databasePath: resolve(env.DATABASE_PATH ?? resolve(serverRoot, '.tracepilot/tracepilot.db')),
    sourceMapDir: resolve(env.SOURCEMAP_DIR ?? resolve(serverRoot, '.tracepilot/source-maps')),
    // 没有密钥时不创建模型客户端：排障 Agent 改由离线脚本驱动，单次诊断接口改用本地规则引擎，
    // 界面都会明确标注。监控本身的接入与查询不受影响。
    modelApiUrl: env.MODEL_API_URL ?? (env.MODEL_API_KEY ? 'https://api.openai.com/v1' : undefined),
    modelApiKey: env.MODEL_API_KEY,
    modelName: env.MODEL_NAME ?? 'gpt-5.6-terra',
    localAgentStepDelayMs: Math.max(0, Number(env.LOCAL_AGENT_STEP_DELAY_MS ?? 450) || 0),
    // 源码会离开本机发往模型服务商；有合规要求的团队可以设为 false 关闭。
    agentSourceContext: env.AGENT_SOURCE_CONTEXT !== 'false',
    // 默认每分钟 6,000 个（每秒 100 个）：单机 SQLite 每秒能接入上万个事件，留出余量给别的项目和查询。
    ingestRateLimitPerMinute: nonNegative(env.INGEST_RATE_LIMIT_PER_MINUTE, 6_000),
    spikeProtection: env.SPIKE_PROTECTION !== 'false',
    // 设为空字符串可以关掉代码类工具。项目在这里没有仓库（包括默认目录不存在）时，排障 Agent 拿不到
    // 这三个工具，MCP 调用它们则如实回答「没有配置仓库」。
    repositoryRoot:
      env.REPOSITORY_ROOT === ''
        ? null
        : resolve(env.REPOSITORY_ROOT ?? resolve(serverRoot, '.tracepilot/repos')),
    dashboardUrl: env.DASHBOARD_URL || 'http://localhost:4173',
    // 每次调查都要多次调用计费的模型：默认每个项目每天 10 次，够覆盖一次发版带来的几个新问题。
    autoInvestigationsPerDay: nonNegative(env.AUTO_INVESTIGATIONS_PER_DAY, 10),
  };
}

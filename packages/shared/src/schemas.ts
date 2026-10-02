import { z } from 'zod';
import { DEBUG_ID_PATTERN } from './constants';

/**
 * Zod Schema 是运行时契约：浏览器传来的 JSON 即使通过了 TypeScript 编译，
 * 到达 Server 时仍是不可信的 unknown，必须在这里重新校验长度、枚举和嵌套结构。
 */
export const environmentSchema = z.enum(['development', 'test', 'production']);
export const eventTypeSchema = z.enum(['error', 'resource', 'network', 'performance']);
export const issueStatusSchema = z.enum(['unresolved', 'resolved', 'ignored']);
export const issueLevelSchema = z.enum(['error', 'warning', 'info']);

export const breadcrumbSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['navigation', 'click', 'network', 'console', 'error', 'custom']),
  category: z.string().max(80),
  message: z.string().max(1000),
  timestamp: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const monitorEventSchema = z.object({
  eventId: z.string().min(1).max(100),
  eventType: eventTypeSchema,
  timestamp: z.number().positive(),
  /**
   * 这个事件实际生效的采样率（0～1]，性能样本是会话采样率与性能采样率的乘积。
   * 旧版本 SDK 不带这个字段，按 1 处理。
   */
  sampleRate: z.number().gt(0).max(1).optional(),
  projectId: z.string().min(1).max(100),
  release: z.string().min(1).max(120),
  environment: environmentSchema,
  page: z.object({
    url: z.string().max(2048),
    route: z.string().max(1000).optional(),
    title: z.string().max(300).optional(),
    referrer: z.string().max(2048).optional(),
  }),
  user: z
    .object({ id: z.string().max(200).optional(), anonymousId: z.string().max(200).optional() })
    .optional(),
  device: z.object({
    userAgent: z.string().max(1000),
    language: z.string().max(40).optional(),
    viewport: z
      .object({ width: z.number().nonnegative(), height: z.number().nonnegative() })
      .optional(),
  }),
  payload: z.record(z.string(), z.unknown()),
  breadcrumbs: z.array(breadcrumbSchema).max(100),
  /**
   * 自定义聚合键：给了它，服务端就按它决定归入哪个 Issue，而不是按默认指纹。
   * 其中的 "{{ default }}" 代表默认指纹，用来在默认结果上再细分，例如 ['{{ default }}', tenantId]。
   */
  fingerprint: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
  /**
   * 堆栈里出现的产物文件各自的 Debug ID（构建插件注入），服务端按它找 Source Map，
   * 不依赖版本号和文件名是否对得上。没有用构建插件的应用不带这个字段。
   */
  debugIds: z
    .array(
      z.object({ file: z.string().min(1).max(2048), debugId: z.string().regex(DEBUG_ID_PATTERN) }),
    )
    .max(50)
    .optional(),
});

export const envelopeSchema = z.object({
  dsnKey: z.string().min(1).max(200),
  sentAt: z.number().positive(),
  events: z.array(monitorEventSchema).min(1).max(100),
});

export const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const createReleaseSchema = z.object({
  version: z.string().trim().min(1).max(120),
  commitSha: z.string().trim().max(80).optional(),
});

/**
 * Issue 状态的细分（参照 Sentry 的 substatus）：
 * - 未解决时：regressed（解决之后又出现）、escalating（事件量远超它自己的常态）；
 * - 忽略时：until_escalating（忽略到它恶化为止，恶化时自动重新打开并告警）。
 * 人改状态时清除，表示「看过了」。
 */
export const issueSubstatusSchema = z.enum(['regressed', 'escalating', 'until_escalating']);

export const updateIssueStatusSchema = z.object({
  status: issueStatusSchema,
  /** 只对 ignored 有意义：忽略到它恶化为止。 */
  untilEscalating: z.boolean().optional(),
});

/** 告警的触发条件：新 Issue、回归、恶化。 */
export const alertTriggerSchema = z.enum(['new_issue', 'regression', 'escalating']);

const url = z.string().trim().max(2_000);
const signingSecret = z.string().trim().min(1).max(200).optional();

/**
 * 通知渠道。Slack、飞书、钉钉的机器人地址只接受各自官方的域名：地址本身就是凭据，
 * 限定域名也避免把服务端变成任意地址的请求代理（SSRF）。通用 Webhook 接受任意 http(s) 地址，
 * 配了 secret 时请求带 HMAC 签名，接收方据此确认来源。
 */
export const alertChannelSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webhook'),
    url: url.regex(/^https?:\/\/[^\s/]+/i, 'Use an http(s) URL.'),
    secret: signingSecret,
  }),
  z.object({
    type: z.literal('slack'),
    url: url.regex(/^https:\/\/hooks\.slack\.com\/services\//, 'Use a Slack incoming webhook URL.'),
  }),
  z.object({
    type: z.literal('feishu'),
    url: url.regex(
      /^https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\//,
      'Use a Feishu / Lark custom bot webhook URL.',
    ),
    secret: signingSecret,
  }),
  z.object({
    type: z.literal('dingtalk'),
    url: url.regex(
      /^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=/,
      'Use a DingTalk custom robot webhook URL.',
    ),
    secret: signingSecret,
  }),
]);

const alertRuleFields = {
  name: z.string().trim().min(1).max(80),
  triggers: z.array(alertTriggerSchema).min(1).max(3),
  /** 只对这个级别及以上的 Issue 告警（error > warning > info）。 */
  minLevel: issueLevelSchema,
  /** 同一个 Issue 在这段时间内最多通知一次（去重），单位分钟。 */
  intervalMinutes: z.number().int().min(1).max(10_080),
};

export const createAlertRuleSchema = z.object({
  ...alertRuleFields,
  minLevel: issueLevelSchema.default('error'),
  intervalMinutes: alertRuleFields.intervalMinutes.default(60),
  channel: alertChannelSchema,
});

/** 修改规则。渠道不能改（地址和密钥是凭据，接口不回显），要换渠道就删掉重建。 */
export const updateAlertRuleSchema = z
  .object({
    name: alertRuleFields.name,
    enabled: z.boolean(),
    triggers: alertRuleFields.triggers,
    minLevel: alertRuleFields.minLevel,
    intervalMinutes: alertRuleFields.intervalMinutes,
    /** 静默到这个时间（毫秒时间戳）；null 取消静默。 */
    mutedUntil: z.number().int().positive().nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.');

/**
 * 项目设置：服务端在接入时按它过滤和限流（PUT 时整份替换）。
 * 消息和版本的规则是通配符：* 匹配任意字符，例如 "ResizeObserver loop*"、"1.*"。
 */
export const projectSettingsSchema = z.object({
  inboundFilters: z.object({
    /** 栈顶帧来自浏览器扩展的错误。 */
    browserExtensions: z.boolean(),
    /** 搜索引擎爬虫、监控探针等非真实用户的上报。 */
    webCrawlers: z.boolean(),
    /** 页面地址是 localhost、127.0.0.1 的上报（本地开发时产生的）。 */
    localhost: z.boolean(),
    /** 按「类型: 消息」或消息本身匹配，不区分大小写。 */
    errorMessages: z.array(z.string().trim().min(1).max(200)).max(50),
    /** 按版本号匹配，例如不再维护的旧版本。 */
    releases: z.array(z.string().trim().min(1).max(120)).max(50),
  }),
  rateLimit: z.object({
    /** 这个项目每分钟最多接收的事件数；null 表示用服务端的默认值。 */
    eventsPerMinute: z.number().int().min(100).max(1_000_000).nullable(),
    /** 突增保护：一分钟内的事件数远超过去一小时的常态时，拒收超出的部分。 */
    spikeProtection: z.boolean(),
  }),
});

/** 新建一个 API 令牌（给 MCP 客户端用），名字只用来在列表里认出它。 */
export const createApiTokenSchema = z.object({ name: z.string().trim().min(1).max(80) });

/** 把这些 Issue 合并进路径里的目标 Issue。 */
export const mergeIssuesSchema = z.object({
  issueIds: z.array(z.string().min(1).max(100)).min(1).max(50),
});

export const diagnosisEvidenceSchema = z.object({
  description: z.string().min(1),
  source: z.enum(['stack', 'breadcrumb', 'network', 'performance', 'release']),
});

export const diagnosisResultSchema = z.object({
  summary: z.string().min(1),
  evidence: z.array(diagnosisEvidenceSchema),
  possibleCauses: z.array(
    z.object({
      cause: z.string().min(1),
      confidence: z.number().min(0).max(1),
      supportingEvidence: z.array(z.string()),
    }),
  ),
  investigationSteps: z.array(z.string()),
  suggestions: z.array(z.string()),
  missingInformation: z.array(z.string()),
  disclaimer: z.string().min(1),
});

// z.infer 从运行时 Schema 推导 TypeScript 类型，避免“校验规则”和“静态类型”维护两份。
export type Breadcrumb = z.infer<typeof breadcrumbSchema>;
export type MonitorEvent = z.infer<typeof monitorEventSchema>;
export type EventEnvelope = z.infer<typeof envelopeSchema>;
export type IssueStatus = z.infer<typeof issueStatusSchema>;
export type IssueSubstatus = z.infer<typeof issueSubstatusSchema>;
export type AlertTrigger = z.infer<typeof alertTriggerSchema>;
export type AlertChannel = z.infer<typeof alertChannelSchema>;
export type CreateAlertRule = z.input<typeof createAlertRuleSchema>;
export type UpdateAlertRule = z.infer<typeof updateAlertRuleSchema>;
export type IssueLevel = z.infer<typeof issueLevelSchema>;
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

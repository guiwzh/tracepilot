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

export const updateIssueStatusSchema = z.object({ status: issueStatusSchema });

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
export type IssueLevel = z.infer<typeof issueLevelSchema>;
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;

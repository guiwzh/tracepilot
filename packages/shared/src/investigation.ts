import { z } from 'zod';

/**
 * 排障 Agent 的公开契约：模型提交的报告、服务端校验后的报告，以及推给 Dashboard 的事件流。
 *
 * 与单次诊断相比，报告里的每条证据都必须指向一次真实的工具调用（toolCallId），
 * 并附一段从那次调用结果里逐字摘出的原文（quote）。服务端会逐条核对：
 * 引用不存在的调用、或原文在结果里找不到，都视为模型编造证据。
 */
export const investigationSourceSchema = z.enum([
  'issue',
  'stack',
  'source',
  'breadcrumb',
  'network',
  'release',
]);

export const submittedEvidenceSchema = z.object({
  toolCallId: z.string().min(1).max(120),
  quote: z.string().min(4).max(300),
  description: z.string().min(1).max(500),
  source: investigationSourceSchema,
});

/** 模型通过 submit_report 工具提交的内容；免责声明和校验结果由服务端补上，不交给模型写。 */
export const submittedReportSchema = z.object({
  summary: z.string().min(1).max(600),
  evidence: z.array(submittedEvidenceSchema).min(1).max(8),
  possibleCauses: z
    .array(
      z.object({
        cause: z.string().min(1).max(400),
        confidence: z.number().min(0).max(1),
        // 引用 evidence 数组的下标，而不是复述证据文字，UI 才能把原因和证据、工具调用连起来。
        evidenceRefs: z.array(z.number().int().min(0)).min(1).max(8),
      }),
    )
    .min(1)
    .max(4),
  investigationSteps: z.array(z.string().min(1).max(300)).max(6),
  suggestions: z.array(z.string().min(1).max(300)).max(6),
  missingInformation: z.array(z.string().min(1).max(300)).max(6),
});

export type SubmittedReport = z.infer<typeof submittedReportSchema>;
export type InvestigationSource = z.infer<typeof investigationSourceSchema>;

export interface InvestigationReport extends Omit<SubmittedReport, 'evidence'> {
  evidence: Array<SubmittedReport['evidence'][number] & { verified: boolean }>;
  verification: {
    /** 模型一共提交了几次报告；被驳回后修正重交也计入。 */
    attempts: number;
    allVerified: boolean;
    /** 最后一次提交仍未通过的校验项；为空表示全部通过。 */
    problems: string[];
  };
  disclaimer: string;
}

export type InvestigationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface InvestigationUsage {
  inputTokens: number;
  outputTokens: number;
  steps: number;
  toolCalls: number;
}

export interface InvestigationRun {
  id: string;
  issueId: string;
  status: InvestigationStatus;
  /** model：真实模型；local：没有配置密钥时的确定性离线演示脚本，不是模型推理。 */
  engine: 'model' | 'local';
  model: string;
  startedAt: number;
  finishedAt: number | null;
  usage: InvestigationUsage;
  report: InvestigationReport | null;
  error: string | null;
}

export type InvestigationEvent =
  | { type: 'run.started'; engine: InvestigationRun['engine']; model: string }
  | { type: 'step.started'; step: number }
  | { type: 'text.delta'; step: number; text: string }
  | {
      type: 'tool.called';
      step: number;
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool.completed';
      step: number;
      toolCallId: string;
      ok: boolean;
      output: string;
      truncated: boolean;
      durationMs: number;
    }
  | { type: 'report.rejected'; step: number; problems: string[] }
  | { type: 'run.completed'; report: InvestigationReport; usage: InvestigationUsage }
  | { type: 'run.failed'; error: string; message: string; usage: InvestigationUsage }
  | { type: 'run.cancelled'; usage: InvestigationUsage };

/** 事件流里的一条记录。seq 在单次运行内单调递增，同时用作 SSE 的 id，断线重连靠它续传。 */
export interface InvestigationStreamEvent {
  seq: number;
  at: number;
  event: InvestigationEvent;
}

export const TERMINAL_INVESTIGATION_EVENTS = [
  'run.completed',
  'run.failed',
  'run.cancelled',
] as const;

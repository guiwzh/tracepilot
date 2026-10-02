import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAlertRuleSchema, updateAlertRuleSchema } from '@trace-pilot/shared';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import {
  AlertRuleError,
  ALERT_LIMITS,
  createAlertRule,
  deleteAlertRule,
  listAlertDeliveries,
  listAlertRules,
  sendTestAlert,
  updateAlertRule,
} from '../services/alerts';

/**
 * 告警规则与通知记录。和其他管理接口一样当前没有鉴权（本地单用户 MVP）。
 * 规则里的渠道地址和密钥是凭据：只能写入，读取时打码，所以「改渠道」要删掉重建。
 */
function param(params: unknown, key: 'projectId' | 'ruleId'): string {
  return String((params as Record<string, string | undefined>)[key] ?? '');
}

/** 校验错误的第一条说明，例如「Use a Slack incoming webhook URL.」，直接显示在表单上。 */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'rule'}: ${issue.message}` : 'Invalid alert rule.';
}

export function registerAlertRoutes(
  app: FastifyInstance,
  database: TraceDatabase,
  config: Pick<ServerConfig, 'dashboardUrl'>,
): void {
  const projectExists = (projectId: string) =>
    Boolean(database.sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId));
  const notFound = { error: 'PROJECT_NOT_FOUND', message: 'Project not found.' };
  const ruleNotFound = { error: 'ALERT_RULE_NOT_FOUND', message: 'Alert rule not found.' };

  app.get('/api/v1/projects/:projectId/alert-rules', async (request, reply) => {
    const projectId = param(request.params, 'projectId');
    if (!projectExists(projectId)) return reply.code(404).send(notFound);
    return { items: listAlertRules(database, projectId) };
  });

  app.post('/api/v1/projects/:projectId/alert-rules', async (request, reply) => {
    const projectId = param(request.params, 'projectId');
    const parsed = createAlertRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_ALERT_RULE',
        message: firstIssue(parsed.error),
        details: z.flattenError(parsed.error),
      });
    }
    if (!projectExists(projectId)) return reply.code(404).send(notFound);
    try {
      return reply.code(201).send(createAlertRule(database, projectId, parsed.data));
    } catch (error) {
      if (!(error instanceof AlertRuleError)) throw error;
      return reply.code(409).send({
        error: error.code,
        message: `A project can have at most ${ALERT_LIMITS.rulesPerProject} alert rules.`,
      });
    }
  });

  app.patch('/api/v1/alert-rules/:ruleId', async (request, reply) => {
    const parsed = updateAlertRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_ALERT_RULE', message: firstIssue(parsed.error) });
    }
    const rule = updateAlertRule(database, param(request.params, 'ruleId'), parsed.data);
    return rule ?? reply.code(404).send(ruleNotFound);
  });

  app.delete('/api/v1/alert-rules/:ruleId', async (request, reply) => {
    if (!deleteAlertRule(database, param(request.params, 'ruleId'))) {
      return reply.code(404).send(ruleNotFound);
    }
    return reply.code(204).send();
  });

  // 立即向渠道发一条示例告警，返回渠道的回答。渠道不通是正常的结果（200 + ok: false），不是接口错误。
  app.post('/api/v1/alert-rules/:ruleId/test', async (request, reply) => {
    const result = await sendTestAlert(database, param(request.params, 'ruleId'), {
      dashboardUrl: config.dashboardUrl,
    });
    return result ?? reply.code(404).send(ruleNotFound);
  });

  app.get('/api/v1/projects/:projectId/alert-deliveries', async (request, reply) => {
    const projectId = param(request.params, 'projectId');
    if (!projectExists(projectId)) return reply.code(404).send(notFound);
    const limit = Number((request.query as Record<string, string | undefined>).limit ?? 20);
    return {
      items: listAlertDeliveries(
        database,
        projectId,
        Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20,
      ),
    };
  });
}

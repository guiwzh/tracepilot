import { randomUUID } from 'node:crypto';
import type {
  InvestigationEvent,
  InvestigationReport,
  InvestigationRun,
  InvestigationStatus,
  InvestigationStreamEvent,
  InvestigationUsage,
} from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { parseJson } from '../lib/json';

/**
 * 调查运行的持久化与分发。
 *
 * 每个事件带一个运行内单调递增的 seq，先写库再通知订阅者：SSE 断线后客户端带着最后收到的
 * seq 重连，服务端从库里回放之后的事件，页面刷新也能看到完整的调查过程。
 *
 * 模型的文本增量是逐 token 到达的，一个 token 一行记录、一条 SSE 消息太浪费。
 * 这里把同一步的连续文本在约 50 ms 内合并成一条再落库；遇到其他类型的事件先冲刷文本，
 * 保证事件顺序不被打乱。
 */
type Listener = (event: InvestigationStreamEvent) => void;

const TEXT_FLUSH_MS = 50;

interface PendingText {
  step: number;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

type Row = Record<string, unknown>;

function mapRun(row: Row): InvestigationRun {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    status: row.status as InvestigationStatus,
    engine: row.engine as InvestigationRun['engine'],
    model: String(row.model),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    usage: {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      steps: Number(row.steps ?? 0),
      toolCalls: Number(row.tool_calls ?? 0),
    },
    report: row.report_json
      ? parseJson<InvestigationReport | null>(String(row.report_json), null)
      : null,
    error: row.error == null ? null : String(row.error),
  };
}

export class InvestigationStore {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly nextSeq = new Map<string, number>();
  private readonly pendingText = new Map<string, PendingText>();

  constructor(private readonly database: TraceDatabase) {
    // 运行只存在于进程内存里的循环中；进程重启时仍标记为 running 的记录永远不会结束，
    // 启动时统一标记为失败，并补一条终止事件，让回放它们的客户端能正常收尾。
    const stale = database.sqlite
      .prepare("SELECT id FROM investigation_runs WHERE status = 'running'")
      .all() as Array<{ id: string }>;
    for (const { id } of stale) {
      this.finish(id, 'failed', {
        type: 'run.failed',
        error: 'SERVER_RESTARTED',
        message: 'The server restarted before this investigation finished.',
        usage: this.getRun(id)?.usage ?? {
          inputTokens: 0,
          outputTokens: 0,
          steps: 0,
          toolCalls: 0,
        },
      });
    }
  }

  createRun(issueId: string, engine: InvestigationRun['engine'], model: string): InvestigationRun {
    const id = randomUUID();
    this.database.sqlite
      .prepare(
        `INSERT INTO investigation_runs (id, issue_id, status, engine, model, started_at)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, issueId, engine, model, Date.now());
    this.nextSeq.set(id, 1);
    return this.getRun(id)!;
  }

  getRun(runId: string): InvestigationRun | null {
    const row = this.database.sqlite
      .prepare('SELECT * FROM investigation_runs WHERE id = ?')
      .get(runId) as Row | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(issueId: string): InvestigationRun[] {
    const rows = this.database.sqlite
      .prepare(
        'SELECT * FROM investigation_runs WHERE issue_id = ? ORDER BY started_at DESC LIMIT 20',
      )
      .all(issueId) as Row[];
    return rows.map(mapRun);
  }

  runningRunFor(issueId: string): InvestigationRun | null {
    const row = this.database.sqlite
      .prepare(
        "SELECT * FROM investigation_runs WHERE issue_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(issueId) as Row | undefined;
    return row ? mapRun(row) : null;
  }

  append(runId: string, event: InvestigationEvent): void {
    if (event.type === 'text.delta') {
      const pending = this.pendingText.get(runId);
      if (pending && pending.step === event.step) {
        pending.text += event.text;
        return;
      }
      this.flushText(runId);
      this.pendingText.set(runId, {
        step: event.step,
        text: event.text,
        timer: setTimeout(() => this.flushText(runId), TEXT_FLUSH_MS),
      });
      return;
    }
    this.flushText(runId);
    this.write(runId, event);
  }

  finish(
    runId: string,
    status: Exclude<InvestigationStatus, 'running'>,
    terminal: Extract<
      InvestigationEvent,
      { type: 'run.completed' | 'run.failed' | 'run.cancelled' }
    >,
  ): void {
    const usage: InvestigationUsage = terminal.usage;
    this.database.sqlite
      .prepare(
        `UPDATE investigation_runs SET status = ?, finished_at = ?, input_tokens = ?, output_tokens = ?,
           steps = ?, tool_calls = ?, report_json = ?, error = ? WHERE id = ?`,
      )
      .run(
        status,
        Date.now(),
        usage.inputTokens,
        usage.outputTokens,
        usage.steps,
        usage.toolCalls,
        terminal.type === 'run.completed' ? JSON.stringify(terminal.report) : null,
        terminal.type === 'run.failed' ? terminal.error : null,
        runId,
      );
    // 终止事件在状态落库之后写入：客户端收到它时，再查询运行记录一定是最终状态。
    this.append(runId, terminal);
  }

  eventsAfter(runId: string, after: number): InvestigationStreamEvent[] {
    const rows = this.database.sqlite
      .prepare(
        'SELECT seq, created_at, payload_json FROM investigation_events WHERE run_id = ? AND seq > ? ORDER BY seq',
      )
      .all(runId, after) as Array<{ seq: number; created_at: number; payload_json: string }>;
    return rows.map((row) => ({
      seq: row.seq,
      at: row.created_at,
      event: JSON.parse(row.payload_json) as InvestigationEvent,
    }));
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  private flushText(runId: string): void {
    const pending = this.pendingText.get(runId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingText.delete(runId);
    this.write(runId, { type: 'text.delta', step: pending.step, text: pending.text });
  }

  private write(runId: string, event: InvestigationEvent): void {
    let seq = this.nextSeq.get(runId);
    if (seq === undefined) {
      const row = this.database.sqlite
        .prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM investigation_events WHERE run_id = ?')
        .get(runId) as { last: number };
      seq = row.last + 1;
    }
    this.nextSeq.set(runId, seq + 1);
    const record: InvestigationStreamEvent = { seq, at: Date.now(), event };
    this.database.sqlite
      .prepare(
        'INSERT INTO investigation_events (run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(runId, seq, event.type, JSON.stringify(event), record.at);
    for (const listener of this.listeners.get(runId) ?? []) listener(record);
    if (
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled'
    ) {
      this.nextSeq.delete(runId);
    }
  }
}

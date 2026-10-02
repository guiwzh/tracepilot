import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Ban,
  Bot,
  Check,
  CircleDot,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
} from 'lucide-react';
import type { InvestigationReport } from '@trace-pilot/shared';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../services/api';
import { formatNumber } from '../../utils/format';
import { FixBriefPanel } from './FixBriefPanel';
import type { InvestigationViewState, StepView, ToolCallView } from './reducer';
import { useInvestigationStream, type StreamConnection } from './useInvestigationStream';

/**
 * Issue 详情页的「AI 调查」面板：启动调查、实时展示每一步的思路和工具调用、
 * 展示带引用核验的最终报告。报告里的每条证据都能跳回产生它的那次工具调用。
 */
const TOOL_LABELS: Record<string, string> = {
  get_issue_overview: 'Issue overview',
  list_event_samples: 'Event samples',
  get_event_detail: 'Event detail',
  get_source_context: 'Source context',
  compare_releases: 'Release comparison',
  read_source_file: 'Source file',
  search_code: 'Code search',
  find_suspect_commits: 'Suspect commits',
};

function prettyOutput(output: string): string {
  try {
    // 多行字符串（源码片段、异常栈）拆成逐行数组显示，否则换行符会以 \n 挤在一行里。
    return JSON.stringify(
      JSON.parse(output),
      (_key, value: unknown) =>
        typeof value === 'string' && value.includes('\n') ? value.split('\n') : value,
      2,
    );
  } catch {
    return output;
  }
}

function argumentSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  return entries.length === 0
    ? ''
    : entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
}

/** 运行中每秒刷新一次的耗时。 */
function useElapsed(startedAt: number | null, finishedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || finishedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt, finishedAt]);
  if (!startedAt) return 0;
  return Math.max(0, (finishedAt ?? now) - startedAt);
}

/**
 * 内容增长时跟随到底部，但只在用户本来就停在底部附近时才跟随：
 * 用户往上翻看某一步时，新到的内容不能把页面拽走。
 */
function useFollowBottom(trigger: unknown, active: boolean) {
  const endRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      following.current =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (active && following.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [trigger, active]);
  return endRef;
}

function ConnectionPill({ connection, status }: { connection: StreamConnection; status: string }) {
  if (status !== 'running') return null;
  const label =
    connection === 'open'
      ? 'Live'
      : connection === 'reconnecting'
        ? 'Reconnecting…'
        : 'Connecting…';
  return (
    <span className={`connection-pill is-${connection}`}>
      <i /> {label}
    </span>
  );
}

function ToolCallCard({
  call,
  expanded,
  highlighted,
  onToggle,
}: {
  call: ToolCallView;
  expanded: boolean;
  highlighted: boolean;
  onToggle(open: boolean): void;
}) {
  return (
    <li
      id={`tool-${call.id}`}
      className={`tool-call is-${call.status}${highlighted ? ' is-highlighted' : ''}`}
    >
      <header>
        <span className="tool-status" aria-hidden="true">
          {call.status === 'running' ? (
            <LoaderCircle className="spin" size={13} />
          ) : call.status === 'ok' ? (
            <Check size={13} />
          ) : (
            <AlertTriangle size={13} />
          )}
        </span>
        <span className="tool-ref">{call.ref}</span>
        <strong>{TOOL_LABELS[call.name] ?? call.name}</strong>
        <code>
          {call.name}({argumentSummary(call.args)})
        </code>
        {call.durationMs !== undefined && <small>{call.durationMs} ms</small>}
      </header>
      {call.output && (
        <details open={expanded} onToggle={(event) => onToggle(event.currentTarget.open)}>
          <summary>
            {call.status === 'error'
              ? 'Error returned to the model'
              : 'Result returned to the model'}
            {call.truncated ? ' · truncated' : ''}
          </summary>
          <pre>{prettyOutput(call.output)}</pre>
        </details>
      )}
    </li>
  );
}

function StepCard({
  step,
  streaming,
  expanded,
  highlighted,
  onToggle,
}: {
  step: StepView;
  streaming: boolean;
  expanded: ReadonlySet<string>;
  highlighted: string | null;
  onToggle(id: string, open: boolean): void;
}) {
  return (
    <li className="investigation-step">
      <span className="step-index">S{String(step.step).padStart(2, '0')}</span>
      <div>
        {(step.text || streaming) && (
          <p className="step-thought">
            {step.text}
            {streaming && <span className="caret" aria-hidden="true" />}
          </p>
        )}
        {step.toolCalls.length > 0 && (
          <ol className="tool-calls">
            {step.toolCalls.map((call) => (
              <ToolCallCard
                key={call.id}
                call={call}
                expanded={expanded.has(call.id)}
                highlighted={highlighted === call.id}
                onToggle={(open) => onToggle(call.id, open)}
              />
            ))}
          </ol>
        )}
        {step.rejected.map((problems, index) => (
          <aside className="report-rejected" key={index}>
            <strong>Report rejected by citation check</strong>
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </aside>
        ))}
      </div>
    </li>
  );
}

function ReportView({
  report,
  onJump,
}: {
  report: InvestigationReport;
  onJump(toolCallId: string): void;
}) {
  const verified = report.evidence.filter((item) => item.verified).length;
  return (
    <section className="diagnosis-report investigation-report" aria-label="Investigation report">
      <header className="diagnosis-header">
        <div>
          <span className="ai-orbit small">
            <Bot />
          </span>
          <div>
            <p className="page-eyebrow">Report</p>
            <h2>{report.summary}</h2>
          </div>
        </div>
        <span
          className={`verification-badge ${report.verification.allVerified ? 'is-ok' : 'is-warn'}`}
        >
          {report.verification.allVerified ? (
            <ShieldCheck size={13} />
          ) : (
            <AlertTriangle size={13} />
          )}
          {verified} / {report.evidence.length} citations verified
        </span>
      </header>
      {!report.verification.allVerified && (
        <aside className="missing-info">
          <strong>Some citations could not be verified</strong>
          <span>{report.verification.problems.join(' · ')}</span>
        </aside>
      )}
      <section className="evidence-citations">
        <h3>Evidence cited</h3>
        {report.evidence.map((item, index) => (
          <article key={`${item.resultRef}-${index}`} id={`evidence-${index}`}>
            <span>E{index + 1}</span>
            <div>
              <small>
                {item.source} · cites {item.resultRef} ·{' '}
                {item.verified ? 'quote verified' : 'quote not found'}
              </small>
              <p>{item.description}</p>
              <blockquote className={item.verified ? '' : 'is-unverified'}>{item.quote}</blockquote>
              {item.toolCallId ? (
                <button className="link-button" onClick={() => onJump(item.toolCallId!)}>
                  <Wrench size={11} /> Open {item.resultRef}
                </button>
              ) : (
                <span className="form-error">Cited result does not exist</span>
              )}
            </div>
          </article>
        ))}
      </section>
      <section className="cause-grid">
        {report.possibleCauses.map((cause) => (
          <article key={cause.cause}>
            <header>
              <span>{Math.round(cause.confidence * 100)}%</span>
              <div className="confidence-bar">
                <i style={{ width: `${cause.confidence * 100}%` }} />
              </div>
            </header>
            <h3>{cause.cause}</h3>
            <div className="evidence-refs">
              {cause.evidenceRefs.map((ref) => (
                <a key={ref} href={`#evidence-${ref}`}>
                  E{ref + 1}
                </a>
              ))}
            </div>
          </article>
        ))}
      </section>
      <div className="diagnosis-columns">
        <section>
          <h3>
            <CircleDot size={15} /> Next steps
          </h3>
          <ol>
            {report.investigationSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
        <section>
          <h3>
            <Lightbulb size={15} /> Suggested changes
          </h3>
          <ul>
            {report.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </section>
      </div>
      {report.missingInformation.length > 0 && (
        <aside className="missing-info">
          <strong>Evidence still missing</strong>
          <span>{report.missingInformation.join(' · ')}</span>
        </aside>
      )}
      <p className="diagnosis-disclaimer">{report.disclaimer}</p>
    </section>
  );
}

function RunHeader({
  state,
  startedBy,
  connection,
  onCancel,
  onRestart,
  cancelling,
  restarting,
}: {
  state: InvestigationViewState;
  /** 这次运行是谁发起的：告警自动发起的在说明里注明。 */
  startedBy: 'person' | 'alert' | undefined;
  connection: StreamConnection;
  onCancel(): void;
  onRestart(): void;
  cancelling: boolean;
  restarting: boolean;
}) {
  const elapsed = useElapsed(state.startedAt, state.finishedAt);
  const toolCalls = state.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);
  const statusLabel = {
    idle: 'Loading',
    running: 'Investigating',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  }[state.status];
  return (
    <header className="investigation-header">
      <div>
        <p className="page-eyebrow" aria-live="polite">
          <span className={`run-status is-${state.status}`}>{statusLabel}</span>
          <ConnectionPill connection={connection} status={state.status} />
        </p>
        <h2>Evidence-bound investigation</h2>
        <p className="engine-note">
          {startedBy === 'alert' ? 'Started automatically by an alert rule. ' : ''}
          {state.engine === 'local'
            ? 'Offline demo: a deterministic script drives the same tools and checks. It is not model reasoning.'
            : `Model ${state.model ?? '…'} · read-only tools · every citation checked against tool output`}
        </p>
      </div>
      <dl className="run-stats">
        <div>
          <dt>Elapsed</dt>
          <dd>{(elapsed / 1000).toFixed(1)} s</dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{toolCalls}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {state.usage ? formatNumber(state.usage.inputTokens + state.usage.outputTokens) : '—'}
          </dd>
        </div>
      </dl>
      {state.status === 'running' ? (
        <button className="button button-quiet" onClick={onCancel} disabled={cancelling}>
          <Square size={13} /> {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      ) : (
        <button className="button button-quiet" onClick={onRestart} disabled={restarting}>
          <RefreshCw size={13} /> Run again
        </button>
      )}
    </header>
  );
}

export function InvestigationPanel({ issueId }: { issueId: string }) {
  const queryClient = useQueryClient();
  const runs = useQuery({
    queryKey: ['investigations', issueId],
    queryFn: () => api.investigations(issueId),
  });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // 默认展示最近一次运行：刷新页面后，进行中的调查会通过事件回放继续接上。
  const runId = selectedRunId ?? runs.data?.items[0]?.id ?? null;
  const { state, connection } = useInvestigationStream(runId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => api.startInvestigation(issueId),
    onSuccess: async (run) => {
      setSelectedRunId(run.id);
      setExpanded(new Set());
      await queryClient.invalidateQueries({ queryKey: ['investigations', issueId] });
    },
  });
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelInvestigation(id) });

  const finished =
    state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled';
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries({ queryKey: ['investigations', issueId] });
  }, [finished, issueId, queryClient]);

  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), 2_000);
    return () => clearTimeout(timer);
  }, [highlighted]);

  const endRef = useFollowBottom(state.lastSeq, state.status === 'running');

  function toggle(id: string, open: boolean) {
    setExpanded((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function jumpToTool(toolCallId: string) {
    toggle(toolCallId, true);
    setHighlighted(toolCallId);
    // 等展开后的内容渲染出来再滚动。
    requestAnimationFrame(() =>
      document.getElementById(`tool-${toolCallId}`)?.scrollIntoView({ block: 'center' }),
    );
  }

  if (runs.isLoading) return <LoadingState label="Loading investigations" />;
  if (runs.error) return <ErrorState message={runs.error.message} />;

  if (!runId) {
    return (
      <div className="diagnosis-empty">
        <span className="ai-orbit">
          <Bot />
        </span>
        <p className="page-eyebrow">Evidence is ready</p>
        <h2>Start an evidence-bound investigation</h2>
        <p>
          An agent works through five read-only tools: issue overview, event samples, event
          timeline, source context and release comparison. Every piece of evidence in its report
          must quote a tool result verbatim, and the server checks each quote before accepting it.
        </p>
        <button
          className="button button-signal"
          onClick={() => start.mutate()}
          disabled={start.isPending}
        >
          {start.isPending ? <RefreshCw className="spin" size={15} /> : <Sparkles size={15} />}{' '}
          {start.isPending ? 'Starting…' : 'Start investigation'}
        </button>
        {start.error && <span className="form-error">{start.error.message}</span>}
      </div>
    );
  }

  const lastStep = state.steps.at(-1)?.step;
  return (
    <div className="investigation">
      <RunHeader
        state={state}
        startedBy={runs.data?.items.find((item) => item.id === runId)?.startedBy}
        connection={connection}
        onCancel={() => cancel.mutate(runId)}
        onRestart={() => start.mutate()}
        cancelling={cancel.isPending}
        restarting={start.isPending}
      />
      {start.error && <p className="form-error">{start.error.message}</p>}
      <ol className="investigation-timeline" aria-label="Investigation steps">
        {state.steps.map((step) => (
          <StepCard
            key={step.step}
            step={step}
            streaming={state.status === 'running' && step.step === lastStep}
            expanded={expanded}
            highlighted={highlighted}
            onToggle={toggle}
          />
        ))}
      </ol>
      {state.status === 'failed' && state.error && (
        <aside className="run-error" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>{state.error.code}</strong>
            <p>{state.error.message} Issue evidence is unaffected.</p>
          </div>
        </aside>
      )}
      {state.status === 'cancelled' && (
        <aside className="run-error is-quiet">
          <Ban size={15} />
          <div>
            <strong>Cancelled</strong>
            <p>The investigation was stopped before it submitted a report.</p>
          </div>
        </aside>
      )}
      {state.report && <ReportView report={state.report} onJump={jumpToTool} />}
      {state.report && state.status === 'completed' && runId && (
        <FixBriefPanel runId={runId} issueId={issueId} />
      )}
      <div ref={endRef} />
    </div>
  );
}

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  ExternalLink,
  Gauge,
  GitCommitHorizontal,
  Globe2,
  Lightbulb,
  MousePointer2,
  Network,
  RefreshCw,
  Route,
  ShieldAlert,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Breadcrumb, DiagnosisRecord } from '@trace-pilot/shared';
import { Chart, type ChartOption } from '../components/Chart';
import { ErrorState, LoadingState } from '../components/States';
import { IssueStatusBadge, LevelMark } from '../components/Status';
import { api } from '../services/api';
import { absoluteTime, formatNumber, relativeTime } from '../utils/format';

const tabs = ['overview', 'stack', 'breadcrumbs', 'network', 'events', 'diagnosis'] as const;
type Tab = (typeof tabs)[number];

function DistributionChart({ data }: { data: Array<{ name: string; value: number }> }) {
  const option = useMemo<ChartOption>(() => ({
    animationDuration: 400,
    tooltip: { trigger: 'item', backgroundColor: '#18242c', borderWidth: 0, textStyle: { color: '#fff', fontSize: 11 } },
    series: [{ type: 'pie', radius: ['58%', '78%'], center: ['38%', '50%'], avoidLabelOverlap: true, itemStyle: { borderColor: '#f8f9f7', borderWidth: 3 }, label: { color: '#55626a', fontSize: 10, formatter: '{b}\n{d}%' }, data: data.map((item, index) => ({ ...item, itemStyle: { color: ['#e75f2b', '#486d7a', '#91a1a4', '#d3a14c', '#765a70'][index % 5] } })) }],
  }), [data]);
  return <Chart option={option} height={210} />;
}

function BreadcrumbIcon({ item }: { item: Breadcrumb }) {
  if (item.type === 'click') return <MousePointer2 />;
  if (item.type === 'network') return <Network />;
  if (item.type === 'navigation') return <Route />;
  if (item.type === 'error') return <ShieldAlert />;
  return <CircleDot />;
}

function BreadcrumbTimeline({ items }: { items: Breadcrumb[] }) {
  if (items.length === 0) return <p className="inline-empty">No breadcrumbs were attached to this event.</p>;
  return (
    <ol className="evidence-chain">
      {items.map((item, index) => (
        <li key={item.id} className={item.type === 'error' ? 'is-terminal' : ''}>
          <span className="chain-index">E{String(index + 1).padStart(2, '0')}</span>
          <span className="chain-node"><BreadcrumbIcon item={item} /></span>
          <div><small>{item.category} · {absoluteTime(item.timestamp)}</small><strong>{item.message}</strong>{item.data && <code>{JSON.stringify(item.data, null, 2)}</code>}</div>
        </li>
      ))}
    </ol>
  );
}

function StackBlock({ title, stack, mapped }: { title: string; stack?: string | null; mapped?: boolean }) {
  return (
    <section className={`stack-card ${mapped ? 'mapped-stack' : ''}`}>
      <header><div><Code2 size={16} /><strong>{title}</strong></div>{mapped && <span><Check size={12} /> Mapped to source</span>}</header>
      {stack ? <pre>{stack.split('\n').map((line, index) => <span key={`${line}-${index}`} className={index === 1 ? 'focus-line' : ''}><i>{String(index + 1).padStart(2, '0')}</i>{line}</span>)}</pre> : <p className="inline-empty">No stack was captured for this event.</p>}
    </section>
  );
}

function DiagnosisPanel({ issueId }: { issueId: string }) {
  const queryClient = useQueryClient();
  const records = useQuery({ queryKey: ['diagnoses', issueId], queryFn: () => api.diagnoses(issueId) });
  const diagnose = useMutation({
    mutationFn: () => api.diagnose(issueId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['diagnoses', issueId] }),
  });
  const record: DiagnosisRecord | undefined = diagnose.data ?? records.data?.items[0];

  if (records.isLoading) return <LoadingState label="Loading diagnosis history" />;
  if (records.error) return <ErrorState message={records.error.message} />;
  if (!record) {
    return <div className="diagnosis-empty"><span className="ai-orbit"><Bot /></span><p className="page-eyebrow">Evidence is ready</p><h2>Generate a bounded diagnosis</h2><p>The model receives the issue, recent events, failure breadcrumbs, release context, and mapped stack—after a second privacy pass.</p><button className="button button-signal" onClick={() => diagnose.mutate()} disabled={diagnose.isPending}>{diagnose.isPending ? <RefreshCw className="spin" size={15} /> : <Sparkles size={15} />} {diagnose.isPending ? 'Examining evidence…' : 'Generate diagnosis'}</button>{diagnose.error && <span className="form-error">{diagnose.error.message}</span>}</div>;
  }

  const result = record.result;
  return (
    <div className="diagnosis-report">
      <header className="diagnosis-header"><div><span className="ai-orbit small"><Bot /></span><div><p className="page-eyebrow">Diagnosis / {record.promptVersion}</p><h2>{result.summary}</h2></div></div><button className="button button-quiet" onClick={() => diagnose.mutate()} disabled={diagnose.isPending}><RefreshCw size={14} /> Regenerate</button></header>
      <div className="diagnosis-meta"><span>Model <strong>{record.model}</strong></span><span>Latency <strong>{record.latencyMs} ms</strong></span><span>Tokens <strong>{record.inputTokens + record.outputTokens}</strong></span><span>{record.cached ? 'Cache hit' : relativeTime(record.createdAt)}</span></div>
      <section className="evidence-citations"><h3>Evidence cited</h3>{result.evidence.map((item, index) => <article key={`${item.description}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><div><small>{item.source}</small><p>{item.description}</p></div></article>)}</section>
      <section className="cause-grid">{result.possibleCauses.map((item) => <article key={item.cause}><header><span>{Math.round(item.confidence * 100)}%</span><div className="confidence-bar"><i style={{ width: `${item.confidence * 100}%` }} /></div></header><h3>{item.cause}</h3><ul>{item.supportingEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul></article>)}</section>
      <div className="diagnosis-columns"><section><h3><CircleDot size={15} /> Investigation steps</h3><ol>{result.investigationSteps.map((step) => <li key={step}>{step}</li>)}</ol></section><section><h3><Lightbulb size={15} /> Suggested changes</h3><ul>{result.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul></section></div>
      {result.missingInformation.length > 0 && <aside className="missing-info"><strong>Evidence still missing</strong><span>{result.missingInformation.join(' · ')}</span></aside>}
      <p className="diagnosis-disclaimer">{result.disclaimer}</p>
    </div>
  );
}

export function IssueDetailPage() {
  const { projectId = '', issueId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (tabs.includes(searchParams.get('tab') as Tab) ? searchParams.get('tab') : 'overview') as Tab;
  const queryClient = useQueryClient();
  const issue = useQuery({ queryKey: ['issue', issueId], queryFn: () => api.issue(issueId) });
  const events = useQuery({ queryKey: ['issue-events', issueId], queryFn: () => api.issueEvents(issueId) });
  const update = useMutation({ mutationFn: (status: string) => api.updateIssue(issueId, status), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['issue', issueId] }); await queryClient.invalidateQueries({ queryKey: ['issues', projectId] }); } });

  if (issue.isLoading) return <main className="page-content"><LoadingState /></main>;
  if (issue.error || !issue.data) return <main className="page-content"><ErrorState message={issue.error?.message ?? 'Issue not found'} /></main>;
  const data = issue.data;
  const sample = data.sampleEvent;
  const networkBreadcrumbs = sample?.breadcrumbs.filter((item) => item.type === 'network') ?? [];

  return (
    <main className="page-content issue-detail">
      <Link className="back-link" to={`/projects/${projectId}/issues`}><ArrowLeft size={14} /> Back to issues</Link>
      <header className="issue-header">
        <div className="issue-heading-mark"><LevelMark level={data.level} /></div>
        <div className="issue-heading"><div><IssueStatusBadge status={data.status} /><span className="issue-key">ISS-{data.id.slice(0, 6).toUpperCase()}</span></div><h1>{data.title}</h1><p>First seen {absoluteTime(data.firstSeenAt)} · latest evidence {relativeTime(data.lastSeenAt)}</p></div>
        <select className="status-select" aria-label="Change issue status" value={data.status} disabled={update.isPending} onChange={(event) => update.mutate(event.target.value)}><option value="unresolved">Unresolved</option><option value="resolved">Resolved</option><option value="ignored">Ignored</option></select>
      </header>

      <nav className="detail-tabs" aria-label="Issue evidence sections">
        {tabs.map((tab) => <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => setSearchParams({ tab })}>{tab === 'diagnosis' && <Sparkles size={13} />}{tab}</button>)}
      </nav>

      {activeTab === 'overview' && <div className="detail-overview">
        <section className="evidence-summary"><article><span><Clock3 /></span><small>Event count</small><strong>{formatNumber(data.eventCount)}</strong><p>Since {absoluteTime(data.firstSeenAt)}</p></article><article><span><UserRound /></span><small>Affected users</small><strong>{formatNumber(data.userCount)}</strong><p>Distinct captured identities</p></article><article><span><GitCommitHorizontal /></span><small>Latest release</small><strong>{data.latestRelease ?? 'Unknown'}</strong><p>Source-map lookup boundary</p></article><article><span><Globe2 /></span><small>Last route</small><strong className="text-value">{sample?.pageUrl ?? 'Unknown'}</strong><p>{sample?.context.device.userAgent.slice(0, 42) ?? 'No device context'}</p></article></section>
        <div className="overview-evidence-grid"><section className="panel"><header className="panel-title"><div><span className="signal-tick" /><h2>Latest evidence chain</h2></div><button onClick={() => setSearchParams({ tab: 'breadcrumbs' })}>View all <ChevronRight size={13} /></button></header><BreadcrumbTimeline items={sample?.breadcrumbs.slice(-5) ?? []} /></section><section className="panel"><header className="panel-title"><div><h2>Browser share</h2></div></header><DistributionChart data={data.browserDistribution} /></section></div>
        <section className="panel source-preview"><header className="panel-title"><div><h2>Source location</h2></div><button onClick={() => setSearchParams({ tab: 'stack' })}>Open stack <ExternalLink size={13} /></button></header><StackBlock title={sample?.originalStack ? 'Original source' : 'Minified stack · no map found'} stack={sample?.originalStack ?? sample?.stack} mapped={Boolean(sample?.originalStack)} /></section>
      </div>}

      {activeTab === 'stack' && <div className="stack-layout"><StackBlock title="Original source trace" stack={sample?.originalStack} mapped={Boolean(sample?.originalStack)} /><StackBlock title="Minified browser trace" stack={sample?.stack} /><aside className="evidence-note"><strong>Resolution rule</strong><p>TracePilot matches the event release and minified filename to a private map. Missing maps preserve the browser stack without blocking investigation.</p></aside></div>}
      {activeTab === 'breadcrumbs' && <section className="panel full-panel"><header className="panel-title"><div><span className="signal-tick" /><h2>Chronological evidence chain</h2></div><small>{sample?.breadcrumbs.length ?? 0} attached actions</small></header><BreadcrumbTimeline items={sample?.breadcrumbs ?? []} /></section>}
      {activeTab === 'network' && <section className="panel full-panel"><header className="panel-title"><div><h2>Network evidence</h2></div><small>Request bodies are excluded</small></header>{networkBreadcrumbs.length === 0 ? <p className="inline-empty">No network breadcrumbs accompanied the selected event.</p> : <div className="network-list">{networkBreadcrumbs.map((item) => <article key={item.id}><span className={Number(item.data?.status) >= 400 ? 'request-failed' : 'request-ok'}>{String(item.data?.method ?? 'GET')}</span><div><strong>{String(item.data?.url ?? item.message)}</strong><small>{Number(item.data?.duration ?? 0).toFixed(1)} ms · HTTP {String(item.data?.status ?? 'unknown')}</small></div></article>)}</div>}</section>}
      {activeTab === 'events' && <section className="panel full-panel"><header className="panel-title"><div><h2>Recent event samples</h2></div><small>Newest first</small></header>{events.isLoading ? <LoadingState /> : events.error ? <ErrorState message={events.error.message} /> : <div className="events-table"><div><span>Event</span><span>User</span><span>Release</span><span>Route</span><span>Captured</span></div>{events.data?.items.map((event) => <article key={event.id}><code>{event.id.slice(0, 8)}</code><span>{event.userId ?? 'Anonymous'}</span><span>{event.context.release}</span><span>{event.pageUrl}</span><time>{relativeTime(event.createdAt)}</time></article>)}</div>}</section>}
      {activeTab === 'diagnosis' && <DiagnosisPanel issueId={issueId} />}
    </main>
  );
}

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  ExternalLink,
  GitCommitHorizontal,
  Globe2,
  MousePointer2,
  Network,
  Route,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  UserRound,
} from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Breadcrumb } from '@trace-pilot/shared';
import { Chart, type ChartOption } from '../components/Chart';
import { ErrorState, LoadingState } from '../components/States';
import { InvestigationPanel } from '../features/investigation/InvestigationPanel';
import { IssueStatusBadge, LevelMark } from '../components/Status';
import { api } from '../services/api';
import { absoluteTime, formatNumber, relativeTime } from '../utils/format';
import { isFailedRequest, requestOutcome } from '../utils/network';

const tabs = ['overview', 'stack', 'breadcrumbs', 'network', 'events', 'investigation'] as const;
type Tab = (typeof tabs)[number];

function DistributionChart({ data }: { data: Array<{ name: string; value: number }> }) {
  // 分布数据不变时复用 option 对象，避免命令式 ECharts 实例无谓重建。
  const option = useMemo<ChartOption>(
    () => ({
      animationDuration: 400,
      tooltip: {
        trigger: 'item',
        backgroundColor: '#18242c',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
      },
      series: [
        {
          type: 'pie',
          radius: ['58%', '78%'],
          center: ['38%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: '#f8f9f7', borderWidth: 3 },
          label: { color: '#55626a', fontSize: 10, formatter: '{b}\n{d}%' },
          data: data.map((item, index) => ({
            ...item,
            itemStyle: {
              color: ['#e75f2b', '#486d7a', '#91a1a4', '#d3a14c', '#765a70'][index % 5],
            },
          })),
        },
      ],
    }),
    [data],
  );
  return <Chart option={option} height={210} />;
}

function BreadcrumbIcon({ item }: { item: Breadcrumb }) {
  if (item.type === 'click') return <MousePointer2 />;
  if (item.type === 'network') return <Network />;
  if (item.type === 'navigation') return <Route />;
  if (item.type === 'error') return <ShieldAlert />;
  if (item.type === 'console') return <SquareTerminal />;
  return <CircleDot />;
}

function BreadcrumbTimeline({ items }: { items: Breadcrumb[] }) {
  if (items.length === 0)
    return <p className="inline-empty">No breadcrumbs were attached to this event.</p>;
  return (
    <ol className="evidence-chain">
      {items.map((item, index) => (
        <li key={item.id} className={item.type === 'error' ? 'is-terminal' : ''}>
          <span className="chain-index">E{String(index + 1).padStart(2, '0')}</span>
          <span className="chain-node">
            <BreadcrumbIcon item={item} />
          </span>
          <div>
            <small>
              {item.category} · {absoluteTime(item.timestamp)}
            </small>
            <strong>
              {item.message}
              {/* SDK 把连续相同的控制台输出合并成一条，count 是合并的次数。 */}
              {Number(item.data?.count) > 1 && ` ×${String(item.data?.count)}`}
            </strong>
            {item.data && <code>{JSON.stringify(item.data, null, 2)}</code>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StackBlock({
  title,
  stack,
  mapped,
}: {
  title: string;
  stack?: string | null;
  mapped?: boolean;
}) {
  return (
    <section className={`stack-card ${mapped ? 'mapped-stack' : ''}`}>
      <header>
        <div>
          <Code2 size={16} />
          <strong>{title}</strong>
        </div>
        {mapped && (
          <span>
            <Check size={12} /> Mapped to source
          </span>
        )}
      </header>
      {stack ? (
        <pre>
          {stack.split('\n').map((line, index) => (
            <span key={`${line}-${index}`} className={index === 1 ? 'focus-line' : ''}>
              <i>{String(index + 1).padStart(2, '0')}</i>
              {line}
            </span>
          ))}
        </pre>
      ) : (
        <p className="inline-empty">No stack was captured for this event.</p>
      )}
    </section>
  );
}

export function IssueDetailPage() {
  const { projectId = '', issueId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  // tab 保存在 URL 中；未知值回退 overview，用户可直接分享某个证据标签链接。
  const activeTab = (
    tabs.includes(searchParams.get('tab') as Tab) ? searchParams.get('tab') : 'overview'
  ) as Tab;
  const queryClient = useQueryClient();
  const issue = useQuery({ queryKey: ['issue', issueId], queryFn: () => api.issue(issueId) });
  // 最近 100 个事件（各带完整上下文和 breadcrumb）只有 Events 标签用得到，切到它时才请求。
  const events = useQuery({
    queryKey: ['issue-events', issueId],
    queryFn: () => api.issueEvents(issueId),
    enabled: activeTab === 'events',
  });
  const update = useMutation({
    mutationFn: (status: string) => api.updateIssue(issueId, status),
    onSuccess: async () => {
      // 状态既出现在详情也出现在列表，因此两个 queryKey 都需要失效。
      await queryClient.invalidateQueries({ queryKey: ['issue', issueId] });
      await queryClient.invalidateQueries({ queryKey: ['issues', projectId] });
    },
  });

  if (issue.isLoading)
    return (
      <main className="page-content">
        <LoadingState />
      </main>
    );
  if (issue.error || !issue.data)
    return (
      <main className="page-content">
        <ErrorState message={issue.error?.message ?? 'Issue not found'} />
      </main>
    );
  const data = issue.data;
  // Server 已选择该 Issue 最新事件作为 sampleEvent，六个标签都围绕同一现场展示。
  const sample = data.sampleEvent;
  const networkBreadcrumbs = sample?.breadcrumbs.filter((item) => item.type === 'network') ?? [];

  return (
    <main className="page-content issue-detail">
      <Link className="back-link" to={`/projects/${projectId}/issues`}>
        <ArrowLeft size={14} /> Back to issues
      </Link>
      <header className="issue-header">
        <div className="issue-heading-mark">
          <LevelMark level={data.level} />
        </div>
        <div className="issue-heading">
          <div>
            <IssueStatusBadge status={data.status} />
            <span className="issue-key">ISS-{data.id.slice(0, 6).toUpperCase()}</span>
          </div>
          <h1>{data.title}</h1>
          <p>
            First seen {absoluteTime(data.firstSeenAt)} · latest evidence{' '}
            {relativeTime(data.lastSeenAt)}
          </p>
        </div>
        <select
          className="status-select"
          aria-label="Change issue status"
          value={data.status}
          disabled={update.isPending}
          onChange={(event) => update.mutate(event.target.value)}
        >
          <option value="unresolved">Unresolved</option>
          <option value="resolved">Resolved</option>
          <option value="ignored">Ignored</option>
        </select>
      </header>

      <nav className="detail-tabs" aria-label="Issue evidence sections">
        {tabs.map((tab) => (
          <button
            key={tab}
            className={activeTab === tab ? 'active' : ''}
            onClick={() => setSearchParams({ tab })}
          >
            {tab === 'investigation' && <Sparkles size={13} />}
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === 'overview' && (
        <div className="detail-overview">
          <section className="evidence-summary">
            <article>
              <span>
                <Clock3 />
              </span>
              <small>Event count</small>
              <strong>{formatNumber(data.eventCount)}</strong>
              <p>Since {absoluteTime(data.firstSeenAt)}</p>
            </article>
            <article>
              <span>
                <UserRound />
              </span>
              <small>Affected users</small>
              <strong>{formatNumber(data.userCount)}</strong>
              <p>Distinct captured identities</p>
            </article>
            <article>
              <span>
                <GitCommitHorizontal />
              </span>
              <small>Latest release</small>
              <strong>{data.latestRelease ?? 'Unknown'}</strong>
              <p>Source-map lookup boundary</p>
            </article>
            <article>
              <span>
                <Globe2 />
              </span>
              <small>Last route</small>
              <strong className="text-value">{sample?.pageUrl ?? 'Unknown'}</strong>
              <p>{sample?.context.device.userAgent.slice(0, 42) ?? 'No device context'}</p>
            </article>
          </section>
          <div className="overview-evidence-grid">
            <section className="panel">
              <header className="panel-title">
                <div>
                  <span className="signal-tick" />
                  <h2>Latest evidence chain</h2>
                </div>
                <button onClick={() => setSearchParams({ tab: 'breadcrumbs' })}>
                  View all <ChevronRight size={13} />
                </button>
              </header>
              <BreadcrumbTimeline items={sample?.breadcrumbs.slice(-5) ?? []} />
            </section>
            <section className="panel">
              <header className="panel-title">
                <div>
                  <h2>Browser share</h2>
                </div>
              </header>
              <DistributionChart data={data.browserDistribution} />
            </section>
          </div>
          <div className="distribution-grid">
            <section className="panel">
              <header className="panel-title">
                <div>
                  <h2>Route share</h2>
                </div>
              </header>
              <DistributionChart data={data.routeDistribution} />
            </section>
            <section className="panel">
              <header className="panel-title">
                <div>
                  <h2>Release share</h2>
                </div>
              </header>
              <DistributionChart data={data.releaseDistribution} />
            </section>
          </div>
          <section className="panel source-preview">
            <header className="panel-title">
              <div>
                <h2>Source location</h2>
              </div>
              <button onClick={() => setSearchParams({ tab: 'stack' })}>
                Open stack <ExternalLink size={13} />
              </button>
            </header>
            <StackBlock
              title={sample?.originalStack ? 'Original source' : 'Minified stack · no map found'}
              stack={sample?.originalStack ?? sample?.stack}
              mapped={Boolean(sample?.originalStack)}
            />
          </section>
        </div>
      )}

      {activeTab === 'stack' && (
        <div className="stack-layout">
          <StackBlock
            title="Original source trace"
            stack={sample?.originalStack}
            mapped={Boolean(sample?.originalStack)}
          />
          <StackBlock title="Minified browser trace" stack={sample?.stack} />
          <aside className="evidence-note">
            <strong>Resolution rule</strong>
            <p>
              TracePilot matches the event release and minified filename to a private map. Missing
              maps preserve the browser stack without blocking investigation.
            </p>
          </aside>
        </div>
      )}
      {activeTab === 'breadcrumbs' && (
        <section className="panel full-panel">
          <header className="panel-title">
            <div>
              <span className="signal-tick" />
              <h2>Chronological evidence chain</h2>
            </div>
            <small>{sample?.breadcrumbs.length ?? 0} attached actions</small>
          </header>
          <BreadcrumbTimeline items={sample?.breadcrumbs ?? []} />
        </section>
      )}
      {activeTab === 'network' && (
        <section className="panel full-panel">
          <header className="panel-title">
            <div>
              <h2>Network evidence</h2>
            </div>
            <small>Request bodies are excluded</small>
          </header>
          {networkBreadcrumbs.length === 0 ? (
            <p className="inline-empty">No network breadcrumbs accompanied the selected event.</p>
          ) : (
            <div className="network-list">
              {networkBreadcrumbs.map((item) => (
                <article key={item.id}>
                  <span className={isFailedRequest(item.data) ? 'request-failed' : 'request-ok'}>
                    {String(item.data?.method ?? 'GET')}
                  </span>
                  <div>
                    <strong>{String(item.data?.url ?? item.message)}</strong>
                    <small>
                      {Number(item.data?.duration ?? 0).toFixed(1)} ms · {requestOutcome(item.data)}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      {activeTab === 'events' && (
        <section className="panel full-panel">
          <header className="panel-title">
            <div>
              <h2>Recent event samples</h2>
            </div>
            <small>Newest first</small>
          </header>
          {events.isLoading ? (
            <LoadingState />
          ) : events.error ? (
            <ErrorState message={events.error.message} />
          ) : (
            <div className="events-table">
              <div>
                <span>Event</span>
                <span>User</span>
                <span>Release</span>
                <span>Route</span>
                <span>Captured</span>
              </div>
              {events.data?.items.map((event) => (
                <article key={event.id}>
                  <code>{event.id.slice(0, 8)}</code>
                  <span>{event.userId ?? 'Anonymous'}</span>
                  <span>{event.context.release}</span>
                  <span>{event.pageUrl}</span>
                  <time>{relativeTime(event.createdAt)}</time>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      {activeTab === 'investigation' && <InvestigationPanel issueId={issueId} />}
    </main>
  );
}

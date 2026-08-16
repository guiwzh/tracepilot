import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ChevronLeft, ChevronRight, Route, Rows3, Search } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Chart, type ChartOption } from '../components/Chart';
import { PageHeader } from '../components/PageHeader';
import { Sparkline } from '../components/Sparkline';
import { ErrorState, EmptyState, LoadingState } from '../components/States';
import { IssueStatusBadge, LevelMark } from '../components/Status';
import { api } from '../services/api';
import { usePreferences } from '../stores/preferences';
import { formatNumber, relativeTime } from '../utils/format';

const ISSUE_PAGE_SIZES = [10, 25, 50, 100] as const;

/** Issue 列表把 URL 查询参数作为筛选状态的唯一事实来源，链接可复制、刷新可恢复。 */
export function IssuesPage() {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [route, setRoute] = useState(searchParams.get('route') ?? '');
  const compactRows = usePreferences((state) => state.compactRows);
  const setCompactRows = usePreferences((state) => state.setCompactRows);
  // useMemo 避免每次渲染都创建新 URLSearchParams，并把 UI 的 window 选项转换为绝对时间。
  const requestParams = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    const durations: Record<string, number> = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const duration = durations[params.get('window') ?? ''];
    params.delete('window');
    if (duration) params.set('from', String(Date.now() - duration));
    if (!params.has('page')) params.set('page', '1');
    const requestedPageSize = Number(params.get('pageSize'));
    if (!ISSUE_PAGE_SIZES.includes(requestedPageSize as (typeof ISSUE_PAGE_SIZES)[number])) {
      params.set('pageSize', '10');
    }
    return params;
  }, [searchParams]);
  const issues = useQuery({
    // queryKey 包含项目和完整查询串，任一筛选变化都会对应独立缓存。
    queryKey: ['issues', projectId, requestParams.toString()],
    queryFn: () => api.issues(projectId, requestParams),
  });
  const overview = useQuery({
    queryKey: ['overview', projectId],
    queryFn: () => api.overview(projectId),
  });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const releases = useQuery({
    queryKey: ['releases', projectId],
    queryFn: () => api.releases(projectId),
  });
  const project = projects.data?.items.find((item) => item.id === projectId);

  useEffect(() => {
    // 浏览器前进/后退或全局搜索进入列表时，同步 URL 中已经提交的筛选值。
    setSearch(searchParams.get('search') ?? '');
    setRoute(searchParams.get('route') ?? '');
  }, [searchParams]);

  // ECharts option 只在服务端趋势数据变化时重建，避免 Chart effect 反复 dispose/init。
  const trendOption = useMemo<ChartOption>(
    () => ({
      animationDuration: 450,
      grid: { left: 0, right: 8, top: 16, bottom: 0, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#18242c',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data:
          overview.data?.trend.map((item) =>
            new Date(item.timestamp).getHours().toString().padStart(2, '0'),
          ) ?? [],
        axisLine: { lineStyle: { color: '#cbd1d1' } },
        axisLabel: { color: '#7a858b', fontSize: 10 },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#e2e5e5' } },
        axisLabel: { color: '#7a858b', fontSize: 10 },
      },
      series: [
        {
          type: 'line',
          name: 'Error events',
          data: overview.data?.trend.map((item) => item.errors) ?? [],
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: '#e75f2b', width: 2 },
          areaStyle: { color: 'rgba(231,95,43,.09)' },
        },
      ],
    }),
    [overview.data],
  );

  function updateFilter(key: string, value: string) {
    // 改变任一筛选都回到第一页，避免新结果总数较少时停在不存在的页码。
    const next = new URLSearchParams(searchParams);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.set('page', '1');
    setSearchParams(next);
  }

  const requestedPageSize = Number(requestParams.get('pageSize') ?? 10);
  // 最终分页优先信任 Server 规范化后的值，首屏未返回前才使用本地安全回退。
  const pageSize =
    issues.data?.pageSize ??
    (Number.isFinite(requestedPageSize) && requestedPageSize >= 1
      ? Math.min(100, Math.floor(requestedPageSize))
      : 10);
  const totalPages = Math.max(1, Math.ceil((issues.data?.total ?? 0) / pageSize));
  const requestedPage = Number(requestParams.get('page') ?? 1);
  const currentPage =
    Number.isFinite(requestedPage) && requestedPage >= 1 ? Math.floor(requestedPage) : 1;
  const total = issues.data?.total ?? 0;
  const firstVisible = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastVisible = Math.min(currentPage * pageSize, total);

  useEffect(() => {
    if (!issues.data || total === 0 || currentPage <= totalPages) return;
    const next = new URLSearchParams(searchParams);
    next.set('page', String(totalPages));
    setSearchParams(next, { replace: true });
  }, [currentPage, issues.data, searchParams, setSearchParams, total, totalPages]);

  return (
    <main className="page-content">
      <PageHeader
        eyebrow={`${project?.name ?? 'Project'} / live triage`}
        title="Issues"
        description="Signals grouped by normalized cause, ordered by the freshest evidence."
        actions={
          <button className="button button-quiet" onClick={() => setCompactRows(!compactRows)}>
            <Rows3 size={15} /> {compactRows ? 'Comfortable rows' : 'Compact rows'}
          </button>
        }
      />

      <section className="overview-strip">
        <div className="summary-metrics">
          <article>
            <small>Unresolved</small>
            <strong>{formatNumber(overview.data?.unresolvedIssues ?? 0)}</strong>
            <span className="metric-signal">Needs review</span>
          </article>
          <article>
            <small>Events / 24 h</small>
            <strong>{formatNumber(overview.data?.events24h ?? 0)}</strong>
            <span>Across all releases</span>
          </article>
          <article>
            <small>Affected users</small>
            <strong>{formatNumber(overview.data?.affectedUsers24h ?? 0)}</strong>
            <span>Distinct identities</span>
          </article>
          <article>
            <small>Tracked releases</small>
            <strong>{formatNumber(overview.data?.releases ?? 0)}</strong>
            <span>Source-map boundary</span>
          </article>
        </div>
        <div className="overview-chart">
          <div className="chart-caption">
            <span>Evidence volume</span>
            <small>hourly · last 24 h</small>
          </div>
          <Chart option={trendOption} height={170} />
        </div>
      </section>

      <section className="issue-panel">
        <div className="filter-bar">
          <form
            className="search-field"
            onSubmit={(event) => {
              event.preventDefault();
              updateFilter('search', search);
            }}
          >
            <Search size={15} />
            <input
              aria-label="Search issue title or fingerprint"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search title or fingerprint"
            />
          </form>
          <select
            aria-label="Issue status"
            value={searchParams.get('status') ?? 'all'}
            onChange={(event) => updateFilter('status', event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="unresolved">Unresolved</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
          </select>
          <select
            aria-label="Severity"
            value={searchParams.get('level') ?? 'all'}
            onChange={(event) => updateFilter('level', event.target.value)}
          >
            <option value="all">All severities</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
          <select
            aria-label="Release"
            value={searchParams.get('release') ?? 'all'}
            onChange={(event) => updateFilter('release', event.target.value)}
          >
            <option value="all">All releases</option>
            {releases.data?.items.map((release) => (
              <option key={release.id} value={release.version}>
                {release.version}
              </option>
            ))}
          </select>
          <select
            aria-label="Browser"
            value={searchParams.get('browser') ?? 'all'}
            onChange={(event) => updateFilter('browser', event.target.value)}
          >
            <option value="all">All browsers</option>
            <option value="Chrome">Chrome</option>
            <option value="Edge">Edge</option>
            <option value="Firefox">Firefox</option>
            <option value="Safari">Safari</option>
          </select>
          <select
            aria-label="Time window"
            value={searchParams.get('window') ?? 'all'}
            onChange={(event) => updateFilter('window', event.target.value)}
          >
            <option value="all">All time</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <form
            className="route-field"
            onSubmit={(event) => {
              event.preventDefault();
              updateFilter('route', route);
            }}
          >
            <Route size={14} />
            <input
              aria-label="Route contains"
              value={route}
              onChange={(event) => setRoute(event.target.value)}
              placeholder="Filter route"
            />
          </form>
          <button
            className="sort-button"
            onClick={() =>
              updateFilter('order', searchParams.get('order') === 'asc' ? 'desc' : 'asc')
            }
          >
            <ArrowDown size={14} /> Last seen
          </button>
        </div>

        {issues.isLoading ? (
          <LoadingState />
        ) : issues.error ? (
          <ErrorState message={issues.error.message} />
        ) : issues.data?.items.length === 0 ? (
          <EmptyState
            title="No issues match this view"
            detail="Try removing a filter or trigger a scenario in the incident lab."
          />
        ) : (
          <div className={`issue-table ${compactRows ? 'is-compact' : ''}`}>
            <div className="issue-table-head">
              <span>Issue</span>
              <span>Status</span>
              <span>Events</span>
              <span>Users</span>
              <span>Trend</span>
              <span>Last seen</span>
            </div>
            {issues.data?.items.map((issue) => (
              <Link
                to={`/projects/${projectId}/issues/${issue.id}`}
                className="issue-row"
                key={issue.id}
              >
                <span className="issue-identity">
                  <LevelMark level={issue.level} />
                  <span>
                    <strong>{issue.title}</strong>
                    <small>
                      <code>{issue.fingerprint.slice(0, 8)}</code>
                      <i />
                      {issue.latestRelease ?? 'Unknown release'}
                    </small>
                  </span>
                </span>
                <IssueStatusBadge status={issue.status} />
                <span className="numeric-cell">{formatNumber(issue.eventCount)}</span>
                <span className="numeric-cell">{formatNumber(issue.userCount)}</span>
                <Sparkline values={issue.trend ?? []} />
                <span className="last-seen">{relativeTime(issue.lastSeenAt)}</span>
              </Link>
            ))}
          </div>
        )}

        <footer className="pagination">
          <p className="pagination-summary" aria-live="polite">
            Showing <strong>{firstVisible}</strong>–<strong>{lastVisible}</strong> of{' '}
            <strong>{total}</strong> grouped issues
          </p>
          <div className="pagination-controls">
            <label className="page-size-control">
              <span>Rows per page</span>
              <select
                aria-label="Issues per page"
                value={String(pageSize)}
                onChange={(event) => updateFilter('pageSize', event.target.value)}
              >
                {ISSUE_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label="Previous page"
              disabled={currentPage <= 1}
              onClick={() => updateFilter('page', String(currentPage - 1))}
            >
              <ChevronLeft size={15} /> <span>Previous</span>
            </button>
            <span className="pagination-page" aria-current="page">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={currentPage >= totalPages}
              onClick={() => updateFilter('page', String(currentPage + 1))}
            >
              <span>Next</span> <ChevronRight size={15} />
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}

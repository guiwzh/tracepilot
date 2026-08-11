import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ChevronLeft, ChevronRight, Rows3, Search } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Chart, type ChartOption } from '../components/Chart';
import { PageHeader } from '../components/PageHeader';
import { Sparkline } from '../components/Sparkline';
import { ErrorState, EmptyState, LoadingState } from '../components/States';
import { IssueStatusBadge, LevelMark } from '../components/Status';
import { api } from '../services/api';
import { usePreferences } from '../stores/preferences';
import { formatNumber, relativeTime } from '../utils/format';

export function IssuesPage() {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const compactRows = usePreferences((state) => state.compactRows);
  const setCompactRows = usePreferences((state) => state.setCompactRows);
  const requestParams = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    if (!params.has('page')) params.set('page', '1');
    if (!params.has('pageSize')) params.set('pageSize', '25');
    return params;
  }, [searchParams]);
  const issues = useQuery({
    queryKey: ['issues', projectId, requestParams.toString()],
    queryFn: () => api.issues(projectId, requestParams),
  });
  const overview = useQuery({
    queryKey: ['overview', projectId],
    queryFn: () => api.overview(projectId),
  });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const project = projects.data?.items.find((item) => item.id === projectId);

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
    const next = new URLSearchParams(searchParams);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    next.set('page', '1');
    setSearchParams(next);
  }

  const totalPages = Math.max(
    1,
    Math.ceil((issues.data?.total ?? 0) / Number(requestParams.get('pageSize') ?? 25)),
  );
  const currentPage = Number(requestParams.get('page') ?? 1);

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
          <span>{issues.data?.total ?? 0} grouped issues</span>
          <div>
            <button
              disabled={currentPage <= 1}
              onClick={() => updateFilter('page', String(currentPage - 1))}
            >
              <ChevronLeft size={15} />
            </button>
            <span>
              {currentPage} / {totalPages}
            </span>
            <button
              disabled={currentPage >= totalPages}
              onClick={() => updateFilter('page', String(currentPage + 1))}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}

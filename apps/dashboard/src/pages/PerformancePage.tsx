import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gauge, Info, Split } from 'lucide-react';
import { useParams } from 'react-router-dom';
import type { PerformanceComparison, PerformanceMetric } from '@trace-pilot/shared';
import { Chart, type ChartOption } from '../components/Chart';
import { PageHeader } from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components/States';
import { api } from '../services/api';
import { metricValue } from '../utils/format';

const descriptions: Record<string, string> = {
  LCP: 'Visual load',
  INP: 'Interaction response',
  CLS: 'Layout stability',
  FCP: 'First content',
  TTFB: 'Server response',
};

type MetricName = PerformanceMetric['metric'];
const metricNames: MetricName[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];

function ComparisonPanel({
  title,
  items,
  metric,
}: {
  title: string;
  items?: PerformanceComparison[];
  metric: MetricName;
}) {
  const visible = items?.filter((item) => item.metric === metric) ?? [];
  return (
    <section className="panel comparison-panel">
      <header className="panel-title">
        <div>
          <Split size={14} />
          <h2>{title}</h2>
        </div>
        <small>{metric} p75</small>
      </header>
      {visible.length === 0 ? (
        <p className="inline-empty">No matching samples.</p>
      ) : (
        <div className="comparison-list">
          {visible.map((item) => (
            <article key={`${item.metric}-${item.name}`}>
              <span title={item.name}>{item.name}</span>
              <strong>{metricValue(item.metric, item.p75)}</strong>
              <small>{item.samples} samples</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function PerformancePage() {
  const { projectId = '' } = useParams();
  const [selectedMetric, setSelectedMetric] = useState<MetricName>('LCP');
  const metrics = useQuery({
    queryKey: ['performance', projectId],
    queryFn: () => api.performance(projectId),
  });
  const option = useMemo<ChartOption>(
    () => ({
      grid: { left: 0, right: 10, top: 20, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#18242c',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: metrics.data?.items.map((item) => item.metric) ?? [],
        axisLine: { lineStyle: { color: '#cbd1d1' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#e2e5e5' } },
        axisLabel: { color: '#7a858b' },
      },
      series: [
        {
          name: 'p50',
          type: 'bar',
          data: metrics.data?.items.map((item) => item.p50) ?? [],
          itemStyle: { color: '#9ba8aa' },
          barGap: 0,
        },
        {
          name: 'p75',
          type: 'bar',
          data: metrics.data?.items.map((item) => item.p75) ?? [],
          itemStyle: { color: '#486d7a' },
        },
        {
          name: 'p95',
          type: 'bar',
          data: metrics.data?.items.map((item) => item.p95) ?? [],
          itemStyle: { color: '#e75f2b' },
        },
      ],
    }),
    [metrics.data],
  );
  const trendOption = useMemo<ChartOption>(() => {
    const points = metrics.data?.trend.filter((item) => item.metric === selectedMetric) ?? [];
    return {
      grid: { left: 0, right: 14, top: 24, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#18242c',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
        valueFormatter: (value: unknown) => metricValue(selectedMetric, Number(value)),
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map((item) =>
          new Date(item.timestamp).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          }),
        ),
        axisLine: { lineStyle: { color: '#cbd1d1' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#e2e5e5' } },
        axisLabel: { color: '#7a858b' },
      },
      series: [
        {
          name: `${selectedMetric} p75`,
          type: 'line',
          data: points.map((item) => (item.samples > 0 ? item.p75 : null)),
          showSymbol: true,
          connectNulls: false,
          lineStyle: { color: '#e75f2b', width: 2 },
          itemStyle: { color: '#e75f2b' },
          areaStyle: { color: 'rgba(231,95,43,.08)' },
        },
      ],
    };
  }, [metrics.data, selectedMetric]);

  return (
    <main className="page-content">
      <PageHeader
        eyebrow="Experience / 7 day window"
        title="Performance"
        description="Core browser metrics summarized from captured field samples."
        actions={
          <label className="metric-picker">
            <span>Compare metric</span>
            <select
              value={selectedMetric}
              onChange={(event) => setSelectedMetric(event.target.value as MetricName)}
            >
              {metricNames.map((metric) => (
                <option key={metric}>{metric}</option>
              ))}
            </select>
          </label>
        }
      />
      {metrics.isLoading ? (
        <LoadingState />
      ) : metrics.error ? (
        <ErrorState message={metrics.error.message} />
      ) : (
        <>
          <section className="vital-grid">
            {metrics.data?.items.map((item) => (
              <article key={item.metric} className={`vital-card rating-${item.rating}`}>
                <header>
                  <span>
                    <Gauge size={15} /> {item.metric}
                  </span>
                  <i>{item.rating.replace('-', ' ')}</i>
                </header>
                <strong>{metricValue(item.metric, item.p75)}</strong>
                <p>
                  {descriptions[item.metric]} · p75 from {item.samples} samples
                </p>
                <dl>
                  <div>
                    <dt>p50</dt>
                    <dd>{metricValue(item.metric, item.p50)}</dd>
                  </div>
                  <div>
                    <dt>p95</dt>
                    <dd>{metricValue(item.metric, item.p95)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </section>
          <section className="panel performance-chart">
            <header className="panel-title">
              <div>
                <h2>Percentile comparison</h2>
              </div>
              <small>CLS uses a unitless score</small>
            </header>
            <Chart option={option} height={340} />
            <p className="chart-footnote">
              <Info size={13} /> Zero values indicate that no matching browser samples have arrived
              yet.
            </p>
          </section>
          <div className="performance-breakdown-grid">
            <ComparisonPanel
              title="By release"
              items={metrics.data?.byRelease}
              metric={selectedMetric}
            />
            <ComparisonPanel
              title="By route"
              items={metrics.data?.byRoute}
              metric={selectedMetric}
            />
            <ComparisonPanel
              title="By browser"
              items={metrics.data?.byBrowser}
              metric={selectedMetric}
            />
          </div>
          <section className="panel performance-chart trend-chart">
            <header className="panel-title">
              <div>
                <h2>{selectedMetric} p75 trend</h2>
              </div>
              <small>Daily · last 7 days</small>
            </header>
            <Chart option={trendOption} height={280} />
          </section>
        </>
      )}
    </main>
  );
}

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gauge, Info } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Chart, type ChartOption } from '../components/Chart';
import { PageHeader } from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components/States';
import { api } from '../services/api';
import { metricValue } from '../utils/format';

const descriptions: Record<string, string> = { LCP: 'Visual load', INP: 'Interaction response', CLS: 'Layout stability', FCP: 'First content', TTFB: 'Server response' };

export function PerformancePage() {
  const { projectId = '' } = useParams();
  const metrics = useQuery({ queryKey: ['performance', projectId], queryFn: () => api.performance(projectId) });
  const option = useMemo<ChartOption>(() => ({
    grid: { left: 0, right: 10, top: 20, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', backgroundColor: '#18242c', borderWidth: 0, textStyle: { color: '#fff', fontSize: 11 } },
    xAxis: { type: 'category', data: metrics.data?.items.map((item) => item.metric) ?? [], axisLine: { lineStyle: { color: '#cbd1d1' } }, axisTick: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#e2e5e5' } }, axisLabel: { color: '#7a858b' } },
    series: [
      { name: 'p50', type: 'bar', data: metrics.data?.items.map((item) => item.p50) ?? [], itemStyle: { color: '#9ba8aa' }, barGap: 0 },
      { name: 'p75', type: 'bar', data: metrics.data?.items.map((item) => item.p75) ?? [], itemStyle: { color: '#486d7a' } },
      { name: 'p95', type: 'bar', data: metrics.data?.items.map((item) => item.p95) ?? [], itemStyle: { color: '#e75f2b' } },
    ],
  }), [metrics.data]);

  return <main className="page-content"><PageHeader eyebrow="Experience / 7 day window" title="Performance" description="Core browser metrics summarized from captured field samples." />{metrics.isLoading ? <LoadingState /> : metrics.error ? <ErrorState message={metrics.error.message} /> : <>
    <section className="vital-grid">{metrics.data?.items.map((item) => <article key={item.metric} className={`vital-card rating-${item.rating}`}><header><span><Gauge size={15} /> {item.metric}</span><i>{item.rating.replace('-', ' ')}</i></header><strong>{metricValue(item.metric, item.p75)}</strong><p>{descriptions[item.metric]} · p75 from {item.samples} samples</p><dl><div><dt>p50</dt><dd>{metricValue(item.metric, item.p50)}</dd></div><div><dt>p95</dt><dd>{metricValue(item.metric, item.p95)}</dd></div></dl></article>)}</section>
    <section className="panel performance-chart"><header className="panel-title"><div><h2>Percentile comparison</h2></div><small>CLS uses a unitless score</small></header><Chart option={option} height={340} /><p className="chart-footnote"><Info size={13} /> Zero values indicate that no matching browser samples have arrived yet.</p></section>
  </>}</main>;
}

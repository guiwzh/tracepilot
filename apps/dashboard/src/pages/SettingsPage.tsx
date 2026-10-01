import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Filter, Gauge, ShieldCheck } from 'lucide-react';
import { useParams } from 'react-router-dom';
import type { IngestStats, ProjectSettings, ProjectSettingsResponse } from '@trace-pilot/shared';
import { PageHeader } from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components/States';
import { api } from '../services/api';
import { formatNumber } from '../utils/format';

const FILTER_LABELS: Record<string, string> = {
  'browser-extension': 'Browser extensions',
  'web-crawler': 'Web crawlers',
  localhost: 'Localhost',
  'error-message': 'Error messages',
  release: 'Releases',
  'project-rate-limit': 'Rate limit',
  'spike-protection': 'Spike protection',
};

/** 文本框里一行一条规则；空行和首尾空白去掉，和服务端的校验一致。 */
function linesOf(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function sum(values: Partial<Record<string, number>>): number {
  return Object.values(values).reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** 最近 24 小时的上报去向：收下多少、被过滤多少、被限流多少，以及每小时的分布。 */
function IngestHealth({ stats }: { stats: IngestStats }) {
  const filtered = sum(stats.filtered);
  const rateLimited = sum(stats.rateLimited);
  const peak = Math.max(1, ...stats.hourly.map((h) => h.accepted + h.filtered + h.rateLimited));
  const reasons = [...Object.entries(stats.filtered), ...Object.entries(stats.rateLimited)].filter(
    ([, count]) => (count ?? 0) > 0,
  );
  return (
    <section className="panel ingest-health" aria-label="Ingest outcomes">
      <div className="panel-title">
        <div>
          <span className="signal-tick" />
          <h2>Where reports went</h2>
        </div>
        <small>Last {stats.windowHours} hours</small>
      </div>
      <div className="ingest-health-body">
        <div className="summary-metrics">
          <article>
            <small>Accepted</small>
            <strong>{formatNumber(stats.accepted)}</strong>
            <span>New events written</span>
          </article>
          <article>
            <small>Filtered</small>
            <strong>{formatNumber(filtered)}</strong>
            <span>Dropped by inbound filters</span>
          </article>
          <article>
            <small>Rate limited</small>
            <strong className={rateLimited > 0 ? 'metric-signal' : undefined}>
              {formatNumber(rateLimited)}
            </strong>
            <span>Answered 429; the SDK retries later</span>
          </article>
          <article>
            <small>Dropped by reason</small>
            {reasons.length === 0 ? (
              <span className="ingest-reasons-empty">Nothing dropped</span>
            ) : (
              <ul className="ingest-reasons">
                {reasons.map(([reason, count]) => (
                  <li key={reason}>
                    <span>{FILTER_LABELS[reason] ?? reason}</span>
                    <b>{formatNumber(count ?? 0)}</b>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
        <div className="ingest-chart">
          <div
            className="ingest-bars"
            role="img"
            aria-label={`Hourly reports: ${stats.hourly
              .map((h) => `${h.accepted} accepted, ${h.filtered + h.rateLimited} dropped`)
              .join('; ')}`}
          >
            {stats.hourly.map((hour) => (
              <span key={hour.hour} title={new Date(hour.hour).toLocaleString()}>
                <i
                  className="ingest-bar-dropped"
                  style={{ height: `${((hour.filtered + hour.rateLimited) / peak) * 100}%` }}
                />
                <i
                  className="ingest-bar-accepted"
                  style={{ height: `${(hour.accepted / peak) * 100}%` }}
                />
              </span>
            ))}
          </div>
          <div className="ingest-legend">
            <span>
              <i className="ingest-bar-accepted" /> Accepted
            </span>
            <span>
              <i className="ingest-bar-dropped" /> Filtered or rate limited
            </span>
            <small>{stats.windowHours}h ago → now</small>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * 设置表单。草稿只在本地，保存时整份 PUT；服务端返回的就是生效的设置，写回缓存。
 * 父组件用设置内容做 key：服务端的设置变了（保存成功、别处修改后重新拉取），表单按新值重新初始化，
 * 不必在 effect 里同步状态。也因为会重新挂载，「已保存」的提示不能放在这里的 mutation 状态上，
 * 由父组件记住刚保存的是哪一份（saved）。
 */
function SettingsForm({
  projectId,
  data,
  saved,
  onSaved,
}: {
  projectId: string;
  data: ProjectSettingsResponse;
  /** 当前显示的这份设置是不是刚刚在这里保存的。 */
  saved: boolean;
  onSaved: (settings: ProjectSettings) => void;
}) {
  const queryClient = useQueryClient();
  const initial = data.settings;
  const [filters, setFilters] = useState(initial.inboundFilters);
  const [messages, setMessages] = useState(initial.inboundFilters.errorMessages.join('\n'));
  const [releases, setReleases] = useState(initial.inboundFilters.releases.join('\n'));
  const [limit, setLimit] = useState(initial.rateLimit.eventsPerMinute?.toString() ?? '');
  const [spikeProtection, setSpikeProtection] = useState(initial.rateLimit.spikeProtection);

  const draft: ProjectSettings = {
    inboundFilters: { ...filters, errorMessages: linesOf(messages), releases: linesOf(releases) },
    rateLimit: { eventsPerMinute: limit.trim() ? Number(limit) : null, spikeProtection },
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const limitInvalid =
    draft.rateLimit.eventsPerMinute !== null &&
    (!Number.isInteger(draft.rateLimit.eventsPerMinute) || draft.rateLimit.eventsPerMinute < 100);

  const save = useMutation({
    mutationFn: () => api.saveSettings(projectId, draft),
    onSuccess: (response) => {
      onSaved(response.settings);
      queryClient.setQueryData(['settings', projectId], response);
    },
  });
  const { eventsPerMinute: serverLimit, spikeProtection: serverSpike } = data.serverDefaults;

  const toggle = (
    key: 'browserExtensions' | 'webCrawlers' | 'localhost',
    label: string,
    hint: string,
  ) => (
    <label className="toggle-row">
      <input
        type="checkbox"
        checked={filters[key]}
        onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.checked }))}
      />
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </label>
  );

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !limitInvalid) save.mutate();
      }}
    >
      <section className="panel">
        <div className="panel-title">
          <div>
            <Filter size={14} />
            <h2>Inbound filters</h2>
          </div>
          <small>Applied before rate limits</small>
        </div>
        <div className="settings-body">
          {toggle(
            'browserExtensions',
            'Browser extensions',
            'Errors whose top frame is extension code.',
          )}
          {toggle('webCrawlers', 'Web crawlers', 'Search bots, link previews and uptime probes.')}
          {toggle('localhost', 'Localhost', 'Reports from pages served on localhost or 127.0.0.1.')}
          <label className="pattern-field">
            <span>Error messages</span>
            <textarea
              value={messages}
              onChange={(event) => setMessages(event.target.value)}
              placeholder={'ResizeObserver loop*\nChunkLoadError: *'}
              rows={3}
            />
            <small>One pattern per line. * matches anything; case is ignored.</small>
          </label>
          <label className="pattern-field">
            <span>Releases</span>
            <textarea
              value={releases}
              onChange={(event) => setReleases(event.target.value)}
              placeholder={'1.*\n2.0.0-beta*'}
              rows={2}
            />
            <small>Drop every report from releases you no longer support.</small>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <Gauge size={14} />
            <h2>Rate limit</h2>
          </div>
          <small>Over the limit → 429 + Retry-After</small>
        </div>
        <div className="settings-body">
          <label className="pattern-field">
            <span>Events per minute</span>
            <input
              inputMode="numeric"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              placeholder={
                serverLimit > 0
                  ? `Server default: ${serverLimit.toLocaleString()}`
                  : 'Server default: unlimited'
              }
              aria-invalid={limitInvalid}
            />
            <small>
              {limitInvalid
                ? 'Use a whole number of at least 100, or leave empty for the server default.'
                : 'Leave empty to follow the server default.'}
            </small>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={spikeProtection}
              disabled={!serverSpike}
              onChange={(event) => setSpikeProtection(event.target.checked)}
            />
            <span>
              <strong>
                <ShieldCheck size={13} /> Spike protection
              </strong>
              <small>
                {serverSpike
                  ? 'Rejects a minute that runs far above the last hour’s normal volume.'
                  : 'Disabled on this server (SPIKE_PROTECTION=false).'}
              </small>
            </span>
          </label>
        </div>
      </section>

      <div className="settings-actions">
        <button
          className="button button-primary"
          disabled={!dirty || limitInvalid || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save settings'}
        </button>
        <span role="status">
          {save.error ? (
            <span className="form-error">{save.error.message}</span>
          ) : dirty ? (
            'Unsaved changes'
          ) : saved ? (
            'Saved. The next envelope uses these settings.'
          ) : null}
        </span>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { projectId = '' } = useParams();
  const settings = useQuery({
    queryKey: ['settings', projectId],
    queryFn: () => api.settings(projectId),
  });
  const [savedSettings, setSavedSettings] = useState<string | null>(null);
  const stats = useQuery({
    queryKey: ['ingest-stats', projectId],
    queryFn: () => api.ingestStats(projectId),
    refetchInterval: 30_000,
  });
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="Ingest / protection"
        title="Settings"
        description="Decide which reports never become issues, and how much one project may send before the server pushes back."
      />
      {stats.data && <IngestHealth stats={stats.data} />}
      {settings.isLoading ? (
        <LoadingState />
      ) : settings.error ? (
        <ErrorState message={settings.error.message} />
      ) : settings.data ? (
        <SettingsForm
          key={JSON.stringify(settings.data.settings)}
          projectId={projectId}
          data={settings.data}
          saved={savedSettings === JSON.stringify(settings.data.settings)}
          onSaved={(value) => setSavedSettings(JSON.stringify(value))}
        />
      ) : null}
    </main>
  );
}

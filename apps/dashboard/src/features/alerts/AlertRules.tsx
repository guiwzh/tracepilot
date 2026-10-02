import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Send, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  AlertChannel,
  AlertDelivery,
  AlertRule,
  AlertTestResult,
  AlertTrigger,
  IssueLevel,
} from '@trace-pilot/shared';
import { api } from '../../services/api';
import { relativeTime } from '../../utils/format';

const TRIGGERS: Array<{ value: AlertTrigger; label: string; hint: string }> = [
  { value: 'new_issue', label: 'New issue', hint: 'The first event of a problem nobody has seen.' },
  { value: 'regression', label: 'Regression', hint: 'An issue comes back after being resolved.' },
  {
    value: 'escalating',
    label: 'Escalating',
    hint: 'The last hour runs 5× above the issue’s usual volume.',
  },
];
const TRIGGER_NAMES: Record<AlertDelivery['trigger'], string> = {
  new_issue: 'New issue',
  regression: 'Regression',
  escalating: 'Escalating',
  test: 'Test',
  investigation: 'Investigation',
};

/** 规则要求自动调查却没有发起的原因。 */
const INVESTIGATION_NOTES: Record<string, string> = {
  cooldown: 'not investigated: already investigated in the last 24 h',
  daily_limit: 'not investigated: daily limit reached',
  busy: 'not investigated: too many investigations running',
  disabled: 'not investigated: automatic investigations are off on this server',
};

const CHANNELS: Record<AlertChannel['type'], { label: string; placeholder: string }> = {
  webhook: { label: 'Webhook', placeholder: 'https://example.com/hooks/tracepilot' },
  slack: { label: 'Slack', placeholder: 'https://hooks.slack.com/services/…' },
  feishu: { label: 'Feishu', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
  dingtalk: {
    label: 'DingTalk',
    placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…',
  },
};

/** 被抑制的通知为什么没有发出，说成人话。 */
const REASONS: Record<string, string> = {
  muted: 'rule muted',
  interval: 'already alerted for this issue',
  rate_limited: 'hourly cap reached',
  disabled: 'rule disabled',
};

function NewRuleForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [triggers, setTriggers] = useState<AlertTrigger[]>(['new_issue', 'regression']);
  const [minLevel, setMinLevel] = useState<IssueLevel>('error');
  const [type, setType] = useState<AlertChannel['type']>('webhook');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [autoInvestigate, setAutoInvestigate] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.createAlertRule(projectId, {
        name: name.trim(),
        triggers,
        minLevel,
        intervalMinutes: Number(intervalMinutes),
        autoInvestigate,
        channel:
          type === 'slack'
            ? { type, url: url.trim() }
            : { type, url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) },
      }),
    onSuccess: () => {
      setName('');
      setUrl('');
      setSecret('');
      onCreated();
    },
  });
  const intervalValid =
    /^\d+$/.test(intervalMinutes) &&
    Number(intervalMinutes) >= 1 &&
    Number(intervalMinutes) <= 10_080;
  const ready = name.trim() && url.trim() && triggers.length > 0 && intervalValid;

  return (
    <form
      className="alert-rule-form"
      aria-label="New alert rule"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) create.mutate();
      }}
    >
      <label className="pattern-field">
        <span>Rule name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Checkout on-call"
          maxLength={80}
        />
      </label>
      <fieldset className="alert-triggers">
        <legend>Notify when</legend>
        {TRIGGERS.map((trigger) => (
          <label key={trigger.value} className="toggle-row">
            <input
              type="checkbox"
              checked={triggers.includes(trigger.value)}
              onChange={(event) =>
                setTriggers((current) =>
                  event.target.checked
                    ? [...current, trigger.value]
                    : current.filter((item) => item !== trigger.value),
                )
              }
            />
            <span>
              <strong>{trigger.label}</strong>
              <small>{trigger.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="alert-rule-grid">
        <label className="pattern-field">
          <span>Minimum level</span>
          <select
            value={minLevel}
            onChange={(event) => setMinLevel(event.target.value as IssueLevel)}
          >
            <option value="error">Error</option>
            <option value="warning">Warning and above</option>
            <option value="info">Everything</option>
          </select>
        </label>
        <label className="pattern-field">
          <span>At most once per issue every (minutes)</span>
          <input
            inputMode="numeric"
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(event.target.value)}
            aria-invalid={!intervalValid}
          />
        </label>
        <label className="pattern-field">
          <span>Channel</span>
          <select
            value={type}
            onChange={(event) => setType(event.target.value as AlertChannel['type'])}
          >
            {Object.entries(CHANNELS).map(([value, channel]) => (
              <option key={value} value={value}>
                {channel.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="pattern-field">
        <span>{type === 'webhook' ? 'Webhook URL' : 'Bot webhook URL'}</span>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={CHANNELS[type].placeholder}
          autoComplete="off"
        />
      </label>
      {type !== 'slack' && (
        <label className="pattern-field">
          <span>Signing secret (optional)</span>
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              type === 'webhook'
                ? 'Signs each request with HMAC-SHA256'
                : 'From the bot’s security settings'
            }
            autoComplete="new-password"
          />
        </label>
      )}
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={autoInvestigate}
          onChange={(event) => setAutoInvestigate(event.target.checked)}
        />
        <span>
          <strong>Start an investigation</strong>
          <small>
            When an alert goes out, the read-only agent investigates and a follow-up with its cited
            findings goes to the same channel. Limited per day; each issue at most once in 24 h.
          </small>
        </span>
      </label>
      <div className="alert-rule-actions">
        <button className="button button-primary" disabled={!ready || create.isPending}>
          Create rule
        </button>
        <small>The URL and secret are stored on this server and never shown again.</small>
      </div>
      {create.error && <p className="form-error">{create.error.message}</p>}
    </form>
  );
}

/** 静默是否还没过期。规则列表每次重新拉取时重新判断，过期的静默自然显示为未静默。 */
function isMuted(rule: AlertRule): boolean {
  return rule.mutedUntil !== null && rule.mutedUntil > Date.now();
}

function RuleRow({ rule, onChange }: { rule: AlertRule; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [test, setTest] = useState<AlertTestResult | null>(null);
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateAlertRule>[1]) =>
      api.updateAlertRule(rule.id, patch),
    onSuccess: onChange,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAlertRule(rule.id),
    onSuccess: onChange,
  });
  const send = useMutation({
    mutationFn: () => api.testAlertRule(rule.id),
    onSuccess: (result) => {
      setTest(result);
      onChange();
    },
  });
  const muted = isMuted(rule);

  return (
    <li className={rule.enabled ? '' : 'is-disabled'}>
      <div className="alert-rule-summary">
        <label className="alert-rule-switch">
          <input
            type="checkbox"
            checked={rule.enabled}
            aria-label={`Enable ${rule.name}`}
            onChange={(event) => update.mutate({ enabled: event.target.checked })}
          />
          <strong>{rule.name}</strong>
        </label>
        <small>
          {CHANNELS[rule.channel.type].label} · <code>{rule.channel.target}</code>
          {rule.channel.signed ? ' · signed' : ''}
        </small>
        <small>
          {rule.triggers.map((trigger) => TRIGGER_NAMES[trigger]).join(', ')} · {rule.minLevel}
          {rule.minLevel === 'error' ? '' : ' and above'} · once per issue every{' '}
          {rule.intervalMinutes} min
          {rule.autoInvestigate ? ' · starts an investigation' : ''}
          {muted ? ` · muted until ${new Date(rule.mutedUntil!).toLocaleTimeString()}` : ''}
        </small>
        {test && (
          <small className={test.ok ? 'alert-test-ok' : 'alert-test-failed'} role="status">
            {test.ok ? 'Test delivered.' : `Test failed: ${test.error ?? 'no response'}`}
          </small>
        )}
      </div>
      <div className="alert-rule-buttons">
        <button
          type="button"
          className="button button-quiet"
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          <Send size={12} /> Test
        </button>
        <button
          type="button"
          className="button button-quiet"
          aria-pressed={rule.autoInvestigate}
          onClick={() => update.mutate({ autoInvestigate: !rule.autoInvestigate })}
        >
          <Sparkles size={12} /> {rule.autoInvestigate ? 'Investigating' : 'Investigate'}
        </button>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => update.mutate({ mutedUntil: muted ? null : Date.now() + 60 * 60_000 })}
        >
          {muted ? <Bell size={12} /> : <BellOff size={12} />} {muted ? 'Unmute' : 'Mute 1 h'}
        </button>
        {confirming ? (
          <button
            type="button"
            className="button button-signal"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Confirm delete
          </button>
        ) : (
          <button type="button" className="button button-quiet" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
      {(update.error ?? remove.error ?? send.error) && (
        <p className="form-error">{(update.error ?? remove.error ?? send.error)!.message}</p>
      )}
    </li>
  );
}

/**
 * 项目设置页的「告警」：规则（什么时候通知、通知到哪）和最近的通知记录。
 * 通知记录里也列出被静默、去重而没有发出的，答得上「为什么没收到」。
 */
export function AlertRules({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ['alert-rules', projectId],
    queryFn: () => api.alertRules(projectId),
  });
  const deliveries = useQuery({
    queryKey: ['alert-deliveries', projectId],
    queryFn: () => api.alertDeliveries(projectId),
    refetchInterval: 15_000,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['alert-rules', projectId] });
    await queryClient.invalidateQueries({ queryKey: ['alert-deliveries', projectId] });
  };

  return (
    <section className="panel alert-rules" aria-label="Alerts">
      <div className="panel-title">
        <div>
          <Bell size={14} />
          <h2>Alerts</h2>
        </div>
        <small>New · regression · escalating</small>
      </div>
      <div className="settings-body">
        <p className="settings-note">
          Notify a channel when an issue first appears, comes back after being resolved, or runs far
          above its own usual volume. Each rule alerts about an issue at most once per interval.
        </p>
        {rules.data?.items.length ? (
          <ul className="token-list alert-rule-list">
            {rules.data.items.map((rule) => (
              <RuleRow key={rule.id} rule={rule} onChange={() => void refresh()} />
            ))}
          </ul>
        ) : rules.isSuccess ? (
          <p className="settings-note">No alert rules yet.</p>
        ) : null}
        <NewRuleForm projectId={projectId} onCreated={() => void refresh()} />
        {deliveries.data?.items.length ? (
          <div className="alert-deliveries">
            <h3>Recent notifications</h3>
            <ul>
              {deliveries.data.items.map((delivery) => (
                <li key={delivery.id}>
                  <span className={`delivery-status delivery-${delivery.status}`}>
                    {delivery.status}
                  </span>
                  <span className="delivery-what">
                    <strong>{TRIGGER_NAMES[delivery.trigger]}</strong>
                    {delivery.issueId ? (
                      <Link to={`/projects/${projectId}/issues/${delivery.issueId}`}>
                        {delivery.issueTitle}
                      </Link>
                    ) : (
                      <span>{delivery.issueTitle}</span>
                    )}
                  </span>
                  <small>
                    {delivery.ruleName} · {relativeTime(delivery.createdAt)}
                    {delivery.reason ? ` · ${REASONS[delivery.reason] ?? delivery.reason}` : ''}
                    {delivery.status === 'pending' && delivery.attempts > 0
                      ? ` · retrying (attempt ${delivery.attempts + 1})`
                      : ''}
                    {delivery.investigationNote
                      ? ` · ${INVESTIGATION_NOTES[delivery.investigationNote] ?? delivery.investigationNote}`
                      : ''}
                    {delivery.investigationId && delivery.issueId ? (
                      <>
                        {' · '}
                        <Link
                          to={`/projects/${projectId}/issues/${delivery.issueId}?tab=investigation`}
                        >
                          {delivery.trigger === 'investigation'
                            ? 'report'
                            : 'investigation started'}
                        </Link>
                      </>
                    ) : null}
                  </small>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DeliveryStats } from '@trace-pilot/monitor-sdk';
import { CrashWidget } from './CrashWidget';
import { activitySnapshot, labTarget, monitor, record, subscribeActivity } from './lab';
import { scenarios, type Lab, type Scenario } from './scenarios';

function timeLabel(value: number): string {
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

/** 投递失败的原因与下一次自动重试的时间。 */
function failureText(stats: DeliveryStats): string {
  const status = stats.lastFailure?.status;
  const reason =
    status === null || status === undefined ? 'server unreachable' : `server answered ${status}`;
  if (!stats.nextAttemptAt) return reason;
  return `${reason}; next automatic retry in ${Math.max(1, Math.ceil((stats.nextAttemptAt - Date.now()) / 1000))} s`;
}

export function App() {
  const activity = useSyncExternalStore(subscribeActivity, activitySnapshot);
  const [stats, setStats] = useState(() => monitor.stats());
  const [crashes, setCrashes] = useState(0);

  useEffect(() => {
    // 投递状况没有事件可订阅，每秒读一次：服务端不可达时，页头如实显示积压和重试时间。
    const timer = window.setInterval(() => setStats(monitor.stats()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const lab: Lab = { monitor, crashWidget: () => setCrashes((count) => count + 1) };

  function runScenario(scenario: Scenario) {
    record('action', `Triggered ${scenario.number} · ${scenario.title}`);
    // 同步调用：场景 01 要在点击处理函数里直接抛错。异步场景自身的失败（比如请求被取消）
    // SDK 已经记录过了，这里接住它，免得再多出一条未处理的 rejection。
    const result = scenario.run(lab);
    if (result instanceof Promise) result.catch(() => {});
  }

  async function flush() {
    const result = await monitor.flush();
    setStats(result);
    if (result.pending === 0) {
      record('delivery', 'Flush: queue empty', `${result.delivered} events delivered so far`);
    } else {
      record('problem', `Flush: ${result.pending} still pending`, failureText(result));
    }
  }

  const failing = stats.pending > 0 && stats.lastFailure !== null;

  return (
    <main>
      <header className="lab-header">
        <a className="wordmark" href="/" aria-label="TracePilot incident lab home">
          <span className="mark">TP</span>
          <span>TracePilot / incident lab</span>
        </a>
        <div className="connection" data-state={failing ? 'failing' : 'armed'} role="status">
          <span />
          {failing ? 'Delivery failing' : 'SDK armed'}
          <small>
            {stats.delivered} delivered · {stats.pending} pending
          </small>
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">
            Controlled environment · {labTarget.projectId} · release {labTarget.release}
          </p>
          <h1>
            Break the checkout.
            <br />
            Keep the evidence.
          </h1>
        </div>
        <div className="intro-note">
          <span className="signal-line" />
          <p>
            Every control below creates a real browser signal. The flight recorder shows what the
            SDK actually captured and whether the server received it.
          </p>
          <button className="flush-button" onClick={() => void flush()}>
            Flush event buffer
          </button>
        </div>
      </section>

      <section className="scenario-grid" aria-label="Failure scenarios">
        {scenarios.map((scenario) => (
          <button
            className="scenario"
            key={scenario.id}
            data-scenario={scenario.id}
            onClick={() => runScenario(scenario)}
          >
            <span className="scenario-number">{scenario.number}</span>
            <span className="scenario-content">
              <strong>{scenario.title}</strong>
              <small>{scenario.description}</small>
            </span>
            <span className="trigger" aria-hidden="true">
              Trigger ↗
            </span>
          </button>
        ))}
      </section>

      <aside className="activity">
        <div>
          <p className="eyebrow">What the SDK did</p>
          <h2>Flight recorder</h2>
          <div className="widget" aria-label="Order summary widget">
            <small>React widget · scenario 08</small>
            <CrashWidget crashes={crashes} />
          </div>
        </div>
        <ol aria-live="polite">
          {activity.length === 0 ? (
            <li className="empty">No signals in this page session yet.</li>
          ) : (
            activity.map((item) => (
              <li key={item.id} data-kind={item.kind}>
                <time>{timeLabel(item.time)}</time>
                <span>
                  {item.label}
                  {item.detail && <small>{item.detail}</small>}
                </span>
              </li>
            ))
          )}
        </ol>
      </aside>
    </main>
  );
}

import { useEffect, useRef, useState } from 'react';
import { createMonitor, type MonitorCore } from '@trace-pilot/monitor-sdk';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4318';

interface Scenario {
  id: string;
  number: string;
  title: string;
  description: string;
  run(monitor: MonitorCore): void | Promise<void>;
}

const scenarios: Scenario[] = [
  {
    id: 'exception',
    number: '01',
    title: 'Runtime exception',
    description: 'Throws outside the React event call stack so window.error observes it.',
    run: () => {
      window.setTimeout(() => {
        throw new TypeError(
          `Cannot read properties of undefined (reading 'total') — order ${Date.now()}`,
        );
      });
    },
  },
  {
    id: 'promise',
    number: '02',
    title: 'Unhandled promise',
    description: 'Rejects a payment promise without a catch handler.',
    run: () => {
      void Promise.reject(new Error(`Payment intent ${crypto.randomUUID()} was not initialized`));
    },
  },
  {
    id: 'resource',
    number: '03',
    title: 'Broken resource',
    description: 'Adds an image whose URL returns no asset.',
    run: () => {
      const image = new Image();
      image.alt = 'Deliberately missing checkout badge';
      image.src = `/missing-checkout-badge-${Date.now()}.png`;
      image.hidden = true;
      document.body.append(image);
      window.setTimeout(() => image.remove(), 2_000);
    },
  },
  {
    id: 'fetch',
    number: '04',
    title: 'Fetch 503',
    description: 'Calls a controlled upstream-failure endpoint.',
    run: async () => {
      await fetch(`${apiUrl}/api/v1/playground/fail?token=demo-secret`);
    },
  },
  {
    id: 'xhr',
    number: '05',
    title: 'XHR 503',
    description: 'Exercises the legacy request instrumentation path.',
    run: () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${apiUrl}/api/v1/playground/fail?source=xhr`);
      xhr.send();
    },
  },
  {
    id: 'route',
    number: '06',
    title: 'SPA route change',
    description: 'Creates a navigation breadcrumb without reloading the page.',
    run: () => {
      history.pushState({}, '', `/checkout/review?session=${Date.now()}`);
    },
  },
  {
    id: 'custom',
    number: '07',
    title: 'Captured warning',
    description: 'Sends an application-owned diagnostic message.',
    run: (monitor) => {
      monitor.captureMessage('Inventory response omitted warehouseId', 'warning');
    },
  },
];

function timeLabel(value: number): string {
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

export function App() {
  const monitorRef = useRef<MonitorCore | null>(null);
  const [activity, setActivity] = useState<Array<{ label: string; time: number }>>([]);
  const [status, setStatus] = useState<'starting' | 'connected'>('starting');

  useEffect(() => {
    const monitor = createMonitor({
      dsn: `${apiUrl}/api/v1/envelopes`,
      dsnKey: import.meta.env.VITE_DEMO_DSN_KEY ?? 'demo-dsn-key',
      projectId: import.meta.env.VITE_DEMO_PROJECT_ID ?? 'demo-project',
      release: '2.4.1',
      environment: 'production',
      user: { id: `lab-user-${Math.floor(Math.random() * 6) + 1}` },
      batchSize: 3,
      flushInterval: 2_000,
      beforeSend(event) {
        return {
          ...event,
          payload: { ...event.payload, labScenario: true, password: '[removed by playground]' },
        };
      },
    });
    monitor.start();
    monitorRef.current = monitor;
    setStatus('connected');
    return () => {
      monitor.destroy();
      monitorRef.current = null;
    };
  }, []);

  async function runScenario(scenario: Scenario) {
    const monitor = monitorRef.current;
    if (!monitor) return;
    setActivity((items) => [{ label: scenario.title, time: Date.now() }, ...items].slice(0, 6));
    await scenario.run(monitor);
  }

  async function flush() {
    await monitorRef.current?.flush();
    setActivity((items) => [{ label: 'Buffer flushed', time: Date.now() }, ...items].slice(0, 6));
  }

  return (
    <main>
      <header className="lab-header">
        <a className="wordmark" href="/" aria-label="TracePilot incident lab home">
          <span className="mark">TP</span>
          <span>TracePilot / incident lab</span>
        </a>
        <div className="connection" data-state={status}>
          <span /> {status === 'connected' ? 'SDK armed' : 'Starting SDK'}
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">Controlled environment · release 2.4.1</p>
          <h1>
            Break the checkout.
            <br />
            Keep the evidence.
          </h1>
        </div>
        <div className="intro-note">
          <span className="signal-line" />
          <p>
            Every control below creates a real browser signal. Run several in sequence to produce
            the breadcrumbs an investigator would see around an incident.
          </p>
          <button className="flush-button" onClick={flush}>
            Flush event buffer
          </button>
        </div>
      </section>

      <section className="scenario-grid" aria-label="Failure scenarios">
        {scenarios.map((scenario) => (
          <button className="scenario" key={scenario.id} onClick={() => void runScenario(scenario)}>
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

      <aside className="activity" aria-live="polite">
        <div>
          <p className="eyebrow">Local activity</p>
          <h2>Flight recorder</h2>
        </div>
        <ol>
          {activity.length === 0 ? (
            <li className="empty">No scenarios triggered in this page session.</li>
          ) : (
            activity.map((item, index) => (
              <li key={`${item.time}-${index}`}>
                <time>{timeLabel(item.time)}</time>
                <span>{item.label}</span>
              </li>
            ))
          )}
        </ol>
      </aside>
    </main>
  );
}

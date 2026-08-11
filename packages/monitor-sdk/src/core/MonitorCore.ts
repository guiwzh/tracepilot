import { MAX_BREADCRUMBS, type Breadcrumb, type MonitorEvent } from '@trace-pilot/shared';
import type {
  CapturePayload,
  MonitorClient,
  MonitorOptions,
  MonitorPlugin,
  MonitorUser,
} from '../types';
import { Transport } from '../transport/Transport';
import {
  breadcrumbId,
  createId,
  errorPayload,
  getDeviceContext,
  getPageContext,
} from './helpers';

export class MonitorCore implements MonitorClient {
  readonly transport: Transport;
  readonly options: Required<
    Pick<MonitorOptions, 'sampleRate' | 'batchSize' | 'flushInterval' | 'maxRetries' | 'dedupeWindow'>
  > &
    MonitorOptions;
  private readonly plugins: MonitorPlugin[] = [];
  private readonly breadcrumbs: Breadcrumb[] = [];
  private readonly recentErrors = new Map<string, number>();
  private started = false;
  private destroyed = false;
  private user?: MonitorUser;
  private protecting = false;

  constructor(options: MonitorOptions) {
    this.options = {
      ...options,
      sampleRate: Math.max(0, Math.min(1, options.sampleRate ?? 1)),
      batchSize: options.batchSize ?? 10,
      flushInterval: options.flushInterval ?? 5_000,
      maxRetries: options.maxRetries ?? 2,
      dedupeWindow: options.dedupeWindow ?? 5_000,
    };
    this.user = options.user;
    this.transport = new Transport({
      endpoint: options.dsn,
      dsnKey: options.dsnKey ?? options.projectId,
      batchSize: this.options.batchSize,
      flushInterval: this.options.flushInterval,
      maxRetries: this.options.maxRetries,
    });
  }

  use(plugin: MonitorPlugin): this {
    if (this.plugins.some((candidate) => candidate.name === plugin.name)) return this;
    this.plugins.push(plugin);
    if (this.started) this.protect(() => plugin.setup(this));
    return this;
  }

  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    for (const plugin of this.plugins) this.protect(() => plugin.setup(this));
  }

  isStarted(): boolean {
    return this.started;
  }

  setUser(user?: MonitorUser): void {
    this.user = user;
  }

  addBreadcrumb(
    breadcrumb: Omit<Breadcrumb, 'id' | 'timestamp'> & Partial<Pick<Breadcrumb, 'timestamp'>>,
  ): void {
    if (this.destroyed) return;
    this.breadcrumbs.push(
      breadcrumbId({ ...breadcrumb, timestamp: breadcrumb.timestamp ?? Date.now() }),
    );
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) this.breadcrumbs.shift();
  }

  getBreadcrumbs(): Breadcrumb[] {
    return this.breadcrumbs.map((item) => ({ ...item }));
  }

  captureException(error: unknown, context: CapturePayload = {}): string | null {
    return this.captureEvent('error', { ...errorPayload(error), ...context, level: 'error' });
  }

  captureMessage(message: string, level: 'error' | 'warning' | 'info' = 'info'): string | null {
    return this.captureEvent('error', { name: 'Message', message, level });
  }

  captureEvent(eventType: MonitorEvent['eventType'], payload: CapturePayload): string | null {
    if (!this.started || this.destroyed || this.protecting) return null;
    if (Math.random() > this.options.sampleRate) return null;
    if (eventType === 'error' && this.isDuplicate(payload)) return null;

    const event: MonitorEvent = {
      eventId: createId(),
      eventType,
      timestamp: Date.now(),
      projectId: this.options.projectId,
      release: this.options.release,
      environment: this.options.environment,
      page: getPageContext(),
      user: this.user,
      device: getDeviceContext(),
      payload,
      breadcrumbs: this.getBreadcrumbs(),
    };

    try {
      const processed = this.options.beforeSend ? this.options.beforeSend(event) : event;
      if (!processed) return null;
      this.transport.enqueue(processed);
      return processed.eventId;
    } catch {
      return null;
    }
  }

  private isDuplicate(payload: CapturePayload): boolean {
    const frame = (String(payload.stack ?? '').split('\n')[1] ?? '').replace(
      /:\d+:\d+(?=\)?$)/,
      ':line:column',
    );
    const signature = `${String(payload.name ?? '')}|${String(payload.message ?? '')}|${frame}`;
    const now = Date.now();
    const last = this.recentErrors.get(signature);
    this.recentErrors.set(signature, now);
    for (const [key, timestamp] of this.recentErrors) {
      if (now - timestamp > this.options.dedupeWindow * 2) this.recentErrors.delete(key);
    }
    return last !== undefined && now - last < this.options.dedupeWindow;
  }

  protect(action: () => void): void {
    if (this.protecting) return;
    this.protecting = true;
    try {
      action();
    } catch {
      // Monitoring must never break the host page or report its own failure recursively.
    } finally {
      this.protecting = false;
    }
  }

  async flush(): Promise<void> {
    await this.transport.flush();
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const plugin of [...this.plugins].reverse()) this.protect(() => plugin.teardown());
    this.destroyed = true;
    this.started = false;
    this.breadcrumbs.length = 0;
    this.recentErrors.clear();
  }
}

import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';
import type { MonitorCore } from './core/MonitorCore';

export interface MonitorUser {
  id?: string;
  anonymousId?: string;
}

export interface MonitorOptions {
  /** Full envelope endpoint, for example http://localhost:4318/api/v1/envelopes. */
  dsn: string;
  /** Public ingest key. Defaults to projectId for simple self-hosted setups. */
  dsnKey?: string;
  projectId: string;
  release: string;
  environment: 'development' | 'test' | 'production';
  sampleRate?: number;
  batchSize?: number;
  flushInterval?: number;
  maxRetries?: number;
  dedupeWindow?: number;
  user?: MonitorUser;
  beforeSend?: (event: MonitorEvent) => MonitorEvent | null;
}

export interface MonitorPlugin {
  readonly name: string;
  setup(core: MonitorCore): void;
  teardown(): void;
}

export interface CapturePayload {
  [key: string]: unknown;
}

export interface MonitorClient {
  start(): void;
  setUser(user?: MonitorUser): void;
  captureException(error: unknown, context?: CapturePayload): string | null;
  captureMessage(message: string, level?: 'error' | 'warning' | 'info'): string | null;
  captureEvent(eventType: MonitorEvent['eventType'], payload: CapturePayload): string | null;
  addBreadcrumb(
    breadcrumb: Omit<Breadcrumb, 'id' | 'timestamp'> & Partial<Pick<Breadcrumb, 'timestamp'>>,
  ): void;
  flush(): Promise<void>;
  destroy(): void;
}

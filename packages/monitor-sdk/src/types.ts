import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';
import type { MonitorCore } from './core/MonitorCore';

/** SDK 面向业务应用的公开类型；这些选项最终由 MonitorCore 统一规范化。 */
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
  /** 0 到 1；在浏览器端随机丢弃部分事件，1 表示全部采集。 */
  sampleRate?: number;
  /** 队列达到该数量时立即发送。 */
  batchSize?: number;
  /** 队列未满时的定时发送间隔，单位毫秒。 */
  flushInterval?: number;
  /** 网络失败后的最大重试次数。 */
  maxRetries?: number;
  /** 待发送队列可保留的事件上限；服务端不可达时超出部分会被丢弃以保护宿主页面内存。 */
  maxQueueSize?: number;
  /** 同类错误的短窗口去重时间，单位毫秒。 */
  dedupeWindow?: number;
  user?: MonitorUser;
  /** 最后的业务侧隐私闸门；返回 null 可以取消本次事件。 */
  beforeSend?: (event: MonitorEvent) => MonitorEvent | null;
}

// 插件只关心 setup/teardown 生命周期，核心无需知道每种浏览器信号的实现细节。
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

import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';
import type { MonitorCore } from './core/MonitorCore';

// SDK 面向业务应用的公开类型；这些选项最终由 MonitorCore 统一规范化。

/** 当前用户。id 是业务账号 id；未登录时可以只给 anonymousId。服务端据此统计受影响用户数。 */
export interface MonitorUser {
  id?: string;
  anonymousId?: string;
}

export interface MonitorOptions {
  /** 上报地址（完整的接入接口 URL），例如 http://localhost:4318/api/v1/envelopes。 */
  dsn: string;
  /** 公开的接入键，服务端据此确认事件属于哪个项目。省略时使用 projectId，方便自部署的简单场景。 */
  dsnKey?: string;
  projectId: string;
  /** 当前构建的版本号，必须与上传 Source Map 时填写的版本一致，服务端才能还原堆栈。 */
  release: string;
  environment: 'development' | 'test' | 'production';
  /** 0 到 1；按会话采样的比例，1 表示全部采集。同一标签页会话内的决定保持一致。 */
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
  /**
   * 页面退出时浏览器只允许约 64 KiB 的 beacon 在途数据，发不完的事件默认写入 localStorage，
   * 下次加载时补发（服务端按 eventId 去重）。设为 false 可关闭。
   */
  persistence?: boolean;
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

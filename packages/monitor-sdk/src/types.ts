import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';

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
  /** 队列未满时的定时发送间隔，单位毫秒；连续发送失败时，自动发送的间隔在此基础上指数退避。 */
  flushInterval?: number;
  /** 一批发送失败后在同一轮里快速重试的次数（间隔 100 ms、200 ms……）。 */
  maxRetries?: number;
  /** 待发送队列可保留的事件上限；服务端不可达时超出部分会被丢弃以保护宿主页面内存。 */
  maxQueueSize?: number;
  /**
   * 同类信号的短窗口去重时间，单位毫秒：同一个错误、同一个资源、同一个接口的同一种失败在窗口内只报第一次。
   * 窗口从上一次上报算起，一直在发生的问题每个窗口至少报一次。
   */
  dedupeWindow?: number;
  /**
   * 页面退出时浏览器只允许约 64 KiB 的 beacon 在途数据，发不完的事件默认写入 localStorage，
   * 下次加载时补发（服务端按 eventId 去重）。设为 false 可关闭。
   */
  persistence?: boolean;
  /**
   * 额外忽略的错误：字符串按「消息包含」匹配，正则按消息测试。
   * 内置规则始终生效：跨域脚本的 "Script error."、ResizeObserver 循环告警、浏览器扩展里的报错。
   */
  ignoreErrors?: Array<string | RegExp>;
  user?: MonitorUser;
  /**
   * 最后的业务侧隐私闸门；返回 null 可以取消本次事件。
   * 收到的事件已经过 SDK 的默认脱敏：URL 去掉了查询参数和片段，token、password 等字段已遮蔽。
   */
  beforeSend?: (event: MonitorEvent) => MonitorEvent | null;
}

/** MonitorCore 规范化之后的配置：数字项都已夹进安全范围。 */
export type ResolvedMonitorOptions = MonitorOptions &
  Required<
    Pick<
      MonitorOptions,
      'sampleRate' | 'batchSize' | 'flushInterval' | 'maxRetries' | 'dedupeWindow' | 'maxQueueSize'
    >
  >;

export interface CapturePayload {
  [key: string]: unknown;
}

/** addBreadcrumb 的入参：id 由 SDK 生成，时间缺省为当前时刻。 */
export type BreadcrumbInput = Omit<Breadcrumb, 'id' | 'timestamp'> &
  Partial<Pick<Breadcrumb, 'timestamp'>>;

/**
 * 插件能看到的全部能力：采集入口和只读配置。
 * 插件拿不到传输层、生命周期闸门这些内部实现，核心内部怎么改都不会破坏插件。
 */
export interface PluginContext {
  readonly options: Readonly<ResolvedMonitorOptions>;
  captureEvent(eventType: MonitorEvent['eventType'], payload: CapturePayload): string | null;
  addBreadcrumb(breadcrumb: BreadcrumbInput): void;
}

// 插件只关心 setup/teardown 生命周期，核心无需知道每种浏览器信号的实现细节。
export interface MonitorPlugin {
  readonly name: string;
  setup(context: PluginContext): void;
  /** 在这里提交最后的样本是安全的：核心先按注册的逆序 teardown 全部插件，最后才销毁传输层。 */
  teardown(): void;
  /**
   * 页面进入后台或即将卸载时调用，早于传输层的退出发送。
   * 需要在离开页面前提交数据的插件实现它，而不是自己监听 pagehide：
   * 自己注册的监听器可能排在传输层之后执行，提交的数据就赶不上这次退出发送。
   */
  onPageHidden?(): void;
}

/** 投递状况，用来判断事件是否真的送到了服务端。 */
export interface DeliveryStats {
  /** 还在队列里等待发送的事件数。 */
  pending: number;
  /** 服务端已确认接收（2xx）的事件数。 */
  delivered: number;
  dropped: {
    /** 队列已满时到达的新事件。 */
    queueFull: number;
    /** 裁剪后仍超过单事件上限的事件。 */
    oversize: number;
    /** 服务端明确拒收（408、429 以外的 4xx）的批次，重试也不会成功，直接丢弃以免堵住队列。 */
    rejected: number;
    /** 服务端持续不可达、失败批次放回队列后超出上限而被裁掉的事件。 */
    overflow: number;
  };
  /** 最近一次发送失败；status 为 null 表示请求没有拿到响应（离线、连接被拒、跨域失败等）。 */
  lastFailure: { at: number; status: number | null } | null;
  /** 连续失败后，下一次自动发送不早于这个时间（毫秒时间戳）；没有在退避时为 null。 */
  nextAttemptAt: number | null;
}

/** createMonitor 返回的公开接口。 */
export interface MonitorClient {
  /** 注册插件；start 之后注册的插件会立即安装。同名插件只注册一次。 */
  use(plugin: MonitorPlugin): MonitorClient;
  start(): void;
  setUser(user?: MonitorUser): void;
  captureException(error: unknown, context?: CapturePayload): string | null;
  captureMessage(message: string, level?: 'error' | 'warning' | 'info'): string | null;
  captureEvent(eventType: MonitorEvent['eventType'], payload: CapturePayload): string | null;
  addBreadcrumb(breadcrumb: BreadcrumbInput): void;
  /**
   * 立即尝试发送队列里的全部事件。服务端不可达时也会正常返回（事件留在队列里等下次），
   * 所以要看返回的投递状况，而不是把 resolve 当成「已送达」。
   */
  flush(): Promise<DeliveryStats>;
  stats(): DeliveryStats;
  destroy(): void;
}

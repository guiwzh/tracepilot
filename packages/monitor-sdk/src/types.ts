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
  /**
   * 0 到 1；按会话采样的比例，1 表示全部采集。同一标签页会话内的决定保持一致。
   * 它决定整个会话采不采，错误也包括在内。错误是排障的依据，只发生一次的也要看到，
   * 一般保持 1；想减少数据量时调低 performanceSampleRate。
   */
  sampleRate?: number;
  /**
   * 0 到 1；被采样的会话里，上报性能样本（Web Vitals）的会话比例，默认 1。
   * 只作用于性能样本：它们量大、按分位数统计，抽样不影响结论；错误、失败请求、资源失败不受影响。
   */
  performanceSampleRate?: number;
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
   * 额外忽略的错误：字符串按「消息包含」匹配，正则按消息测试。
   * 内置规则始终生效：跨域脚本的 "Script error."、ResizeObserver 循环告警、浏览器扩展里的报错。
   */
  ignoreErrors?: Array<string | RegExp>;
  /**
   * 哪些 HTTP 状态码算请求失败。失败的请求成为事件、进而聚合为 Issue，其余只记面包屑。
   * 数字表示单个状态码，[起, 止] 表示闭区间。默认 [[500, 599]]：只有服务端错误算失败——
   * 4xx 常是预期内的（401 登录过期、404 查无此项、422 表单校验），需要时可以加进来。
   * 拿不到响应的网络错误始终算失败；被取消的请求和 no-cors 的 opaque 响应始终不算。
   */
  failedRequestStatusCodes?: Array<number | [number, number]>;
  /**
   * 业务错误判定：接口返回 2xx，但响应体里的业务码表示失败（常见的 { code, message } 约定）。
   * 返回一个对象表示这次请求失败，其中的 code / message 随事件上报；返回 null 或 undefined 表示成功。
   * 只有配置了它才会读取响应体，而且只读 JSON：fetch 读 response.clone()，不影响业务代码读取；
   * XHR 读 response / responseText。响应体只在页面内存里解析，除了这里返回的内容不会上报。
   */
  detectBusinessError?: (response: ApiResponseInfo) => BusinessError | null | undefined;
  /**
   * 给哪些请求加 W3C traceparent 头，把前端事件和后端链路（OpenTelemetry、SkyWalking 等）连起来。
   * 默认只有同源请求；[] 表示不加。配置之后以配置为准：字符串是 URL 前缀（'https://api.example.com'、
   * '/api/'），正则测试完整的 URL（同源请求还测试路径）。
   * 跨域的后端必须在 Access-Control-Allow-Headers 里放行 traceparent，否则浏览器的预检会让请求失败。
   * 请求已经带了 traceparent（应用自己或另一个链路 SDK 加的）时不覆盖。
   */
  tracePropagationTargets?: Array<string | RegExp>;
  /**
   * 记成面包屑的控制台级别，默认 ['warn', 'error']；false 表示不包装 console。
   * 只记面包屑、不单独成为事件：它们是之后错误的上下文。
   */
  consoleBreadcrumbs?: ConsoleLevel[] | false;
  /** 白屏检测的配置；false 表示关闭。默认开启，规则见 WhiteScreenPlugin。 */
  whiteScreen?: WhiteScreenOptions | false;
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
      | 'sampleRate'
      | 'performanceSampleRate'
      | 'batchSize'
      | 'flushInterval'
      | 'maxRetries'
      | 'dedupeWindow'
      | 'maxQueueSize'
      | 'failedRequestStatusCodes'
    >
  >;

export type ConsoleLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

export interface WhiteScreenOptions {
  /**
   * 「空容器」：采样点上最上层的元素是它们，这个点算空。默认 html、body、#root、#app、#__next、#__nuxt，
   * 应用挂载在别的节点上时加进来。
   */
  containers?: string[];
  /** 骨架屏、加载占位的选择器：采样点落在它们里面也算空，例如 ['.skeleton', '[aria-busy="true"]']。 */
  skeletons?: string[];
  /** 两次检测的间隔（毫秒），默认 1000。 */
  interval?: number;
  /** 连续几次都是空白才上报，默认 5，即加载或切换路由后空白约 5 秒。 */
  checks?: number;
}

/** 业务错误判定收到的请求信息；body 是解析后的 JSON 响应体。 */
export interface ApiResponseInfo {
  method: string;
  url: string;
  status: number;
  body: unknown;
}

/** detectBusinessError 判定为失败时返回的信息。 */
export interface BusinessError {
  code?: string | number;
  message?: string;
}

export interface CapturePayload {
  [key: string]: unknown;
}

/** captureEvent、captureException 的可选项。 */
export interface CaptureOptions {
  /**
   * 信号发生时所在的页面，缺省时取采集这一刻的页面。信号先发生、稍后才上报时要传入它：
   * 页面隐藏时才提交的 LCP、CLS、INP，单页应用里那时可能已经换了路由。
   */
  page?: MonitorEvent['page'];
  /**
   * 自定义聚合键，服务端按它归入 Issue，而不是按默认指纹。'{{ default }}' 代表默认指纹：
   * ['{{ default }}', tenantId] 在默认结果上再按租户细分；['checkout-timeout'] 把不同位置抛出的同一类错误并成一个。
   * 最多 10 项，每项 1～200 个字符。
   */
  fingerprint?: string[];
  /**
   * 事件所属的 trace（W3C trace id，32 位小写十六进制），不合法时忽略。缺省时取当前页面浏览的 trace，
   * 前提是这次浏览里已经有请求把它带给了后端。失败请求的事件传入请求自己带的那个：请求可能是上一个页面发出的。
   */
  traceId?: string;
}

/** 一个带 traceparent 的请求：trace id、这次请求的 span id 和要带的头。 */
export interface RequestTrace {
  traceId: string;
  spanId: string;
  traceparent: string;
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
  captureEvent(
    eventType: MonitorEvent['eventType'],
    payload: CapturePayload,
    options?: CaptureOptions,
  ): string | null;
  addBreadcrumb(breadcrumb: BreadcrumbInput): void;
  /**
   * 给一个要带 traceparent 的请求开一个 span（当前页面浏览的 trace、新的 span id）。调用即表示这个 trace
   * 带给了后端，之后的事件会带上它的 trace id，所以只在真的要加这个头时调用；
   * 哪些请求要加由调用方按 tracePropagationTargets 判断（core/trace.ts 的 shouldPropagate）。
   */
  startRequestSpan(): RequestTrace;
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
  /** context 是附加到 payload 的字段；options.fingerprint 可以自定义聚合键。 */
  captureException(
    error: unknown,
    context?: CapturePayload,
    options?: CaptureOptions,
  ): string | null;
  captureMessage(message: string, level?: 'error' | 'warning' | 'info'): string | null;
  captureEvent(
    eventType: MonitorEvent['eventType'],
    payload: CapturePayload,
    options?: CaptureOptions,
  ): string | null;
  addBreadcrumb(breadcrumb: BreadcrumbInput): void;
  /**
   * 立即尝试发送队列里的全部事件。服务端不可达时也会正常返回（事件留在队列里等下次），
   * 所以要看返回的投递状况，而不是把 resolve 当成「已送达」。
   */
  flush(): Promise<DeliveryStats>;
  stats(): DeliveryStats;
  destroy(): void;
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /**
   * 后端链路系统里一个 trace 的地址模板，{traceId}、{spanId} 会被替换，
   * 例如 Jaeger 的 http://localhost:16686/trace/{traceId}。不配置时工作台只显示 trace id 供复制。
   */
  readonly VITE_TRACE_URL_TEMPLATE?: string;
}

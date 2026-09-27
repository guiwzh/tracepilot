import { MonitorCore } from './core/MonitorCore';
import { BehaviorPlugin } from './plugins/BehaviorPlugin';
import { ErrorPlugin } from './plugins/ErrorPlugin';
import { NetworkPlugin } from './plugins/NetworkPlugin';
import { PerformancePlugin } from './plugins/PerformancePlugin';
import { PromisePlugin } from './plugins/PromisePlugin';
import { ResourcePlugin } from './plugins/ResourcePlugin';
import type { MonitorClient, MonitorOptions } from './types';

/**
 * SDK 的工厂函数：核心加上全部默认插件。传输层由核心自己管理，插件的注册顺序不影响投递；
 * 之后再用 use() 追加的插件同样安全。
 */
export function createMonitor(options: MonitorOptions): MonitorClient {
  return new MonitorCore(options)
    .use(new ErrorPlugin())
    .use(new PromisePlugin())
    .use(new ResourcePlugin())
    .use(new NetworkPlugin())
    .use(new PerformancePlugin())
    .use(new BehaviorPlugin());
}

// 同时导出底层类，方便高级调用方按需组合插件（new MonitorCore(options).use(...)），也方便单元测试隔离各层。
export { MonitorCore } from './core/MonitorCore';
export { reactErrorHandler, type ReactErrorInfo } from './integrations/react';
export { BehaviorPlugin } from './plugins/BehaviorPlugin';
export { ErrorPlugin } from './plugins/ErrorPlugin';
export { NetworkPlugin } from './plugins/NetworkPlugin';
export { PerformancePlugin } from './plugins/PerformancePlugin';
export { PromisePlugin } from './plugins/PromisePlugin';
export { ResourcePlugin } from './plugins/ResourcePlugin';
export { Transport } from './transport/Transport';
export type * from './types';

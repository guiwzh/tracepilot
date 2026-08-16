import { MonitorCore } from './core/MonitorCore';
import { BehaviorPlugin } from './plugins/BehaviorPlugin';
import { ErrorPlugin } from './plugins/ErrorPlugin';
import { NetworkPlugin } from './plugins/NetworkPlugin';
import { PerformancePlugin } from './plugins/PerformancePlugin';
import { PromisePlugin } from './plugins/PromisePlugin';
import { ResourcePlugin } from './plugins/ResourcePlugin';
import { TransportPlugin } from './plugins/TransportPlugin';
import type { MonitorOptions } from './types';

/**
 * SDK 的工厂函数。默认插件按“信号采集在前、传输启动在后”的顺序注册，
 * 这样销毁时按相同顺序 teardown，最后由 TransportPlugin 冲刷剩余队列。
 */
export function createMonitor(options: MonitorOptions): MonitorCore {
  return new MonitorCore(options)
    .use(new ErrorPlugin())
    .use(new PromisePlugin())
    .use(new ResourcePlugin())
    .use(new NetworkPlugin())
    .use(new PerformancePlugin())
    .use(new BehaviorPlugin())
    .use(new TransportPlugin());
}

// 同时导出底层类，方便高级调用方按需组合插件，也方便单元测试隔离各层。
export { MonitorCore } from './core/MonitorCore';
export { BehaviorPlugin } from './plugins/BehaviorPlugin';
export { ErrorPlugin } from './plugins/ErrorPlugin';
export { NetworkPlugin } from './plugins/NetworkPlugin';
export { PerformancePlugin } from './plugins/PerformancePlugin';
export { PromisePlugin } from './plugins/PromisePlugin';
export { ResourcePlugin } from './plugins/ResourcePlugin';
export { TransportPlugin } from './plugins/TransportPlugin';
export { Transport } from './transport/Transport';
export type * from './types';

import { MonitorCore } from './core/MonitorCore';
import { BehaviorPlugin } from './plugins/BehaviorPlugin';
import { ErrorPlugin } from './plugins/ErrorPlugin';
import { NetworkPlugin } from './plugins/NetworkPlugin';
import { PerformancePlugin } from './plugins/PerformancePlugin';
import { PromisePlugin } from './plugins/PromisePlugin';
import { ResourcePlugin } from './plugins/ResourcePlugin';
import { TransportPlugin } from './plugins/TransportPlugin';
import type { MonitorOptions } from './types';

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

import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

/** 将 Transport 适配为统一插件生命周期，保证传输层最后启动、最后销毁。 */
export class TransportPlugin implements MonitorPlugin {
  readonly name = 'TransportPlugin';
  private core?: MonitorCore;

  setup(core: MonitorCore): void {
    if (this.core) return;
    this.core = core;
    core.transport.start();
  }

  teardown(): void {
    this.core?.transport.destroy();
    this.core = undefined;
  }
}

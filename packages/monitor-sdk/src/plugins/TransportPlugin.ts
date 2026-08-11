import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

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

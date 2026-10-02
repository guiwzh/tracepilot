import { afterEach, describe, expect, it } from 'vitest';
import type { CapturePayload, PluginContext, ResolvedMonitorOptions } from '../../src/types';
import { ResourcePlugin } from '../../src/plugins/ResourcePlugin';
import { TraceContext } from '../../src/core/trace';

let plugin: ResourcePlugin | undefined;

afterEach(() => {
  plugin?.teardown();
  plugin = undefined;
  document.body.innerHTML = '';
});

describe('ResourcePlugin', () => {
  it('captures failed loads from the capture phase with the resource URL', () => {
    const events: Array<{ type: string; payload: CapturePayload }> = [];
    const context: PluginContext = {
      options: {} as ResolvedMonitorOptions,
      captureEvent: (type, payload) => {
        events.push({ type, payload });
        return 'event-id';
      },
      addBreadcrumb: () => {},
      startRequestSpan: () => new TraceContext().startRequestSpan(),
    };
    plugin = new ResourcePlugin();
    plugin.setup(context);

    const image = document.createElement('img');
    image.src = 'https://shop.test/missing-badge.png';
    document.body.append(image);
    // 资源的 error 事件不冒泡，只能在 window 的捕获阶段看到。
    image.dispatchEvent(new Event('error', { bubbles: false }));

    expect(events).toEqual([
      {
        type: 'resource',
        payload: expect.objectContaining({
          url: 'https://shop.test/missing-badge.png',
          tagName: 'img',
          message: 'Failed to load https://shop.test/missing-badge.png',
        }),
      },
    ]);
  });
});

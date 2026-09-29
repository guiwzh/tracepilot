import { describe, expect, it, vi } from 'vitest';
import { reactErrorHandler } from '../../src/integrations/react';

describe('reactErrorHandler', () => {
  it('reports errors React handed to the root callbacks, with the component stack', () => {
    const captureException = vi.fn(() => 'event-id');
    const callback = vi.fn();
    const handler = reactErrorHandler({ captureException }, callback);
    const error = new TypeError("Cannot read properties of undefined (reading 'items')");
    const errorInfo = { componentStack: '\n    at CartSummary\n    at ErrorBoundary\n    at App' };

    handler(error, errorInfo);

    expect(captureException).toHaveBeenCalledWith(error, {
      mechanism: 'react',
      componentStack: errorInfo.componentStack,
    });
    expect(callback).toHaveBeenCalledWith(error, errorInfo);
  });

  it('keeps React’s default console output when no callback is given', () => {
    // 传入 onCaughtError 会替换 React 默认的控制台输出；适配器默认补上，开发时的报错不会凭空消失。
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('render failed');
    reactErrorHandler({ captureException: () => null })(error, {});
    expect(log).toHaveBeenCalledWith(error);
  });
});

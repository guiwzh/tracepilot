import type { MonitorClient } from '../types';

/** React 传给根节点错误回调的附加信息（只取用到的字段，不依赖 react 的类型）。 */
export interface ReactErrorInfo {
  componentStack?: string | null;
}

/** 组件栈可能很长（深层组件树），只保留靠近出错组件的一段。 */
const MAX_COMPONENT_STACK = 2_000;

/**
 * React 19 根节点错误回调的适配器：
 *
 * ```ts
 * createRoot(container, {
 *   onCaughtError: reactErrorHandler(monitor),
 *   onUncaughtError: reactErrorHandler(monitor),
 * });
 * ```
 *
 * 被错误边界捕获的渲染错误不会触发 window 的 error 事件，React 只把它交给 onCaughtError
 * （默认打印到控制台），不接这个回调 SDK 就完全看不到它们——而生产环境的应用大多有路由级错误边界。
 * 顺带上报组件栈，排查时能看到出错的是哪个组件。
 *
 * 传入自己的回调会替换 React 默认的处理，所以默认的 callback 同样打印到控制台，
 * 接上这个适配器不会让开发时的报错凭空消失。
 */
export function reactErrorHandler(
  client: Pick<MonitorClient, 'captureException'>,
  callback: (error: unknown, errorInfo: ReactErrorInfo) => void = (error) => console.error(error),
): (error: unknown, errorInfo: ReactErrorInfo) => void {
  return (error, errorInfo) => {
    client.captureException(error, {
      mechanism: 'react',
      ...(errorInfo.componentStack
        ? { componentStack: errorInfo.componentStack.slice(0, MAX_COMPONENT_STACK) }
        : {}),
    });
    callback(error, errorInfo);
  };
}

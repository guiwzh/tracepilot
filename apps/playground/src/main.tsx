import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { reactErrorHandler } from '@trace-pilot/monitor-sdk';
import { App } from './App';
import { monitor } from './lab';
import './styles.css';

// Playground 是独立 Vite 应用，只复用真实 SDK 包，不依赖 Dashboard 内部代码。
// 被错误边界捕获的渲染错误不会触发 window.error，React 只把它交给 onCaughtError：
// 不接上这两个回调，SDK 就看不到组件树里发生的渲染错误。
createRoot(document.getElementById('root')!, {
  onCaughtError: reactErrorHandler(monitor),
  onUncaughtError: reactErrorHandler(monitor),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// React Query 负责服务端状态缓存；组件只声明 queryKey/queryFn，不手写 loading 数据仓库。
const queryClient = new QueryClient({
  defaultOptions: {
    // 15 秒内数据视为新鲜；查询最多重试一次，写操作不自动重试以免重复副作用。
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

createRoot(document.getElementById('root')!).render(
  // StrictMode 会在开发环境额外检查副作用，因此 useEffect 必须提供对称 cleanup。
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

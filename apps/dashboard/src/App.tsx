import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProjectsPage } from './pages/ProjectsPage';

// 路由级 lazy import 会把较大的调查页面拆成独立 chunk，首页无需一次下载全部代码。
const IssuesPage = lazy(() =>
  import('./pages/IssuesPage').then((module) => ({ default: module.IssuesPage })),
);
const IssueDetailPage = lazy(() =>
  import('./pages/IssueDetailPage').then((module) => ({ default: module.IssueDetailPage })),
);
const PerformancePage = lazy(() =>
  import('./pages/PerformancePage').then((module) => ({ default: module.PerformancePage })),
);
const ReleasesPage = lazy(() =>
  import('./pages/ReleasesPage').then((module) => ({ default: module.ReleasesPage })),
);

export function App() {
  return (
    <Suspense fallback={<div className="route-loader">Opening evidence…</div>}>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        {/* 无 path 的父路由只提供布局；子页面渲染在 AppShell 的 Outlet 中。 */}
        <Route element={<AppShell />}>
          <Route path="/projects/:projectId/issues" element={<IssuesPage />} />
          <Route path="/projects/:projectId/performance" element={<PerformancePage />} />
          <Route path="/projects/:projectId/releases" element={<ReleasesPage />} />
          <Route path="/projects/:projectId/issues/:issueId" element={<IssueDetailPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
